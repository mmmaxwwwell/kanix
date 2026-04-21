import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { eq } from "drizzle-orm";
import { requireDatabaseUrl } from "./test-helpers.js";
import {
  transitionOrderStatus,
  findOrderById,
  findOrderStatusHistory,
} from "./db/queries/order-state-machine.js";

const DATABASE_URL = requireDatabaseUrl();

describe("order state machine integration (T050)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  let testOrderId = "";

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create a test order directly in the DB (at pending_payment status, matching checkout output)
    const [newOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T050-${ts}`,
        email: `t050-${ts}@test.kanix.dev`,
        status: "pending_payment",
        paymentStatus: "unpaid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 3000,
        taxMinor: 0,
        shippingMinor: 599,
        totalMinor: 3599,
        placedAt: new Date(),
      })
      .returning();
    testOrderId = newOrder.id;

    // Also create initial history entry like checkout does
    await db.insert(orderStatusHistory).values({
      orderId: testOrderId,
      statusType: "status",
      oldValue: "draft",
      newValue: "pending_payment",
      reason: "Checkout completed",
    });
  });

  afterAll(async () => {
    if (dbConn) {
      // Clean up test data
      const db = dbConn.db;
      await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, testOrderId));
      await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId));
      await db.delete(order).where(eq(order.id, testOrderId));
      await dbConn.close();
    }
  });

  // -------------------------------------------------------------------------
  // Full order lifecycle
  // -------------------------------------------------------------------------

  it("full order lifecycle: pending_payment → confirmed → completed → closed", async () => {
    const db = dbConn.db;

    // Start: pending_payment (set in beforeAll)
    const initial = await findOrderById(db, testOrderId);
    expect(initial).not.toBeNull();
    expect(initial?.status).toBe("pending_payment");

    // 1. Payment succeeds → payment_status: unpaid → processing
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "payment_status",
      newValue: "processing",
      reason: "Payment intent created",
    });

    // 2. Payment confirmed → payment_status: processing → paid
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "payment_status",
      newValue: "paid",
      reason: "Stripe payment_intent.succeeded",
    });

    // 3. Order confirmed → status: pending_payment → confirmed
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "status",
      newValue: "confirmed",
      reason: "Payment confirmed",
    });

    // 4. Fulfillment begins → fulfillment_status: unfulfilled → queued
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "fulfillment_status",
      newValue: "queued",
      reason: "Fulfillment task created",
    });

    // 5. Picking → packing → ready_to_ship → fulfilled
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "fulfillment_status",
      newValue: "picking",
    });
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "fulfillment_status",
      newValue: "packing",
    });
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "fulfillment_status",
      newValue: "ready_to_ship",
    });
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "fulfillment_status",
      newValue: "fulfilled",
      reason: "All items shipped",
    });

    // 6. Shipping lifecycle
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "shipping_status",
      newValue: "label_pending",
    });
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "shipping_status",
      newValue: "label_purchased",
    });
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "shipping_status",
      newValue: "shipped",
    });
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "shipping_status",
      newValue: "in_transit",
    });
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "shipping_status",
      newValue: "out_for_delivery",
    });
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "shipping_status",
      newValue: "delivered",
      reason: "Carrier confirmed delivery",
    });

    // 7. Order completed
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "status",
      newValue: "completed",
      reason: "All lines fulfilled and delivered",
    });

    // 8. Order closed
    await transitionOrderStatus(db, {
      orderId: testOrderId,
      statusType: "status",
      newValue: "closed",
      reason: "Admin closed",
    });

    // Verify final state
    const finalOrder = await findOrderById(db, testOrderId);
    expect(finalOrder).not.toBeNull();
    expect(finalOrder?.status).toBe("closed");
    expect(finalOrder?.paymentStatus).toBe("paid");
    expect(finalOrder?.fulfillmentStatus).toBe("fulfilled");
    expect(finalOrder?.shippingStatus).toBe("delivered");

    // Verify history entries were created for every transition
    const history = await findOrderStatusHistory(db, testOrderId);
    // 1 (checkout) + 2 (payment) + 3 (status) + 5 (fulfillment) + 6 (shipping) = 17
    expect(history.length).toBe(17);

    // Verify at least one history entry has the right shape
    const checkoutEntry = history.find(
      (h) =>
        h.statusType === "status" && h.oldValue === "draft" && h.newValue === "pending_payment",
    );
    expect(checkoutEntry).toBeDefined();
    expect(checkoutEntry?.reason).toBe("Checkout completed");
  });

  // -------------------------------------------------------------------------
  // Invalid transitions
  // -------------------------------------------------------------------------

  it("rejects invalid status transition with ERR_INVALID_TRANSITION", async () => {
    const db = dbConn.db;

    // Order is now "closed" — transitioning to "confirmed" should fail
    try {
      await transitionOrderStatus(db, {
        orderId: testOrderId,
        statusType: "status",
        newValue: "confirmed",
        reason: "Should fail",
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as {
        code: string;
        message: string;
        statusType: string;
        from: string;
        to: string;
      };
      expect(error.code).toBe("ERR_INVALID_TRANSITION");
      expect(error.statusType).toBe("status");
      expect(error.from).toBe("closed");
      expect(error.to).toBe("confirmed");
    }
  });

  it("rejects invalid payment_status transition", async () => {
    const db = dbConn.db;

    // payment_status is "paid" — transitioning to "processing" is invalid
    try {
      await transitionOrderStatus(db, {
        orderId: testOrderId,
        statusType: "payment_status",
        newValue: "processing",
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { code: string };
      expect(error.code).toBe("ERR_INVALID_TRANSITION");
    }
  });

  it("rejects transition on non-existent order", async () => {
    const db = dbConn.db;

    try {
      await transitionOrderStatus(db, {
        orderId: "00000000-0000-0000-0000-000000000000",
        statusType: "status",
        newValue: "confirmed",
      });
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      const error = err as { code: string };
      expect(error.code).toBe("ERR_ORDER_NOT_FOUND");
    }
  });

  // -------------------------------------------------------------------------
  // Second order: test cancellation path
  // -------------------------------------------------------------------------

  it("cancellation path: pending_payment → canceled", async () => {
    const db = dbConn.db;

    // Create another order for the cancel test
    const [cancelOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T050-CANCEL-${ts}`,
        email: `t050-cancel-${ts}@test.kanix.dev`,
        status: "pending_payment",
        paymentStatus: "unpaid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 1000,
        taxMinor: 0,
        shippingMinor: 0,
        totalMinor: 1000,
        placedAt: new Date(),
      })
      .returning();

    // Cancel from pending_payment
    const result = await transitionOrderStatus(db, {
      orderId: cancelOrder.id,
      statusType: "status",
      newValue: "canceled",
      reason: "Customer requested cancellation",
    });

    expect(result.success).toBe(true);
    expect(result.oldValue).toBe("pending_payment");
    expect(result.newValue).toBe("canceled");

    // Also cancel fulfillment and shipping
    await transitionOrderStatus(db, {
      orderId: cancelOrder.id,
      statusType: "fulfillment_status",
      newValue: "canceled",
      reason: "Order canceled",
    });
    await transitionOrderStatus(db, {
      orderId: cancelOrder.id,
      statusType: "shipping_status",
      newValue: "canceled",
      reason: "Order canceled",
    });

    const final = await findOrderById(db, cancelOrder.id);
    expect(final).not.toBeNull();
    expect(final?.status).toBe("canceled");
    expect(final?.fulfillmentStatus).toBe("canceled");
    expect(final?.shippingStatus).toBe("canceled");

    // Clean up
    await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, cancelOrder.id));
    await db.delete(order).where(eq(order.id, cancelOrder.id));
  });

  // -------------------------------------------------------------------------
  // Dispute path
  // -------------------------------------------------------------------------

  it("dispute path: paid → disputed → paid (won)", async () => {
    const db = dbConn.db;

    const [disputeOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T050-DISPUTE-${ts}`,
        email: `t050-dispute-${ts}@test.kanix.dev`,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 2000,
        taxMinor: 0,
        shippingMinor: 0,
        totalMinor: 2000,
        placedAt: new Date(),
      })
      .returning();

    // paid → disputed
    await transitionOrderStatus(db, {
      orderId: disputeOrder.id,
      statusType: "payment_status",
      newValue: "disputed",
      reason: "charge.dispute.created",
    });

    // disputed → paid (dispute won)
    await transitionOrderStatus(db, {
      orderId: disputeOrder.id,
      statusType: "payment_status",
      newValue: "paid",
      reason: "Dispute won",
    });

    const final = await findOrderById(db, disputeOrder.id);
    expect(final?.paymentStatus).toBe("paid");

    // Verify history
    const history = await findOrderStatusHistory(db, disputeOrder.id);
    expect(history.length).toBe(2);
    expect(history.some((h) => h.newValue === "disputed")).toBe(true);
    expect(history.some((h) => h.oldValue === "disputed" && h.newValue === "paid")).toBe(true);

    // Clean up
    await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, disputeOrder.id));
    await db.delete(order).where(eq(order.id, disputeOrder.id));
  });
});
