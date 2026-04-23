import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { eq } from "drizzle-orm";
import { requireDatabaseUrl } from "./test-helpers.js";
import {
  transitionOrderStatus,
  findOrderById,
  findOrderStatusHistory,
  STATUS_TRANSITIONS,
  PAYMENT_STATUS_TRANSITIONS,
  FULFILLMENT_STATUS_TRANSITIONS,
  SHIPPING_STATUS_TRANSITIONS,
  type OrderStatusType,
} from "./db/queries/order-state-machine.js";

const DATABASE_URL = requireDatabaseUrl();

/** Helper: create a fresh order at a given state combination */
async function createOrderAtState(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  opts: {
    suffix: string;
    status?: string;
    paymentStatus?: string;
    fulfillmentStatus?: string;
    shippingStatus?: string;
  },
) {
  const ts = Date.now();
  const [o] = await db
    .insert(order)
    .values({
      orderNumber: `KNX-T217-${opts.suffix}-${ts}`,
      email: `t217-${opts.suffix}-${ts}@test.kanix.dev`,
      status: opts.status ?? "pending_payment",
      paymentStatus: opts.paymentStatus ?? "unpaid",
      fulfillmentStatus: opts.fulfillmentStatus ?? "unfulfilled",
      shippingStatus: opts.shippingStatus ?? "not_shipped",
      subtotalMinor: 3000,
      taxMinor: 0,
      shippingMinor: 599,
      totalMinor: 3599,
      placedAt: new Date(),
    })
    .returning();
  return o;
}

/** Helper: clean up an order and its history */
async function cleanupOrder(
  db: ReturnType<typeof createDatabaseConnection>["db"],
  orderId: string,
) {
  await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId));
  await db.delete(orderLine).where(eq(orderLine.orderId, orderId));
  await db.delete(order).where(eq(order.id, orderId));
}

