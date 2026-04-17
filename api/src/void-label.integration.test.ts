import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import {
  shipment,
  shipmentPackage,
  shipmentLine,
  shippingLabelPurchase,
} from "./db/schema/fulfillment.js";
import { eq } from "drizzle-orm";
import {
  createShipment,
  buyShipmentLabel,
  transitionShipmentStatus,
  voidShipmentLabel,
  findShipmentById,
} from "./db/queries/shipment.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("void-label integration (T059a)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  let testOrderId = "";
  let testOrderLineId = "";
  const createdShipmentIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

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
        variantId: "00000000-0000-0000-0000-000000000001",
        skuSnapshot: "KNX-PLATE-001",
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

  it("voids a draft shipment (no label purchased)", async () => {
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
    expect(result.refunded).toBe(false);
    expect(result.refundedCostMinor).toBeNull();
  });

  it("buys a label then voids it with refund", async () => {
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
        providerShipmentId: "shp_stub_void_test",
        rateId: "rate_stub_void_test",
      },
      adapter,
    );
    expect(buyResult.shipment.status).toBe("label_purchased");

    // Void label
    const result = await voidShipmentLabel(db, created.id, adapter);

    expect(result.shipment.status).toBe("voided");
    expect(result.refunded).toBe(true);
    expect(result.refundedCostMinor).toBe(599);
  });

  it("voids from ready status with refund", async () => {
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
        providerShipmentId: "shp_stub_ready_void",
        rateId: "rate_stub_ready_void",
      },
      adapter,
    );
    await transitionShipmentStatus(db, created.id, "ready");

    // Void from ready
    const result = await voidShipmentLabel(db, created.id, adapter);

    expect(result.shipment.status).toBe("voided");
    expect(result.refunded).toBe(true);
    expect(result.refundedCostMinor).toBe(599);
  });

  it("rejects void on shipped shipment", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    // Create shipment + buy label + ready + shipped
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
        providerShipmentId: "shp_stub_shipped_void",
        rateId: "rate_stub_shipped_void",
      },
      adapter,
    );
    await transitionShipmentStatus(db, created.id, "ready");
    await transitionShipmentStatus(db, created.id, "shipped");

    // Verify it's shipped
    const shipped = await findShipmentById(db, created.id);
    expect(shipped?.status).toBe("shipped");

    // Attempt void — should be rejected
    await expect(voidShipmentLabel(db, created.id, adapter)).rejects.toMatchObject({
      code: "ERR_INVALID_STATE",
    });
  });

  it("rejects void on in_transit shipment", async () => {
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
        providerShipmentId: "shp_stub_transit_void",
        rateId: "rate_stub_transit_void",
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
        providerShipmentId: "shp_stub_delivered_void",
        rateId: "rate_stub_delivered_void",
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

  it("rejects void for non-existent shipment", async () => {
    const db = dbConn.db;
    const adapter = createStubShippingAdapter();

    await expect(
      voidShipmentLabel(db, "00000000-0000-0000-0000-000000000099", adapter),
    ).rejects.toMatchObject({
      code: "ERR_SHIPMENT_NOT_FOUND",
    });
  });
});
