import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import {
  shipment,
  shipmentPackage,
  shipmentLine,
  shipmentEvent,
  shippingLabelPurchase,
} from "./db/schema/fulfillment.js";
import { eq } from "drizzle-orm";
import {
  createShipment,
  transitionShipmentStatus,
  buyShipmentLabel,
  handleTrackingUpdate,
  findShipmentById,
  propagateOrderFulfillmentStatus,
  propagateOrderDeliveredStatus,
  tryAutoCompleteOrder,
} from "./db/queries/shipment.js";
import { findOrderById } from "./db/queries/order-state-machine.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("fulfillment → shipping status propagation (T060)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  const createdOrderIds: string[] = [];
  const createdShipmentIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      // Clean up in reverse dependency order
      for (const sid of createdShipmentIds) {
        await db.delete(shipmentEvent).where(eq(shipmentEvent.shipmentId, sid));
        await db.delete(shippingLabelPurchase).where(eq(shippingLabelPurchase.shipmentId, sid));
        await db.delete(shipmentLine).where(eq(shipmentLine.shipmentId, sid));
        await db.delete(shipmentPackage).where(eq(shipmentPackage.shipmentId, sid));
        await db.delete(shipment).where(eq(shipment.id, sid));
      }
      for (const oid of createdOrderIds) {
        await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, oid));
        await db.delete(orderLine).where(eq(orderLine.orderId, oid));
        await db.delete(order).where(eq(order.id, oid));
      }
      await dbConn.close();
    }
  });

  // Helper: create a test order with order lines
  async function createTestOrder(opts: {
    suffix: string;
    fulfillmentStatus?: string;
    shippingStatus?: string;
    lineQuantities?: number[];
  }) {
    const db = dbConn.db;
    const [newOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T060-${opts.suffix}-${ts}`,
        email: `t060-${opts.suffix}-${ts}@test.kanix.dev`,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: opts.fulfillmentStatus ?? "partially_fulfilled",
        shippingStatus: opts.shippingStatus ?? "shipped",
        subtotalMinor: 5000,
        taxMinor: 250,
        shippingMinor: 599,
        totalMinor: 5849,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(newOrder.id);

    const quantities = opts.lineQuantities ?? [2, 1];
    const lineIds: string[] = [];
    for (let i = 0; i < quantities.length; i++) {
      const [line] = await db
        .insert(orderLine)
        .values({
          orderId: newOrder.id,
          variantId: `00000000-0000-0000-0000-00000000000${i + 1}`,
          skuSnapshot: `KNX-T060-${i + 1}`,
          titleSnapshot: `Test Item ${i + 1}`,
          quantity: quantities[i],
          unitPriceMinor: 2500,
          totalMinor: 2500 * quantities[i],
        })
        .returning();
      lineIds.push(line.id);
    }

    return { orderId: newOrder.id, lineIds };
  }

  // Helper: create a shipment, buy label, and walk to a target status
  async function createShipmentAtStatus(
    orderId: string,
    lines: { orderLineId: string; quantity: number }[],
    targetStatus: string,
  ) {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    const result = await createShipment(db, {
      orderId,
      packages: [{ weight: 10 }],
      lines,
    });
    createdShipmentIds.push(result.shipment.id);
    const sid = result.shipment.id;

    if (targetStatus === "draft") return sid;

    // Buy label (draft → label_pending → label_purchased)
    await buyShipmentLabel(
      db,
      { shipmentId: sid, providerShipmentId: `shp_t060_${sid}`, rateId: `rate_t060_${sid}` },
      adapter,
    );

    if (targetStatus === "label_purchased") return sid;

    // → ready
    await transitionShipmentStatus(db, sid, "ready");
    if (targetStatus === "ready") return sid;

    // → shipped
    await transitionShipmentStatus(db, sid, "shipped");
    if (targetStatus === "shipped") return sid;

    // → in_transit
    await transitionShipmentStatus(db, sid, "in_transit");
    if (targetStatus === "in_transit") return sid;

    // → delivered
    await transitionShipmentStatus(db, sid, "delivered");
    return sid;
  }

  // -------------------------------------------------------------------------
  // propagateOrderFulfillmentStatus
  // -------------------------------------------------------------------------

  it("transitions fulfillment_status → fulfilled when all lines are shipped", async () => {
    const db = dbConn.db;
    const { orderId, lineIds } = await createTestOrder({
      suffix: "fulfill-all",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "shipped",
      lineQuantities: [2, 1],
    });

    // Create one shipment covering all lines, walk to shipped
    await createShipmentAtStatus(
      orderId,
      [
        { orderLineId: lineIds[0], quantity: 2 },
        { orderLineId: lineIds[1], quantity: 1 },
      ],
      "shipped",
    );

    const result = await propagateOrderFulfillmentStatus(db, orderId);
    expect(result).toBe(true);

    const updated = await findOrderById(db, orderId);
    expect(updated?.fulfillmentStatus).toBe("fulfilled");
  });

  it("does NOT transition fulfillment_status when some lines are missing", async () => {
    const db = dbConn.db;
    const { orderId, lineIds } = await createTestOrder({
      suffix: "fulfill-partial",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "shipped",
      lineQuantities: [2, 1],
    });

    // Only ship line 1 (line 2 not covered)
    await createShipmentAtStatus(orderId, [{ orderLineId: lineIds[0], quantity: 2 }], "shipped");

    const result = await propagateOrderFulfillmentStatus(db, orderId);
    expect(result).toBe(false);

    const updated = await findOrderById(db, orderId);
    expect(updated?.fulfillmentStatus).toBe("partially_fulfilled");
  });

  it("does NOT transition fulfillment_status when quantity is insufficient", async () => {
    const db = dbConn.db;
    const { orderId, lineIds } = await createTestOrder({
      suffix: "fulfill-qty",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "shipped",
      lineQuantities: [3],
    });

    // Only ship 2 of 3
    await createShipmentAtStatus(orderId, [{ orderLineId: lineIds[0], quantity: 2 }], "shipped");

    const result = await propagateOrderFulfillmentStatus(db, orderId);
    expect(result).toBe(false);
  });

  it("considers multiple shipments when checking fulfillment coverage", async () => {
    const db = dbConn.db;
    const { orderId, lineIds } = await createTestOrder({
      suffix: "fulfill-multi",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "shipped",
      lineQuantities: [3, 2],
    });

    // Split across two shipments
    await createShipmentAtStatus(
      orderId,
      [
        { orderLineId: lineIds[0], quantity: 2 },
        { orderLineId: lineIds[1], quantity: 1 },
      ],
      "shipped",
    );

    await createShipmentAtStatus(
      orderId,
      [
        { orderLineId: lineIds[0], quantity: 1 },
        { orderLineId: lineIds[1], quantity: 1 },
      ],
      "delivered",
    );

    const result = await propagateOrderFulfillmentStatus(db, orderId);
    expect(result).toBe(true);

    const updated = await findOrderById(db, orderId);
    expect(updated?.fulfillmentStatus).toBe("fulfilled");
  });

  it("ignores voided shipments when calculating fulfillment", async () => {
    const db = dbConn.db;
    const { orderId, lineIds } = await createTestOrder({
      suffix: "fulfill-voided",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "shipped",
      lineQuantities: [1],
    });

    // Create a voided shipment (doesn't count)
    await createShipmentAtStatus(orderId, [{ orderLineId: lineIds[0], quantity: 1 }], "draft");
    // Void the draft shipment
    const db2 = dbConn.db;
    const voidSid = createdShipmentIds[createdShipmentIds.length - 1];
    await transitionShipmentStatus(db2, voidSid, "voided");

    const result = await propagateOrderFulfillmentStatus(db, orderId);
    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // propagateOrderDeliveredStatus
  // -------------------------------------------------------------------------

  it("transitions shipping_status → delivered when all shipments delivered", async () => {
    const db = dbConn.db;
    const { orderId, lineIds } = await createTestOrder({
      suffix: "deliver-all",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "out_for_delivery",
      lineQuantities: [1, 1],
    });

    // Two shipments, both delivered
    await createShipmentAtStatus(orderId, [{ orderLineId: lineIds[0], quantity: 1 }], "delivered");

    await createShipmentAtStatus(orderId, [{ orderLineId: lineIds[1], quantity: 1 }], "delivered");

    const result = await propagateOrderDeliveredStatus(db, orderId);
    expect(result).toBe(true);

    const updated = await findOrderById(db, orderId);
    expect(updated?.shippingStatus).toBe("delivered");
  });

  it("does NOT transition shipping_status when some shipments not delivered", async () => {
    const db = dbConn.db;
    const { orderId, lineIds } = await createTestOrder({
      suffix: "deliver-partial",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "in_transit",
      lineQuantities: [1, 1],
    });

    // One delivered, one in_transit
    await createShipmentAtStatus(orderId, [{ orderLineId: lineIds[0], quantity: 1 }], "delivered");

    await createShipmentAtStatus(orderId, [{ orderLineId: lineIds[1], quantity: 1 }], "in_transit");

    const result = await propagateOrderDeliveredStatus(db, orderId);
    expect(result).toBe(false);

    const updated = await findOrderById(db, orderId);
    expect(updated?.shippingStatus).toBe("in_transit");
  });

  it("ignores voided shipments for delivered check", async () => {
    const db = dbConn.db;
    const { orderId, lineIds } = await createTestOrder({
      suffix: "deliver-voided",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "out_for_delivery",
      lineQuantities: [1],
    });

    // One delivered + one voided
    await createShipmentAtStatus(orderId, [{ orderLineId: lineIds[0], quantity: 1 }], "delivered");

    // Create and void a second shipment
    await createShipmentAtStatus(orderId, [{ orderLineId: lineIds[0], quantity: 1 }], "draft");
    const voidSid = createdShipmentIds[createdShipmentIds.length - 1];
    await transitionShipmentStatus(db, voidSid, "voided");

    const result = await propagateOrderDeliveredStatus(db, orderId);
    expect(result).toBe(true);

    const updated = await findOrderById(db, orderId);
    expect(updated?.shippingStatus).toBe("delivered");
  });

  // -------------------------------------------------------------------------
  // tryAutoCompleteOrder
  // -------------------------------------------------------------------------

  it("auto-completes order when fulfilled + delivered + confirmed", async () => {
    const db = dbConn.db;
    const { orderId } = await createTestOrder({
      suffix: "complete",
      fulfillmentStatus: "fulfilled",
      shippingStatus: "delivered",
      lineQuantities: [1],
    });

    // Need a delivered shipment for the order (used by propagation, but
    // here we're testing tryAutoCompleteOrder directly with pre-set statuses)
    await createShipmentAtStatus(orderId, [], "delivered");

    const result = await tryAutoCompleteOrder(db, orderId);
    expect(result).toBe(true);

    const updated = await findOrderById(db, orderId);
    expect(updated?.status).toBe("completed");
  });

  it("does NOT auto-complete when fulfillment not done", async () => {
    const db = dbConn.db;
    const { orderId } = await createTestOrder({
      suffix: "no-complete-fulfill",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "delivered",
      lineQuantities: [1],
    });

    const result = await tryAutoCompleteOrder(db, orderId);
    expect(result).toBe(false);

    const updated = await findOrderById(db, orderId);
    expect(updated?.status).toBe("confirmed");
  });

  it("does NOT auto-complete when shipping not delivered", async () => {
    const db = dbConn.db;
    const { orderId } = await createTestOrder({
      suffix: "no-complete-ship",
      fulfillmentStatus: "fulfilled",
      shippingStatus: "in_transit",
      lineQuantities: [1],
    });

    const result = await tryAutoCompleteOrder(db, orderId);
    expect(result).toBe(false);

    const updated = await findOrderById(db, orderId);
    expect(updated?.status).toBe("confirmed");
  });

  // -------------------------------------------------------------------------
  // Full end-to-end: handleTrackingUpdate triggers propagation
  // -------------------------------------------------------------------------

  it("complete flow: shipment delivered → fulfillment fulfilled → order completed", async () => {
    const db = dbConn.db;

    // Create order: confirmed, paid, partially_fulfilled, shipped
    const { orderId, lineIds } = await createTestOrder({
      suffix: "e2e",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "out_for_delivery",
      lineQuantities: [2, 1],
    });

    // Create a single shipment covering all lines, walk to in_transit
    const sid = await createShipmentAtStatus(
      orderId,
      [
        { orderLineId: lineIds[0], quantity: 2 },
        { orderLineId: lineIds[1], quantity: 1 },
      ],
      "in_transit",
    );

    // Verify order is still partially_fulfilled and out_for_delivery
    let orderState = await findOrderById(db, orderId);
    expect(orderState?.fulfillmentStatus).toBe("partially_fulfilled");
    expect(orderState?.status).toBe("confirmed");

    // Simulate delivered tracking event via handleTrackingUpdate
    const shipmentRecord = await findShipmentById(db, sid);
    if (!shipmentRecord) throw new Error("Shipment not found");

    const result = await handleTrackingUpdate(db, shipmentRecord, "delivered");

    // Shipment should transition to delivered
    expect(result.shipmentTransitioned).toBe(true);
    const updatedShipment = await findShipmentById(db, sid);
    expect(updatedShipment?.status).toBe("delivered");

    // Order shipping_status should be delivered (all shipments delivered)
    expect(result.orderTransitioned).toBe(true);

    // Order should be auto-completed
    expect(result.orderCompleted).toBe(true);

    // Verify final order state
    orderState = await findOrderById(db, orderId);
    expect(orderState?.fulfillmentStatus).toBe("fulfilled");
    expect(orderState?.shippingStatus).toBe("delivered");
    expect(orderState?.status).toBe("completed");
  });

  it("multi-shipment: order NOT completed until all shipments delivered", async () => {
    const db = dbConn.db;

    const { orderId, lineIds } = await createTestOrder({
      suffix: "e2e-multi",
      fulfillmentStatus: "partially_fulfilled",
      shippingStatus: "in_transit",
      lineQuantities: [1, 1],
    });

    // Two shipments, each covering one line
    const sid1 = await createShipmentAtStatus(
      orderId,
      [{ orderLineId: lineIds[0], quantity: 1 }],
      "in_transit",
    );

    const sid2 = await createShipmentAtStatus(
      orderId,
      [{ orderLineId: lineIds[1], quantity: 1 }],
      "in_transit",
    );

    // First shipment delivers
    const shipment1 = await findShipmentById(db, sid1);
    if (!shipment1) throw new Error("Shipment 1 not found");
    const result1 = await handleTrackingUpdate(db, shipment1, "delivered");
    expect(result1.shipmentTransitioned).toBe(true);

    // Order should NOT be delivered or completed yet (second shipment still in_transit)
    let orderState = await findOrderById(db, orderId);
    expect(orderState?.shippingStatus).toBe("in_transit"); // not delivered
    expect(orderState?.fulfillmentStatus).toBe("partially_fulfilled"); // not all lines in delivered shipments? Actually shipment1 is delivered but sid2 is in_transit
    expect(orderState?.status).toBe("confirmed");

    // Second shipment delivers
    const shipment2 = await findShipmentById(db, sid2);
    if (!shipment2) throw new Error("Shipment 2 not found");
    const result2 = await handleTrackingUpdate(db, shipment2, "delivered");
    expect(result2.shipmentTransitioned).toBe(true);
    expect(result2.orderTransitioned).toBe(true); // now all delivered
    expect(result2.orderCompleted).toBe(true);

    // Now order should be fully propagated
    orderState = await findOrderById(db, orderId);
    expect(orderState?.fulfillmentStatus).toBe("fulfilled");
    expect(orderState?.shippingStatus).toBe("delivered");
    expect(orderState?.status).toBe("completed");
  });
});