describe("order state machine integration (T050)", () => {
  let dbConn: DatabaseConnection;
  const orderIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      for (const id of orderIds) {
        await cleanupOrder(db, id);
      }
      await dbConn.close();
    }
  });

  // -------------------------------------------------------------------------
  // Full order lifecycle — happy path
  // -------------------------------------------------------------------------

  it("full lifecycle: pending_payment → confirmed → completed → closed with all sub-statuses", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "lifecycle" });
    orderIds.push(o.id);

    // Verify initial state
    const initial = await findOrderById(db, o.id);
    expect(initial).not.toBeNull();
    expect(initial!.status).toBe("pending_payment");
    expect(initial!.paymentStatus).toBe("unpaid");
    expect(initial!.fulfillmentStatus).toBe("unfulfilled");
    expect(initial!.shippingStatus).toBe("not_shipped");

    // Payment: unpaid → processing → paid
    let result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "processing",
      reason: "Payment intent created",
    });
    expect(result.success).toBe(true);
    expect(result.orderId).toBe(o.id);
    expect(result.statusType).toBe("payment_status");
    expect(result.oldValue).toBe("unpaid");
    expect(result.newValue).toBe("processing");

    result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "paid",
      reason: "Stripe payment_intent.succeeded",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("processing");
    expect(result.newValue).toBe("paid");

    // Order: pending_payment → confirmed
    result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "status",
      newValue: "confirmed",
      reason: "Payment confirmed",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("pending_payment");
    expect(result.newValue).toBe("confirmed");

    // Fulfillment: unfulfilled → queued → picking → packing → ready_to_ship → fulfilled
    for (const step of ["queued", "picking", "packing", "ready_to_ship", "fulfilled"] as const) {
      result = await transitionOrderStatus(db, {
        orderId: o.id,
        statusType: "fulfillment_status",
        newValue: step,
      });
      expect(result.success).toBe(true);
      expect(result.newValue).toBe(step);
    }

    // Shipping: not_shipped → label_pending → label_purchased → shipped → in_transit → out_for_delivery → delivered
    for (const step of [
      "label_pending",
      "label_purchased",
      "shipped",
      "in_transit",
      "out_for_delivery",
      "delivered",
    ] as const) {
      result = await transitionOrderStatus(db, {
        orderId: o.id,
        statusType: "shipping_status",
        newValue: step,
      });
      expect(result.success).toBe(true);
      expect(result.newValue).toBe(step);
    }

    // Order: confirmed → completed → closed
    result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "status",
      newValue: "completed",
      reason: "All lines fulfilled and delivered",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("confirmed");

    result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "status",
      newValue: "closed",
      reason: "Admin closed",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("completed");

    // Verify final state
    const finalOrder = await findOrderById(db, o.id);
    expect(finalOrder!.status).toBe("closed");
    expect(finalOrder!.paymentStatus).toBe("paid");
    expect(finalOrder!.fulfillmentStatus).toBe("fulfilled");
    expect(finalOrder!.shippingStatus).toBe("delivered");

    // Verify history entries with concrete shape
    const history = await findOrderStatusHistory(db, o.id);
    // 2 payment + 3 status + 5 fulfillment + 6 shipping = 16
    expect(history.length).toBe(16);

    // Each entry has required fields
    for (const h of history) {
      expect(typeof h.id).toBe("string");
      expect(h.id.length).toBeGreaterThan(0);
      expect(["status", "payment_status", "fulfillment_status", "shipping_status"]).toContain(
        h.statusType,
      );
      expect(typeof h.oldValue).toBe("string");
      expect(typeof h.newValue).toBe("string");
      expect(h.createdAt).toBeInstanceOf(Date);
    }

    // Verify specific entries exist with correct old/new
    const paymentProcessing = history.find(
      (h) => h.statusType === "payment_status" && h.newValue === "processing",
    );
    expect(paymentProcessing!.oldValue).toBe("unpaid");
    expect(paymentProcessing!.reason).toBe("Payment intent created");

    const statusConfirmed = history.find(
      (h) => h.statusType === "status" && h.newValue === "confirmed",
    );
    expect(statusConfirmed!.oldValue).toBe("pending_payment");
    expect(statusConfirmed!.reason).toBe("Payment confirmed");
  });

  // -------------------------------------------------------------------------
  // Cancellation path
  // -------------------------------------------------------------------------

  it("cancellation path: pending_payment → canceled", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "cancel-pp" });
    orderIds.push(o.id);

    const result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "status",
      newValue: "canceled",
      reason: "Customer requested cancellation",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("pending_payment");
    expect(result.newValue).toBe("canceled");

    const final = await findOrderById(db, o.id);
    expect(final!.status).toBe("canceled");

    const history = await findOrderStatusHistory(db, o.id);
    expect(history.length).toBe(1);
    expect(history[0].reason).toBe("Customer requested cancellation");
  });

  it("cancellation path: confirmed → canceled", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "cancel-conf", status: "confirmed" });
    orderIds.push(o.id);

    const result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "status",
      newValue: "canceled",
      reason: "Admin force-cancel",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("confirmed");
    expect(result.newValue).toBe("canceled");
  });

  it("cancellation of fulfillment and shipping sub-statuses", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "cancel-sub" });
    orderIds.push(o.id);

    // Move fulfillment to queued, then cancel
    await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "fulfillment_status",
      newValue: "queued",
    });
    const fResult = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "fulfillment_status",
      newValue: "canceled",
      reason: "Order canceled",
    });
    expect(fResult.success).toBe(true);
    expect(fResult.oldValue).toBe("queued");
    expect(fResult.newValue).toBe("canceled");

    // Cancel shipping
    const sResult = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "shipping_status",
      newValue: "canceled",
      reason: "Order canceled",
    });
    expect(sResult.success).toBe(true);
    expect(sResult.oldValue).toBe("not_shipped");
    expect(sResult.newValue).toBe("canceled");

    const final = await findOrderById(db, o.id);
    expect(final!.fulfillmentStatus).toBe("canceled");
    expect(final!.shippingStatus).toBe("canceled");
  });

  // -------------------------------------------------------------------------
  // Dispute path
  // -------------------------------------------------------------------------

  it("dispute path: paid → disputed → paid (dispute won)", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, {
      suffix: "dispute-won",
      status: "confirmed",
      paymentStatus: "paid",
    });
    orderIds.push(o.id);

    await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "disputed",
      reason: "charge.dispute.created",
    });

    const result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "paid",
      reason: "Dispute won",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("disputed");
    expect(result.newValue).toBe("paid");

    const final = await findOrderById(db, o.id);
    expect(final!.paymentStatus).toBe("paid");

    const history = await findOrderStatusHistory(db, o.id);
    expect(history.length).toBe(2);
    expect(
      history.some((h) => h.newValue === "disputed" && h.reason === "charge.dispute.created"),
    ).toBe(true);
    expect(history.some((h) => h.oldValue === "disputed" && h.newValue === "paid")).toBe(true);
  });

  it("dispute path: paid → disputed → refunded (dispute lost)", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, {
      suffix: "dispute-lost",
      status: "confirmed",
      paymentStatus: "paid",
    });
    orderIds.push(o.id);

    await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "disputed",
      reason: "charge.dispute.created",
    });

    const result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "refunded",
      reason: "Dispute lost — auto-refunded",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("disputed");
    expect(result.newValue).toBe("refunded");

    const final = await findOrderById(db, o.id);
    expect(final!.paymentStatus).toBe("refunded");
  });

  // -------------------------------------------------------------------------
  // Refund paths
  // -------------------------------------------------------------------------

  it("refund path: paid → partially_refunded → refunded", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, {
      suffix: "refund-partial",
      status: "confirmed",
      paymentStatus: "paid",
    });
    orderIds.push(o.id);

    let result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "partially_refunded",
      reason: "Partial refund issued",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("paid");
    expect(result.newValue).toBe("partially_refunded");

    result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "refunded",
      reason: "Remaining refund issued",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("partially_refunded");
    expect(result.newValue).toBe("refunded");

    const final = await findOrderById(db, o.id);
    expect(final!.paymentStatus).toBe("refunded");
  });

  it("refund path: paid → refunded (full refund)", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, {
      suffix: "refund-full",
      status: "confirmed",
      paymentStatus: "paid",
    });
    orderIds.push(o.id);

    const result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "refunded",
      reason: "Full refund",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("paid");
    expect(result.newValue).toBe("refunded");
  });

  // -------------------------------------------------------------------------
  // Payment failure path
  // -------------------------------------------------------------------------

  it("payment failure: processing → failed", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "pay-fail" });
    orderIds.push(o.id);

    await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "processing",
    });

    const result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "failed",
      reason: "Stripe payment_intent.payment_failed",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("processing");
    expect(result.newValue).toBe("failed");
  });

  // -------------------------------------------------------------------------
  // Fulfillment: partially_fulfilled path
  // -------------------------------------------------------------------------

  it("fulfillment: queued → partially_fulfilled → fulfilled", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "partial-fulfill" });
    orderIds.push(o.id);

    await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "fulfillment_status",
      newValue: "queued",
    });

    let result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "fulfillment_status",
      newValue: "partially_fulfilled",
      reason: "Split shipment — first box shipped",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("queued");
    expect(result.newValue).toBe("partially_fulfilled");

    result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "fulfillment_status",
      newValue: "fulfilled",
      reason: "All boxes shipped",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("partially_fulfilled");
    expect(result.newValue).toBe("fulfilled");
  });

  // -------------------------------------------------------------------------
  // Shipping: delivery_exception + returned paths
  // -------------------------------------------------------------------------

  it("shipping: delivery_exception → returned", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, {
      suffix: "ship-exception",
      shippingStatus: "in_transit",
    });
    orderIds.push(o.id);

    let result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "shipping_status",
      newValue: "delivery_exception",
      reason: "Carrier reported exception",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("in_transit");
    expect(result.newValue).toBe("delivery_exception");

    result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "shipping_status",
      newValue: "returned",
      reason: "Package returned to sender",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("delivery_exception");
    expect(result.newValue).toBe("returned");
  });

  it("shipping: delivered → returned", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, {
      suffix: "ship-return",
      shippingStatus: "delivered",
    });
    orderIds.push(o.id);

    const result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "shipping_status",
      newValue: "returned",
      reason: "Customer return",
    });
    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("delivered");
    expect(result.newValue).toBe("returned");
  });

  // -------------------------------------------------------------------------
  // Terminal states reject ALL further transitions
  // -------------------------------------------------------------------------

  describe("terminal order statuses reject all transitions", () => {
    for (const terminalStatus of ["canceled", "closed"] as const) {
      const allTargets = Object.keys(STATUS_TRANSITIONS).filter((s) => s !== terminalStatus);
      for (const target of allTargets) {
        it(`status ${terminalStatus} → ${target} is rejected`, async () => {
          const db = dbConn.db;
          const o = await createOrderAtState(db, {
            suffix: `term-s-${terminalStatus}-${target}`,
            status: terminalStatus,
          });
          orderIds.push(o.id);

          try {
            await transitionOrderStatus(db, {
              orderId: o.id,
              statusType: "status",
              newValue: target,
            });
            expect.unreachable("Should have thrown ERR_INVALID_TRANSITION");
          } catch (err: unknown) {
            const error = err as { code: string; statusType: string; from: string; to: string };
            expect(error.code).toBe("ERR_INVALID_TRANSITION");
            expect(error.statusType).toBe("status");
            expect(error.from).toBe(terminalStatus);
            expect(error.to).toBe(target);
          }
        });
      }
    }
  });

  describe("terminal payment statuses reject all transitions", () => {
    for (const terminalStatus of ["refunded", "failed"] as const) {
      const allTargets = Object.keys(PAYMENT_STATUS_TRANSITIONS).filter(
        (s) => s !== terminalStatus,
      );
      for (const target of allTargets) {
        it(`payment_status ${terminalStatus} → ${target} is rejected`, async () => {
          const db = dbConn.db;
          const o = await createOrderAtState(db, {
            suffix: `term-p-${terminalStatus}-${target}`,
            paymentStatus: terminalStatus,
          });
          orderIds.push(o.id);

          try {
            await transitionOrderStatus(db, {
              orderId: o.id,
              statusType: "payment_status",
              newValue: target,
            });
            expect.unreachable("Should have thrown ERR_INVALID_TRANSITION");
          } catch (err: unknown) {
            const error = err as { code: string; from: string; to: string };
            expect(error.code).toBe("ERR_INVALID_TRANSITION");
            expect(error.from).toBe(terminalStatus);
            expect(error.to).toBe(target);
          }
        });
      }
    }
  });

  describe("terminal fulfillment statuses reject all transitions", () => {
    for (const terminalStatus of ["fulfilled", "canceled"] as const) {
      const allTargets = Object.keys(FULFILLMENT_STATUS_TRANSITIONS).filter(
        (s) => s !== terminalStatus,
      );
      for (const target of allTargets) {
        it(`fulfillment_status ${terminalStatus} → ${target} is rejected`, async () => {
          const db = dbConn.db;
          const o = await createOrderAtState(db, {
            suffix: `term-f-${terminalStatus}-${target}`,
            fulfillmentStatus: terminalStatus,
          });
          orderIds.push(o.id);

          try {
            await transitionOrderStatus(db, {
              orderId: o.id,
              statusType: "fulfillment_status",
              newValue: target,
            });
            expect.unreachable("Should have thrown ERR_INVALID_TRANSITION");
          } catch (err: unknown) {
            const error = err as { code: string; from: string; to: string };
            expect(error.code).toBe("ERR_INVALID_TRANSITION");
            expect(error.from).toBe(terminalStatus);
            expect(error.to).toBe(target);
          }
        });
      }
    }
  });

  describe("terminal shipping statuses reject all transitions", () => {
    for (const terminalStatus of ["returned", "canceled"] as const) {
      const allTargets = Object.keys(SHIPPING_STATUS_TRANSITIONS).filter(
        (s) => s !== terminalStatus,
      );
      for (const target of allTargets) {
        it(`shipping_status ${terminalStatus} → ${target} is rejected`, async () => {
          const db = dbConn.db;
          const o = await createOrderAtState(db, {
            suffix: `term-sh-${terminalStatus}-${target}`,
            shippingStatus: terminalStatus,
          });
          orderIds.push(o.id);

          try {
            await transitionOrderStatus(db, {
              orderId: o.id,
              statusType: "shipping_status",
              newValue: target,
            });
            expect.unreachable("Should have thrown ERR_INVALID_TRANSITION");
          } catch (err: unknown) {
            const error = err as { code: string; from: string; to: string };
            expect(error.code).toBe("ERR_INVALID_TRANSITION");
            expect(error.from).toBe(terminalStatus);
            expect(error.to).toBe(target);
          }
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // Specific illegal transitions (non-terminal)
  // -------------------------------------------------------------------------

  it("rejects backward status transition: confirmed → pending_payment", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "bad-back", status: "confirmed" });
    orderIds.push(o.id);

    try {
      await transitionOrderStatus(db, {
        orderId: o.id,
        statusType: "status",
        newValue: "pending_payment",
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { code: string; from: string; to: string; message: string };
      expect(error.code).toBe("ERR_INVALID_TRANSITION");
      expect(error.from).toBe("confirmed");
      expect(error.to).toBe("pending_payment");
      expect(error.message).toContain("Invalid status transition");
    }
  });

  it("rejects skipping status steps: pending_payment → completed", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "bad-skip" });
    orderIds.push(o.id);

    try {
      await transitionOrderStatus(db, {
        orderId: o.id,
        statusType: "status",
        newValue: "completed",
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { code: string };
      expect(error.code).toBe("ERR_INVALID_TRANSITION");
    }
  });

  it("rejects invalid payment_status backward: paid → processing", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, {
      suffix: "bad-pay-back",
      paymentStatus: "paid",
    });
    orderIds.push(o.id);

    try {
      await transitionOrderStatus(db, {
        orderId: o.id,
        statusType: "payment_status",
        newValue: "processing",
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { code: string };
      expect(error.code).toBe("ERR_INVALID_TRANSITION");
    }
  });

  it("rejects skipping fulfillment steps: unfulfilled → fulfilled", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "bad-ff-skip" });
    orderIds.push(o.id);

    try {
      await transitionOrderStatus(db, {
        orderId: o.id,
        statusType: "fulfillment_status",
        newValue: "fulfilled",
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { code: string };
      expect(error.code).toBe("ERR_INVALID_TRANSITION");
    }
  });

  it("rejects skipping shipping steps: not_shipped → delivered", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "bad-sh-skip" });
    orderIds.push(o.id);

    try {
      await transitionOrderStatus(db, {
        orderId: o.id,
        statusType: "shipping_status",
        newValue: "delivered",
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { code: string };
      expect(error.code).toBe("ERR_INVALID_TRANSITION");
    }
  });

  // -------------------------------------------------------------------------
  // Non-existent order
  // -------------------------------------------------------------------------

  it("rejects transition on non-existent order with ERR_ORDER_NOT_FOUND", async () => {
    const db = dbConn.db;

    try {
      await transitionOrderStatus(db, {
        orderId: "00000000-0000-0000-0000-000000000000",
        statusType: "status",
        newValue: "confirmed",
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { code: string; message: string };
      expect(error.code).toBe("ERR_ORDER_NOT_FOUND");
      expect(error.message).toContain("00000000-0000-0000-0000-000000000000");
    }
  });

  // -------------------------------------------------------------------------
  // Audit log: history entries verified per-transition
  // -------------------------------------------------------------------------

  it("each transition writes exactly one history entry with correct fields", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "audit" });
    orderIds.push(o.id);

    // Perform 3 transitions
    await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "processing",
      reason: "PI created",
    });
    await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "payment_status",
      newValue: "paid",
      reason: "PI succeeded",
    });
    await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "status",
      newValue: "confirmed",
      reason: "Payment confirmed",
      actorAdminUserId: undefined,
    });

    const history = await findOrderStatusHistory(db, o.id);
    expect(history.length).toBe(3);

    // Verify each entry has concrete values
    const h1 = history.find(
      (h) => h.statusType === "payment_status" && h.newValue === "processing",
    );
    expect(h1).toBeDefined();
    expect(h1!.oldValue).toBe("unpaid");
    expect(h1!.reason).toBe("PI created");
    expect(h1!.actorAdminUserId).toBeNull();
    expect(h1!.createdAt).toBeInstanceOf(Date);
    expect(h1!.createdAt.getTime()).toBeLessThanOrEqual(Date.now());

    const h2 = history.find((h) => h.statusType === "payment_status" && h.newValue === "paid");
    expect(h2).toBeDefined();
    expect(h2!.oldValue).toBe("processing");
    expect(h2!.reason).toBe("PI succeeded");

    const h3 = history.find((h) => h.statusType === "status" && h.newValue === "confirmed");
    expect(h3).toBeDefined();
    expect(h3!.oldValue).toBe("pending_payment");
    expect(h3!.reason).toBe("Payment confirmed");
  });

  it("failed transitions do NOT create history entries", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "no-audit", status: "canceled" });
    orderIds.push(o.id);

    try {
      await transitionOrderStatus(db, {
        orderId: o.id,
        statusType: "status",
        newValue: "confirmed",
      });
    } catch {
      // expected
    }

    const history = await findOrderStatusHistory(db, o.id);
    expect(history.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Transition result shape
  // -------------------------------------------------------------------------

  it("transition result includes orderId, statusType, oldValue, newValue, success", async () => {
    const db = dbConn.db;
    const o = await createOrderAtState(db, { suffix: "result-shape" });
    orderIds.push(o.id);

    const result = await transitionOrderStatus(db, {
      orderId: o.id,
      statusType: "status",
      newValue: "confirmed",
      reason: "test",
    });

    expect(result).toEqual({
      success: true,
      orderId: o.id,
      statusType: "status",
      oldValue: "pending_payment",
      newValue: "confirmed",
    });
  });
});
