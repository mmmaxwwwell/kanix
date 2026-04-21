import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  shipment,
  shipmentPackage,
  shipmentLine,
  shippingLabelPurchase,
  shipmentEvent,
} from "./db/schema/fulfillment.js";
import { eq } from "drizzle-orm";
import {
  createShipment,
  buyShipmentLabel,
  transitionShipmentStatus,
  voidShipmentLabel,
  findShipmentById,
  findLabelPurchasesByShipmentId,
  findShipmentEventsByShipmentId,
} from "./db/queries/shipment.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { ShippingAdapter } from "./services/shipping-adapter.js";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("void-label integration (T059a)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  let testProductId = "";
  let testVariantId = "";
  let testOrderId = "";
  let testOrderLineId = "";
  const createdShipmentIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create a product + variant (FK required by order_line.variant_id)
    const [prod] = await db
      .insert(product)
      .values({
        slug: `void-label-test-${ts}`,
        title: "Void Label Test Product",
        status: "active",
      })
      .returning();
    testProductId = prod.id;

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `KNX-VL-${ts}`,
        title: "Test Plate",
        priceMinor: 5000,
        status: "active",
      })
      .returning();
    testVariantId = variant.id;

    // Create a test order (confirmed, paid)
    const [newOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T059a-${ts}`,
        email: `t059a-${ts}@test.kanix.dev`,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "queued",
        shippingStatus: "not_shipped",
        subtotalMinor: 5000,
        taxMinor: 250,
        shippingMinor: 599,
        totalMinor: 5849,
        placedAt: new Date(),
      })
      .returning();
    testOrderId = newOrder.id;

    // Create an order line
    const [line] = await db
      .insert(orderLine)
      .values({
        orderId: testOrderId,
        variantId: testVariantId,
        skuSnapshot: `KNX-VL-${ts}`,
        titleSnapshot: "Test Plate",
        quantity: 1,
        unitPriceMinor: 5000,
        totalMinor: 5000,
      })
      .returning();
    testOrderLineId = line.id;
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
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
      await db.delete(productVariant).where(eq(productVariant.id, testVariantId));
      await db.delete(product).where(eq(product.id, testProductId));
      await dbConn.close();
    }
  });

  // -------------------------------------------------------------------------
  // Happy path: void within carrier window
  // -------------------------------------------------------------------------

  it("voids a draft shipment (no label purchased) — no refund", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 10 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    const result = await voidShipmentLabel(db, created.id, adapter);

    expect(result.shipment.status).toBe("voided");
    expect(result.shipment.id).toBe(created.id);
    expect(result.shipment.orderId).toBe(testOrderId);
    expect(result.refunded).toBe(false);
    expect(result.refundedCostMinor).toBeNull();
    expect(result.labelCostCredited).toBe(false);

    // Verify DB state
    const fetched = await findShipmentById(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("voided");
  });

  it("buys a label then voids within carrier window — refund granted", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create shipment
    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 12 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    // Buy label
    const buyResult = await buyShipmentLabel(
      db,
      {
        shipmentId: created.id,
        providerShipmentId: `shp_stub_void_${ts}_1`,
        rateId: `rate_stub_void_${ts}_1`,
      },
      adapter,
    );
    expect(buyResult.shipment.status).toBe("label_purchased");
    expect(buyResult.purchase.costMinor).toBe(599);

    // Void label — within carrier window (stub adapter returns refunded: true)
    const result = await voidShipmentLabel(db, created.id, adapter);

    expect(result.shipment.status).toBe("voided");
    expect(result.refunded).toBe(true);
    expect(result.refundedCostMinor).toBe(599);
    expect(result.labelCostCredited).toBe(true);

    // Verify refund accounting: purchase record still exists with original cost
    const purchases = await findLabelPurchasesByShipmentId(db, created.id);
    expect(purchases).toHaveLength(1);
    expect(purchases[0].costMinor).toBe(599);
    expect(purchases[0].currency).toBe("USD");

    // Verify audit event was stored
    const events = await findShipmentEventsByShipmentId(db, created.id);
    const voidEvent = events.find((e) => e.status === "voided");
    expect(voidEvent).toBeDefined();
    expect(voidEvent!.description).toContain("refund");
    expect(voidEvent!.description).toContain("599");
  });

  it("voids from ready status — refund granted with correct accounting", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create shipment + buy label + transition to ready
    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 8 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    await buyShipmentLabel(
      db,
      {
        shipmentId: created.id,
        providerShipmentId: `shp_stub_ready_${ts}`,
        rateId: `rate_stub_ready_${ts}`,
      },
      adapter,
    );
    await transitionShipmentStatus(db, created.id, "ready");

    // Verify ready status before void
    const ready = await findShipmentById(db, created.id);
    expect(ready!.status).toBe("ready");

    // Void from ready
    const result = await voidShipmentLabel(db, created.id, adapter);

    expect(result.shipment.status).toBe("voided");
    expect(result.refunded).toBe(true);
    expect(result.refundedCostMinor).toBe(599);
    expect(result.labelCostCredited).toBe(true);

    // Verify purchase cost matches refunded amount
    const purchases = await findLabelPurchasesByShipmentId(db, created.id);
    expect(purchases).toHaveLength(1);
    const totalPurchaseCost = purchases.reduce((sum, p) => sum + p.costMinor, 0);
    expect(result.refundedCostMinor).toBe(totalPurchaseCost);
  });

  // -------------------------------------------------------------------------
  // Carrier window expired: adapter rejects the void
  // -------------------------------------------------------------------------

  it("rejects void when carrier window has expired (adapter throws)", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create shipment + buy label
    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 7 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    await buyShipmentLabel(
      db,
      {
        shipmentId: created.id,
        providerShipmentId: `shp_stub_expired_${ts}`,
        rateId: `rate_stub_expired_${ts}`,
      },
      adapter,
    );

    // Create a custom adapter that rejects void (carrier window expired)
    const expiredAdapter: ShippingAdapter = {
      ...adapter,
      async voidLabel(): Promise<{ refunded: boolean }> {
        throw new Error("Carrier void window has expired");
      },
    };

    // Void should be rejected with ERR_VOID_WINDOW_EXPIRED
    await expect(voidShipmentLabel(db, created.id, expiredAdapter)).rejects.toMatchObject({
      code: "ERR_VOID_WINDOW_EXPIRED",
      shipmentId: created.id,
    });

    // Shipment should NOT have transitioned — still label_purchased
    const afterAttempt = await findShipmentById(db, created.id);
    expect(afterAttempt!.status).toBe("label_purchased");
  });

  it("carrier window expired adapter — no refund but void still succeeds when adapter returns refunded:false", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create shipment + buy label
    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 9 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    await buyShipmentLabel(
      db,
      {
        shipmentId: created.id,
        providerShipmentId: `shp_stub_norefund_${ts}`,
        rateId: `rate_stub_norefund_${ts}`,
      },
      adapter,
    );

    // Custom adapter: void succeeds but no refund (past refund window)
    const noRefundAdapter: ShippingAdapter = {
      ...adapter,
      async voidLabel(): Promise<{ refunded: boolean }> {
        return { refunded: false };
      },
    };

    const result = await voidShipmentLabel(db, created.id, noRefundAdapter);

    expect(result.shipment.status).toBe("voided");
    expect(result.refunded).toBe(false);
    expect(result.refundedCostMinor).toBeNull();
    expect(result.labelCostCredited).toBe(false);

    // Purchase record still exists (cost was incurred, not refunded)
    const purchases = await findLabelPurchasesByShipmentId(db, created.id);
    expect(purchases).toHaveLength(1);
    expect(purchases[0].costMinor).toBe(599);

    // Audit event records no-refund void
    const events = await findShipmentEventsByShipmentId(db, created.id);
    const voidEvent = events.find((e) => e.status === "voided");
    expect(voidEvent).toBeDefined();
    expect(voidEvent!.description).toContain("no refund");
  });

  // -------------------------------------------------------------------------
  // Already-scanned label: shipment has been handed to carrier
  // -------------------------------------------------------------------------

  it("rejects void on shipped shipment (already scanned by carrier)", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 6 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    await buyShipmentLabel(
      db,
      {
        shipmentId: created.id,
        providerShipmentId: `shp_stub_shipped_${ts}`,
        rateId: `rate_stub_shipped_${ts}`,
      },
      adapter,
    );
    await transitionShipmentStatus(db, created.id, "ready");
    await transitionShipmentStatus(db, created.id, "shipped");

    const shipped = await findShipmentById(db, created.id);
    expect(shipped!.status).toBe("shipped");

    await expect(voidShipmentLabel(db, created.id, adapter)).rejects.toMatchObject({
      code: "ERR_INVALID_STATE",
      message: expect.stringContaining("shipped"),
    });

    // Status unchanged
    const after = await findShipmentById(db, created.id);
    expect(after!.status).toBe("shipped");
  });

  it("rejects void on in_transit shipment (already scanned)", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 5 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    await buyShipmentLabel(
      db,
      {
        shipmentId: created.id,
        providerShipmentId: `shp_stub_transit_${ts}`,
        rateId: `rate_stub_transit_${ts}`,
      },
      adapter,
    );
    await transitionShipmentStatus(db, created.id, "ready");
    await transitionShipmentStatus(db, created.id, "shipped");
    await transitionShipmentStatus(db, created.id, "in_transit");

    await expect(voidShipmentLabel(db, created.id, adapter)).rejects.toMatchObject({
      code: "ERR_INVALID_STATE",
    });
  });

  it("rejects void on delivered shipment", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 4 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    await buyShipmentLabel(
      db,
      {
        shipmentId: created.id,
        providerShipmentId: `shp_stub_delivered_${ts}`,
        rateId: `rate_stub_delivered_${ts}`,
      },
      adapter,
    );
    await transitionShipmentStatus(db, created.id, "ready");
    await transitionShipmentStatus(db, created.id, "shipped");
    await transitionShipmentStatus(db, created.id, "in_transit");
    await transitionShipmentStatus(db, created.id, "delivered");

    await expect(voidShipmentLabel(db, created.id, adapter)).rejects.toMatchObject({
      code: "ERR_INVALID_STATE",
    });
  });

  // -------------------------------------------------------------------------
  // Refund accounting: verify cost math
  // -------------------------------------------------------------------------

  it("refundedCostMinor equals total label purchase cost", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 11 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    const buyResult = await buyShipmentLabel(
      db,
      {
        shipmentId: created.id,
        providerShipmentId: `shp_stub_acct_${ts}`,
        rateId: `rate_stub_acct_${ts}`,
      },
      adapter,
    );

    // Verify pre-void: purchase exists with known cost
    const prePurchases = await findLabelPurchasesByShipmentId(db, created.id);
    expect(prePurchases).toHaveLength(1);
    const expectedCost = prePurchases[0].costMinor;
    expect(expectedCost).toBe(buyResult.purchase.costMinor);
    expect(expectedCost).toBeGreaterThan(0);

    // Void
    const result = await voidShipmentLabel(db, created.id, adapter);
    expect(result.refunded).toBe(true);
    expect(result.refundedCostMinor).toBe(expectedCost);
    expect(result.labelCostCredited).toBe(true);

    // Post-void: purchase record preserved for accounting history
    const postPurchases = await findLabelPurchasesByShipmentId(db, created.id);
    expect(postPurchases).toHaveLength(1);
    expect(postPurchases[0].costMinor).toBe(expectedCost);
  });

  // -------------------------------------------------------------------------
  // Audit trail: shipment event for each void
  // -------------------------------------------------------------------------

  it("stores a shipment event audit entry on successful void", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 3 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    // Void a draft (no label) — should still have an audit event
    await voidShipmentLabel(db, created.id, adapter);

    const events = await findShipmentEventsByShipmentId(db, created.id);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const voidEvent = events.find((e) => e.status === "voided");
    expect(voidEvent).toBeDefined();
    expect(voidEvent!.shipmentId).toBe(created.id);
    expect(voidEvent!.occurredAt).toBeInstanceOf(Date);
    expect(voidEvent!.description).toContain("no refund");
  });

  it("stores audit event with refund details when label was refunded", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 13 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    await buyShipmentLabel(
      db,
      {
        shipmentId: created.id,
        providerShipmentId: `shp_stub_audit_${ts}`,
        rateId: `rate_stub_audit_${ts}`,
      },
      adapter,
    );

    await voidShipmentLabel(db, created.id, adapter);

    const events = await findShipmentEventsByShipmentId(db, created.id);
    const voidEvent = events.find((e) => e.status === "voided");
    expect(voidEvent).toBeDefined();
    expect(voidEvent!.description).toContain("refund");
    expect(voidEvent!.description).toContain("599");
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("rejects void for non-existent shipment", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    await expect(
      voidShipmentLabel(db, "00000000-0000-0000-0000-000000000099", adapter),
    ).rejects.toMatchObject({
      code: "ERR_SHIPMENT_NOT_FOUND",
    });
  });

  it("rejects void on already-voided shipment (idempotency)", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    const { shipment: created } = await createShipment(db, {
      orderId: testOrderId,
      packages: [{ weight: 2 }],
      lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
    });
    createdShipmentIds.push(created.id);

    // First void succeeds
    const result = await voidShipmentLabel(db, created.id, adapter);
    expect(result.shipment.status).toBe("voided");

    // Second void attempt rejects (voided is not in VOIDABLE_STATUSES)
    await expect(voidShipmentLabel(db, created.id, adapter)).rejects.toMatchObject({
      code: "ERR_INVALID_STATE",
      message: expect.stringContaining("voided"),
    });
  });
});
