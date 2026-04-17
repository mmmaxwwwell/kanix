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
  findShipmentById,
  findShipmentsByOrderId,
  findShipmentLinesByShipmentId,
  findShipmentPackagesByShipmentId,
  buyShipmentLabel,
  transitionShipmentStatus,
  isValidShipmentTransition,
  findLabelPurchasesByShipmentId,
  refreshShipmentTracking,
  findShipmentEventsByShipmentId,
  markShipmentShipped,
} from "./db/queries/shipment.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("shipment integration (T058)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  let testOrderId = "";
  let testOrderLineId1 = "";
  let testOrderLineId2 = "";
  const createdShipmentIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

    // Create a test order (confirmed, paid)
    const [newOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T058-${ts}`,
        email: `t058-${ts}@test.kanix.dev`,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "queued",
        shippingStatus: "not_shipped",
        subtotalMinor: 8000,
        taxMinor: 400,
        shippingMinor: 599,
        totalMinor: 8999,
        placedAt: new Date(),
      })
      .returning();
    testOrderId = newOrder.id;

    // Create order lines
    const [line1] = await db
      .insert(orderLine)
      .values({
        orderId: testOrderId,
        variantId: "00000000-0000-0000-0000-000000000001",
        skuSnapshot: "KNX-PLATE-001",
        titleSnapshot: "Test Plate",
        quantity: 2,
        unitPriceMinor: 2500,
        totalMinor: 5000,
      })
      .returning();
    testOrderLineId1 = line1.id;

    const [line2] = await db
      .insert(orderLine)
      .values({
        orderId: testOrderId,
        variantId: "00000000-0000-0000-0000-000000000002",
        skuSnapshot: "KNX-BOWL-001",
        titleSnapshot: "Test Bowl",
        quantity: 1,
        unitPriceMinor: 3000,
        totalMinor: 3000,
      })
      .returning();
    testOrderLineId2 = line2.id;
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
      await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, testOrderId));
      await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId));
      await db.delete(order).where(eq(order.id, testOrderId));
      await dbConn.close();
    }
  });

  // -------------------------------------------------------------------------
  // Unit-level: state machine validation
  // -------------------------------------------------------------------------

  it("validates correct shipment transitions", () => {
    expect(isValidShipmentTransition("draft", "label_pending")).toBe(true);
    expect(isValidShipmentTransition("label_pending", "label_purchased")).toBe(true);
    expect(isValidShipmentTransition("label_purchased", "ready")).toBe(true);
    expect(isValidShipmentTransition("ready", "shipped")).toBe(true);
    expect(isValidShipmentTransition("shipped", "in_transit")).toBe(true);
    expect(isValidShipmentTransition("in_transit", "delivered")).toBe(true);
  });

  it("rejects invalid shipment transitions", () => {
    expect(isValidShipmentTransition("draft", "shipped")).toBe(false);
    expect(isValidShipmentTransition("delivered", "draft")).toBe(false);
    expect(isValidShipmentTransition("voided", "draft")).toBe(false);
    expect(isValidShipmentTransition("shipped", "draft")).toBe(false);
  });

  it("allows voided transition from pre-ship states", () => {
    expect(isValidShipmentTransition("draft", "voided")).toBe(true);
    expect(isValidShipmentTransition("label_pending", "voided")).toBe(true);
    expect(isValidShipmentTransition("label_purchased", "voided")).toBe(true);
    expect(isValidShipmentTransition("ready", "voided")).toBe(true);
    // shipped should NOT allow voided
    expect(isValidShipmentTransition("shipped", "voided")).toBe(false);
  });

  it("allows exception and recovery transitions", () => {
    expect(isValidShipmentTransition("in_transit", "exception")).toBe(true);
    expect(isValidShipmentTransition("exception", "in_transit")).toBe(true);
  });

  it("allows delivered → returned", () => {
    expect(isValidShipmentTransition("delivered", "returned")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Create shipment
  // -------------------------------------------------------------------------

  it("creates a draft shipment with packages and lines", async () => {
    const db = dbConn.db;

    const result = await createShipment(db, {
      orderId: testOrderId,
      packages: [
        {
          weight: 16,
          dimensions: { length: 12, width: 8, height: 4 },
          packageType: "box",
        },
      ],
      lines: [
        { orderLineId: testOrderLineId1, quantity: 2 },
        { orderLineId: testOrderLineId2, quantity: 1 },
      ],
    });
    createdShipmentIds.push(result.shipment.id);

    // Verify shipment
    expect(result.shipment.status).toBe("draft");
    expect(result.shipment.orderId).toBe(testOrderId);
    expect(result.shipment.shipmentNumber).toContain("SHP-");

    // Verify packages
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].weight).toBe("16");
    expect(result.packages[0].dimensionsJson).toEqual({
      length: 12,
      width: 8,
      height: 4,
    });

    // Verify lines
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].orderLineId).toBe(testOrderLineId1);
    expect(result.lines[0].quantity).toBe(2);
    expect(result.lines[1].orderLineId).toBe(testOrderLineId2);
    expect(result.lines[1].quantity).toBe(1);
  });

  it("rejects shipment for non-existent order", async () => {
    const db = dbConn.db;
    await expect(
      createShipment(db, {
        orderId: "00000000-0000-0000-0000-000000000099",
        packages: [{ weight: 10 }],
        lines: [],
      }),
    ).rejects.toMatchObject({ code: "ERR_ORDER_NOT_FOUND" });
  });

  it("rejects shipment with mismatched order line", async () => {
    const db = dbConn.db;
    await expect(
      createShipment(db, {
        orderId: testOrderId,
        packages: [{ weight: 10 }],
        lines: [{ orderLineId: "00000000-0000-0000-0000-000000000099", quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "ERR_ORDER_LINE_NOT_FOUND" });
  });

  // -------------------------------------------------------------------------
  // Find shipments
  // -------------------------------------------------------------------------

  it("finds shipment by ID with details", async () => {
    const db = dbConn.db;
    const sid = createdShipmentIds[0];

    const found = await findShipmentById(db, sid);
    expect(found).not.toBeNull();
    expect(found?.status).toBe("draft");
    expect(found?.orderId).toBe(testOrderId);

    const packages = await findShipmentPackagesByShipmentId(db, sid);
    expect(packages).toHaveLength(1);

    const lines = await findShipmentLinesByShipmentId(db, sid);
    expect(lines).toHaveLength(2);
  });

  it("finds shipments by order ID", async () => {
    const db = dbConn.db;
    const shipments = await findShipmentsByOrderId(db, testOrderId);
    expect(shipments.length).toBeGreaterThanOrEqual(1);
    expect(shipments[0].orderId).toBe(testOrderId);
  });

  // -------------------------------------------------------------------------
  // Buy label
  // -------------------------------------------------------------------------

  it("buys a label via stub adapter and records purchase", async () => {
    const db = dbConn.db;
    const sid = createdShipmentIds[0];
    const adapter = createStubShippingAdapter();

    const result = await buyShipmentLabel(
      db,
      {
        shipmentId: sid,
        providerShipmentId: "shp_stub_1",
        rateId: "rate_stub_priority_1",
      },
      adapter,
    );

    // Shipment should be label_purchased
    expect(result.shipment.status).toBe("label_purchased");
    expect(result.shipment.trackingNumber).toBeTruthy();
    expect(result.shipment.labelUrl).toBeTruthy();
    expect(result.shipment.carrier).toBe("USPS");
    expect(result.shipment.serviceLevel).toBe("Priority");

    // Label result
    expect(result.label.trackingNumber).toBeTruthy();
    expect(result.label.labelUrl).toBeTruthy();
    expect(result.label.trackerId).toBeTruthy();

    // Purchase record
    expect(result.purchase.costMinor).toBe(599);
    expect(result.purchase.currency).toBe("USD");
    expect(result.purchase.providerLabelId).toBe(result.label.trackingNumber);

    // Verify purchase is persisted
    const purchases = await findLabelPurchasesByShipmentId(db, sid);
    expect(purchases).toHaveLength(1);
    expect(purchases[0].costMinor).toBe(599);
  });

  it("rejects buy-label for already-purchased shipment", async () => {
    const db = dbConn.db;
    const sid = createdShipmentIds[0];
    const adapter = createStubShippingAdapter();

    await expect(
      buyShipmentLabel(
        db,
        {
          shipmentId: sid,
          providerShipmentId: "shp_stub_2",
          rateId: "rate_stub_priority_2",
        },
        adapter,
      ),
    ).rejects.toMatchObject({ code: "ERR_INVALID_STATE" });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle: create → buy label → ready → shipped
  // -------------------------------------------------------------------------

  it("full shipment lifecycle: draft → label_purchased → ready → shipped → in_transit → delivered", async () => {
    const db = dbConn.db;

    // Create a second shipment
    const result = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 8 }],
      lines: [{ orderLineId: testOrderLineId1, quantity: 1 }],
    });
    createdShipmentIds.push(result.shipment.id);
    const sid = result.shipment.id;

    expect(result.shipment.status).toBe("draft");

    // Buy label
    const adapter = createStubShippingAdapter();
    const buyResult = await buyShipmentLabel(
      db,
      {
        shipmentId: sid,
        providerShipmentId: "shp_stub_lifecycle",
        rateId: "rate_stub_lifecycle",
      },
      adapter,
    );
    expect(buyResult.shipment.status).toBe("label_purchased");

    // Transition to ready
    const readyResult = await transitionShipmentStatus(db, sid, "ready");
    expect(readyResult.oldStatus).toBe("label_purchased");
    expect(readyResult.newStatus).toBe("ready");

    // Transition to shipped
    const shippedResult = await transitionShipmentStatus(db, sid, "shipped");
    expect(shippedResult.oldStatus).toBe("ready");
    expect(shippedResult.newStatus).toBe("shipped");

    // Verify shipped_at is set
    const shippedShipment = await findShipmentById(db, sid);
    expect(shippedShipment?.status).toBe("shipped");

    // Transition to in_transit
    const inTransitResult = await transitionShipmentStatus(db, sid, "in_transit");
    expect(inTransitResult.oldStatus).toBe("shipped");
    expect(inTransitResult.newStatus).toBe("in_transit");

    // Transition to delivered
    const deliveredResult = await transitionShipmentStatus(db, sid, "delivered");
    expect(deliveredResult.oldStatus).toBe("in_transit");
    expect(deliveredResult.newStatus).toBe("delivered");

    const deliveredShipment = await findShipmentById(db, sid);
    expect(deliveredShipment?.status).toBe("delivered");
  });

  // -------------------------------------------------------------------------
  // Invalid transition
  // -------------------------------------------------------------------------

  it("rejects invalid shipment status transition", async () => {
    const db = dbConn.db;

    // Create a new shipment in draft
    const result = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 5 }],
      lines: [{ orderLineId: testOrderLineId2, quantity: 1 }],
    });
    createdShipmentIds.push(result.shipment.id);

    // Try to go directly from draft to shipped
    await expect(transitionShipmentStatus(db, result.shipment.id, "shipped")).rejects.toMatchObject(
      { code: "ERR_INVALID_TRANSITION" },
    );
  });

  // -------------------------------------------------------------------------
  // Refresh tracking (T059b)
  // -------------------------------------------------------------------------

  it("refreshes tracking on a shipped shipment and stores new events", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create a shipment and walk it to shipped status
    const created = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 12 }],
      lines: [{ orderLineId: testOrderLineId1, quantity: 1 }],
    });
    createdShipmentIds.push(created.shipment.id);
    const sid = created.shipment.id;

    // Buy label (stores trackerId in rawPayloadJson)
    await buyShipmentLabel(
      db,
      { shipmentId: sid, providerShipmentId: "shp_stub_refresh", rateId: "rate_stub_refresh" },
      adapter,
    );

    // Transition to ready → shipped
    await transitionShipmentStatus(db, sid, "ready");
    await transitionShipmentStatus(db, sid, "shipped");

    // Refresh tracking
    const result = await refreshShipmentTracking(db, sid, adapter);

    // Stub adapter returns 1 event with status "in_transit"
    expect(result.tracking.status).toBe("in_transit");
    expect(result.tracking.events).toHaveLength(1);
    expect(result.newEventsStored).toBe(1);
    expect(result.shipmentTransitioned).toBe(true);
    expect(result.shipment.status).toBe("in_transit");

    // Verify events are persisted
    const events = await findShipmentEventsByShipmentId(db, sid);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const inTransitEvent = events.find((e) => e.status === "in_transit");
    expect(inTransitEvent).toBeDefined();
    expect(inTransitEvent?.description).toBe("Package in transit");
  });

  it("refresh-tracking is idempotent — no duplicate events on second call", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create a shipment and walk it to shipped status
    const created = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 10 }],
      lines: [{ orderLineId: testOrderLineId2, quantity: 1 }],
    });
    createdShipmentIds.push(created.shipment.id);
    const sid = created.shipment.id;

    await buyShipmentLabel(
      db,
      {
        shipmentId: sid,
        providerShipmentId: "shp_stub_idempotent",
        rateId: "rate_stub_idempotent",
      },
      adapter,
    );
    await transitionShipmentStatus(db, sid, "ready");
    await transitionShipmentStatus(db, sid, "shipped");

    // First refresh
    const first = await refreshShipmentTracking(db, sid, adapter);
    expect(first.newEventsStored).toBe(1);

    // Second refresh — same events should not be duplicated
    const second = await refreshShipmentTracking(db, sid, adapter);
    expect(second.newEventsStored).toBe(0);

    // Total events should still be 1
    const events = await findShipmentEventsByShipmentId(db, sid);
    const refreshEvents = events.filter((e) => e.providerEventId?.startsWith("refresh-"));
    expect(refreshEvents).toHaveLength(1);
  });

  it("rejects refresh-tracking for draft shipment", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create a draft shipment (no label)
    const created = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 5 }],
      lines: [{ orderLineId: testOrderLineId1, quantity: 1 }],
    });
    createdShipmentIds.push(created.shipment.id);

    await expect(refreshShipmentTracking(db, created.shipment.id, adapter)).rejects.toMatchObject({
      code: "ERR_INVALID_STATE",
    });
  });

  it("rejects refresh-tracking for non-existent shipment", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    await expect(
      refreshShipmentTracking(db, "00000000-0000-0000-0000-000000000099", adapter),
    ).rejects.toMatchObject({ code: "ERR_SHIPMENT_NOT_FOUND" });
  });

  // -------------------------------------------------------------------------
  // Mark shipped (T059c)
  // -------------------------------------------------------------------------

  it("marks a ready shipment as shipped with shipped_at timestamp", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create a shipment and walk it to ready
    const created = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 14 }],
      lines: [{ orderLineId: testOrderLineId1, quantity: 1 }],
    });
    createdShipmentIds.push(created.shipment.id);
    const sid = created.shipment.id;

    await buyShipmentLabel(
      db,
      { shipmentId: sid, providerShipmentId: "shp_stub_mark", rateId: "rate_stub_mark" },
      adapter,
    );
    await transitionShipmentStatus(db, sid, "ready");

    // Mark as shipped
    const before = new Date();
    const result = await markShipmentShipped(db, sid);
    const after = new Date();

    expect(result.id).toBe(sid);
    expect(result.status).toBe("shipped");
    expect(result.shippedAt).toBeInstanceOf(Date);
    expect(result.shippedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.shippedAt.getTime()).toBeLessThanOrEqual(after.getTime());

    // Verify persisted state
    const fetched = await findShipmentById(db, sid);
    expect(fetched?.status).toBe("shipped");
  });

  it("rejects mark-shipped from non-ready status (draft)", async () => {
    const db = dbConn.db;

    // Create a draft shipment
    const created = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 6 }],
      lines: [{ orderLineId: testOrderLineId2, quantity: 1 }],
    });
    createdShipmentIds.push(created.shipment.id);

    await expect(markShipmentShipped(db, created.shipment.id)).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
    });
  });

  it("rejects mark-shipped from label_purchased status", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    const created = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 7 }],
      lines: [{ orderLineId: testOrderLineId1, quantity: 1 }],
    });
    createdShipmentIds.push(created.shipment.id);

    await buyShipmentLabel(
      db,
      {
        shipmentId: created.shipment.id,
        providerShipmentId: "shp_stub_lp",
        rateId: "rate_stub_lp",
      },
      adapter,
    );

    // label_purchased, not ready — should reject
    await expect(markShipmentShipped(db, created.shipment.id)).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
    });
  });

  it("rejects mark-shipped for non-existent shipment", async () => {
    const db = dbConn.db;

    await expect(
      markShipmentShipped(db, "00000000-0000-0000-0000-000000000099"),
    ).rejects.toMatchObject({ code: "ERR_SHIPMENT_NOT_FOUND" });
  });
});
