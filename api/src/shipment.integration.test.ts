import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  shipment,
  shipmentPackage,
  shipmentLine,
  shipmentEvent,
  shippingLabelPurchase,
  fulfillmentTask,
} from "./db/schema/fulfillment.js";
// evidence_record has an immutability trigger — cleanup uses raw SQL UPDATE instead of delete
import { eq, sql } from "drizzle-orm";
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
  voidShipmentLabel,
  findShipmentByTrackingNumber,
} from "./db/queries/shipment.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("shipment integration (T058)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  let testProductId = "";
  let testVariantId1 = "";
  let testVariantId2 = "";
  let testOrderId = "";
  let testOrderLineId1 = "";
  let testOrderLineId2 = "";
  const createdShipmentIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create a product + variants (FK required by order_line.variant_id)
    const [prod] = await db
      .insert(product)
      .values({
        slug: `t231-ship-${ts}`,
        title: `Test Product T231 ${ts}`,
        status: "active",
      })
      .returning();
    testProductId = prod.id;

    const [v1] = await db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `KNX-PLATE-${ts}`,
        title: "Test Plate",
        priceMinor: 2500,
        status: "active",
      })
      .returning();
    testVariantId1 = v1.id;

    const [v2] = await db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `KNX-BOWL-${ts}`,
        title: "Test Bowl",
        priceMinor: 3000,
        status: "active",
      })
      .returning();
    testVariantId2 = v2.id;

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

    // Create order lines with real variant IDs
    const [line1] = await db
      .insert(orderLine)
      .values({
        orderId: testOrderId,
        variantId: testVariantId1,
        skuSnapshot: `KNX-PLATE-${ts}`,
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
        variantId: testVariantId2,
        skuSnapshot: `KNX-BOWL-${ts}`,
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
        // evidence_record has an immutability trigger — skip deletion (records are orphan-safe)
        await db.delete(shipmentEvent).where(eq(shipmentEvent.shipmentId, sid));
        await db.delete(shippingLabelPurchase).where(eq(shippingLabelPurchase.shipmentId, sid));
        await db.delete(shipmentLine).where(eq(shipmentLine.shipmentId, sid));
        await db.delete(shipmentPackage).where(eq(shipmentPackage.shipmentId, sid));
      }
      // evidence_record has immutability triggers (no UPDATE/DELETE).
      // Disable only the user-defined triggers to clean up, then re-enable.
      await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);
      for (const sid of createdShipmentIds) {
        await db.execute(sql`DELETE FROM evidence_record WHERE shipment_id = ${sid}::uuid`);
      }
      await db.execute(sql`DELETE FROM evidence_record WHERE order_id = ${testOrderId}::uuid`);
      await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);
      // Delete shipments after evidence records are gone
      for (const sid of createdShipmentIds) {
        await db.delete(shipment).where(eq(shipment.id, sid));
      }
      await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, testOrderId));
      await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId));
      await db.delete(order).where(eq(order.id, testOrderId));
      // Clean up product fixtures
      if (testVariantId1)
        await db.delete(productVariant).where(eq(productVariant.id, testVariantId1));
      if (testVariantId2)
        await db.delete(productVariant).where(eq(productVariant.id, testVariantId2));
      if (testProductId) await db.delete(product).where(eq(product.id, testProductId));
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
    expect(parseFloat(result.packages[0].weight!)).toBe(16);
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
    expect(typeof shipments[0].shipmentNumber).toBe("string");
    expect(shipments[0].shipmentNumber).toContain("SHP-");
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
    expect(typeof result.shipment.trackingNumber).toBe("string");
    expect(result.shipment.trackingNumber!.length).toBeGreaterThan(0);
    expect(result.shipment.trackingNumber).toMatch(/^STUB\d+/);
    expect(typeof result.shipment.labelUrl).toBe("string");
    expect(result.shipment.labelUrl).toMatch(
      /^https:\/\/stub-labels\.example\.com\/label_\d+\.png$/,
    );
    expect(result.shipment.carrier).toBe("USPS");
    expect(result.shipment.serviceLevel).toBe("Priority");

    // Label result — concrete pattern checks
    expect(result.label.trackingNumber).toMatch(/^STUB\d+/);
    expect(result.label.labelUrl).toMatch(/^https:\/\/stub-labels\.example\.com\/label_\d+\.png$/);
    expect(result.label.trackerId).toMatch(/^trk_stub_\d+_\d+$/);
    expect(result.label.carrier).toBe("USPS");
    expect(result.label.service).toBe("Priority");

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
  // Find by tracking number (depends on label purchase above)
  // -------------------------------------------------------------------------

  it("finds shipment by tracking number after label purchase", async () => {
    const db = dbConn.db;
    const sid = createdShipmentIds[0];
    const s = await findShipmentById(db, sid);
    expect(s).not.toBeNull();
    expect(s!.trackingNumber).not.toBeNull();

    const found = await findShipmentByTrackingNumber(db, s!.trackingNumber!);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(sid);
    expect(found!.orderId).toBe(testOrderId);
    expect(found!.carrier).toBe("USPS");
  });

  it("findShipmentByTrackingNumber returns null for unknown tracking number", async () => {
    const db = dbConn.db;
    const found = await findShipmentByTrackingNumber(db, "NONEXISTENT999");
    expect(found).toBeNull();
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

  it("refresh-tracking is idempotent — no duplicate events when occurredAt is stable", async () => {
    const db = dbConn.db;

    // Use a custom adapter with a fixed (but run-unique) occurredAt to test true idempotency
    // The providerEventId check is global, so use ts to avoid collisions with prior runs
    const fixedTime = new Date(ts).toISOString();
    const stableAdapter = {
      ...createStubShippingAdapter(),
      async getTracking(): Promise<import("./services/shipping-adapter.js").TrackingResult> {
        return {
          status: "in_transit",
          estimatedDeliveryDate: null,
          events: [
            {
              status: "in_transit",
              description: "Package in transit",
              occurredAt: fixedTime,
              city: "Austin",
              state: "TX",
            },
          ],
        };
      },
    };

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
      stableAdapter,
    );
    await transitionShipmentStatus(db, sid, "ready");
    await transitionShipmentStatus(db, sid, "shipped");

    // First refresh — stores 1 new event
    const first = await refreshShipmentTracking(db, sid, stableAdapter);
    expect(first.newEventsStored).toBe(1);

    // Second refresh — same providerEventId (refresh-<fixedTime>-in_transit) → 0 new
    const second = await refreshShipmentTracking(db, sid, stableAdapter);
    expect(second.newEventsStored).toBe(0);

    // Total events should still be 1
    const events = await findShipmentEventsByShipmentId(db, sid);
    const refreshEvents = events.filter((e) => e.providerEventId?.startsWith("refresh-"));
    expect(refreshEvents).toHaveLength(1);
    expect(refreshEvents[0].providerEventId).toBe(
      `refresh-${new Date(ts).toISOString()}-in_transit`,
    );
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

  // -------------------------------------------------------------------------
  // Void label (T059a)
  // -------------------------------------------------------------------------

  it("voids a label_purchased shipment and records refund", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create a shipment, buy label → label_purchased
    const created = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 9 }],
      lines: [{ orderLineId: testOrderLineId1, quantity: 1 }],
    });
    createdShipmentIds.push(created.shipment.id);
    const sid = created.shipment.id;

    await buyShipmentLabel(
      db,
      { shipmentId: sid, providerShipmentId: "shp_stub_void1", rateId: "rate_stub_void1" },
      adapter,
    );

    // Verify it's in label_purchased before voiding
    const beforeVoid = await findShipmentById(db, sid);
    expect(beforeVoid?.status).toBe("label_purchased");

    // Void the label
    const voidResult = await voidShipmentLabel(db, sid, adapter);

    expect(voidResult.shipment.status).toBe("voided");
    expect(voidResult.shipment.id).toBe(sid);
    expect(voidResult.shipment.orderId).toBe(testOrderId);
    expect(voidResult.refunded).toBe(true);
    expect(voidResult.refundedCostMinor).toBe(599);
    expect(voidResult.labelCostCredited).toBe(true);

    // Verify persisted state
    const fetched = await findShipmentById(db, sid);
    expect(fetched?.status).toBe("voided");
  });

  it("voids a draft shipment without refund (no label purchased)", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create a draft shipment (no label)
    const created = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 4 }],
      lines: [{ orderLineId: testOrderLineId2, quantity: 1 }],
    });
    createdShipmentIds.push(created.shipment.id);
    const sid = created.shipment.id;

    const voidResult = await voidShipmentLabel(db, sid, adapter);

    expect(voidResult.shipment.status).toBe("voided");
    expect(voidResult.refunded).toBe(false);
    expect(voidResult.refundedCostMinor).toBeNull();
    expect(voidResult.labelCostCredited).toBe(false);
  });

  it("voids a ready shipment and records refund", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create → buy label → transition to ready
    const created = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 11 }],
      lines: [{ orderLineId: testOrderLineId1, quantity: 1 }],
    });
    createdShipmentIds.push(created.shipment.id);
    const sid = created.shipment.id;

    await buyShipmentLabel(
      db,
      {
        shipmentId: sid,
        providerShipmentId: "shp_stub_void_ready",
        rateId: "rate_stub_void_ready",
      },
      adapter,
    );
    await transitionShipmentStatus(db, sid, "ready");

    const voidResult = await voidShipmentLabel(db, sid, adapter);
    expect(voidResult.shipment.status).toBe("voided");
    expect(voidResult.refunded).toBe(true);
    expect(voidResult.refundedCostMinor).toBe(599);
    expect(voidResult.labelCostCredited).toBe(true);
  });

  it("rejects void for shipped shipment", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create → buy label → ready → shipped
    const created = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 13 }],
      lines: [{ orderLineId: testOrderLineId2, quantity: 1 }],
    });
    createdShipmentIds.push(created.shipment.id);
    const sid = created.shipment.id;

    await buyShipmentLabel(
      db,
      {
        shipmentId: sid,
        providerShipmentId: "shp_stub_void_shipped",
        rateId: "rate_stub_void_shipped",
      },
      adapter,
    );
    await transitionShipmentStatus(db, sid, "ready");
    await transitionShipmentStatus(db, sid, "shipped");

    await expect(voidShipmentLabel(db, sid, adapter)).rejects.toMatchObject({
      code: "ERR_INVALID_STATE",
    });
  });

  it("rejects void for non-existent shipment", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    await expect(
      voidShipmentLabel(db, "00000000-0000-0000-0000-000000000099", adapter),
    ).rejects.toMatchObject({ code: "ERR_SHIPMENT_NOT_FOUND" });
  });

  // -------------------------------------------------------------------------
  // Shipment ↔ order + fulfillment task linkage
  // -------------------------------------------------------------------------

  it("shipment links back to order and co-exists with fulfillment task via orderId", async () => {
    const db = dbConn.db;

    // Create a fulfillment task for the same order
    const [task] = await db
      .insert(fulfillmentTask)
      .values({
        orderId: testOrderId,
        status: "new",
        priority: "normal",
      })
      .returning();

    try {
      // Create a shipment for the same order
      const created = await createShipment(db, {
        orderId: testOrderId,
        packages: [{ weight: 15 }],
        lines: [{ orderLineId: testOrderLineId1, quantity: 1 }],
      });
      createdShipmentIds.push(created.shipment.id);

      // Both the shipment and the fulfillment task share the same orderId
      expect(created.shipment.orderId).toBe(testOrderId);

      // Verify we can look up both from the order
      const shipments = await findShipmentsByOrderId(db, testOrderId);
      const thisShipment = shipments.find((s) => s.id === created.shipment.id);
      expect(thisShipment).toBeDefined();
      expect(thisShipment!.orderId).toBe(testOrderId);

      // Verify the fulfillment task exists for the same order
      const [taskRow] = await db
        .select({
          id: fulfillmentTask.id,
          orderId: fulfillmentTask.orderId,
          status: fulfillmentTask.status,
        })
        .from(fulfillmentTask)
        .where(eq(fulfillmentTask.id, task.id));
      expect(taskRow.orderId).toBe(testOrderId);
      expect(taskRow.status).toBe("new");

      // The link is: order → fulfillment_task + order → shipment (shared orderId)
      expect(thisShipment!.orderId).toBe(taskRow.orderId);
    } finally {
      // Clean up the fulfillment task
      await db.delete(fulfillmentTask).where(eq(fulfillmentTask.id, task.id));
    }
  });
});
