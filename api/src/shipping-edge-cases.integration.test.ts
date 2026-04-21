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
import { evidenceRecord } from "./db/schema/evidence.js";
import { eq } from "drizzle-orm";
import {
  createShipment,
  buyShipmentLabel,
  transitionShipmentStatus,
  voidShipmentLabel,
  findShipmentById,
  handleTrackingUpdate,
  storeShipmentEvent,
} from "./db/queries/shipment.js";
import { createStubShippingAdapter, type ShippingAdapter } from "./services/shipping-adapter.js";
import { createAdminAlertService } from "./services/admin-alert.js";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("shipping edge cases (T066d)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  let testOrderId = "";
  let testOrderLineId = "";
  const createdShipmentIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create a test order
    const [newOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T066d-${ts}`,
        email: `t066d-${ts}@test.kanix.dev`,
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
        skuSnapshot: "KNX-EDGE-001",
        titleSnapshot: "Test Edge Case Part",
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
        // Delete evidence records linked to this shipment
        await db.delete(evidenceRecord).where(eq(evidenceRecord.shipmentId, sid));
        await db.delete(shipmentEvent).where(eq(shipmentEvent.shipmentId, sid));
        await db.delete(shippingLabelPurchase).where(eq(shippingLabelPurchase.shipmentId, sid));
        await db.delete(shipmentLine).where(eq(shipmentLine.shipmentId, sid));
        await db.delete(shipmentPackage).where(eq(shipmentPackage.shipmentId, sid));
        await db.delete(shipment).where(eq(shipment.id, sid));
      }
      // Delete evidence records linked to order
      await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, testOrderId));
      await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, testOrderId));
      await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId));
      await db.delete(order).where(eq(order.id, testOrderId));
      await dbConn.close();
    }
  });

  // -------------------------------------------------------------------------
  // FR-E025: Label purchase failure handling
  // -------------------------------------------------------------------------

  describe("label purchase failure (FR-E025)", () => {
    it("returns ERR_LABEL_PURCHASE_FAILED and keeps shipment in label_pending", async () => {
      const db = dbConn.db;

      // Create a failing adapter
      const failingAdapter: ShippingAdapter = {
        ...createStubShippingAdapter(),
        async buyLabel(): Promise<never> {
          throw new Error("EasyPost API error: address verification failed");
        },
      };

      // Create a draft shipment
      const { shipment: created } = await createShipment(db, {
        orderId: testOrderId,
        packages: [{ weight: 10 }],
        lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
      });
      createdShipmentIds.push(created.id);

      // Attempt to buy a label — should fail cleanly
      await expect(
        buyShipmentLabel(
          db,
          {
            shipmentId: created.id,
            providerShipmentId: "shp_fail_test",
            rateId: "rate_fail_test",
          },
          failingAdapter,
        ),
      ).rejects.toMatchObject({
        code: "ERR_LABEL_PURCHASE_FAILED",
        message: "EasyPost API error: address verification failed",
        shipmentStatus: "label_pending",
      });

      // Verify shipment is still in label_pending (not corrupted)
      const after = await findShipmentById(db, created.id);
      expect(after).not.toBeNull();
      expect(after?.status).toBe("label_pending");
    });

    it("keeps shipment in label_pending when already in label_pending", async () => {
      const db = dbConn.db;

      const failingAdapter: ShippingAdapter = {
        ...createStubShippingAdapter(),
        async buyLabel(): Promise<never> {
          throw new Error("Rate expired");
        },
      };

      // Create a shipment and manually transition to label_pending
      const { shipment: created } = await createShipment(db, {
        orderId: testOrderId,
        packages: [{ weight: 10 }],
        lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
      });
      createdShipmentIds.push(created.id);

      await transitionShipmentStatus(db, created.id, "label_pending");

      // Attempt buy — should fail but keep status
      await expect(
        buyShipmentLabel(
          db,
          {
            shipmentId: created.id,
            providerShipmentId: "shp_fail_pending",
            rateId: "rate_fail_pending",
          },
          failingAdapter,
        ),
      ).rejects.toMatchObject({
        code: "ERR_LABEL_PURCHASE_FAILED",
        shipmentStatus: "label_pending",
      });

      const after = await findShipmentById(db, created.id);
      expect(after?.status).toBe("label_pending");
    });
  });

  // -------------------------------------------------------------------------
  // FR-E026: Delivery exception alert + exception recovery
  // -------------------------------------------------------------------------

  describe("delivery exception alert (FR-E026)", () => {
    it("fires admin alert on delivery_exception event", async () => {
      const db = dbConn.db;
      const adapter = createStubShippingAdapter();
      const alertService = createAdminAlertService();

      // Create shipment through to in_transit
      const { shipment: created } = await createShipment(db, {
        orderId: testOrderId,
        packages: [{ weight: 14 }],
        lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
      });
      createdShipmentIds.push(created.id);

      await buyShipmentLabel(
        db,
        {
          shipmentId: created.id,
          providerShipmentId: "shp_exception_test",
          rateId: "rate_exception_test",
        },
        adapter,
      );
      await transitionShipmentStatus(db, created.id, "ready");
      await transitionShipmentStatus(db, created.id, "shipped");
      await transitionShipmentStatus(db, created.id, "in_transit");

      // Fetch updated shipment record for handleTrackingUpdate
      const shipmentRecord = await findShipmentById(db, created.id);
      expect(shipmentRecord).not.toBeNull();
      expect(shipmentRecord?.status).toBe("in_transit");

      // Store the exception event
      await storeShipmentEvent(db, {
        shipmentId: created.id,
        providerEventId: `exc-event-${ts}`,
        status: "failure",
        description: "Package damaged in transit",
        occurredAt: new Date(),
        rawPayloadJson: { status: "failure" },
      });

      // Handle tracking update with adminAlertService
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = await handleTrackingUpdate(db, shipmentRecord!, "failure", alertService);

      expect(result.shipmentTransitioned).toBe(true);

      // Verify shipment is now in exception state
      const afterException = await findShipmentById(db, created.id);
      expect(afterException?.status).toBe("exception");

      // Verify admin alert was fired
      const alerts = alertService.getAlerts();
      expect(alerts.length).toBeGreaterThanOrEqual(1);

      const exceptionAlert = alerts.find((a) => a.type === "delivery_exception");
      expect(exceptionAlert).toBeDefined();
      expect(exceptionAlert?.orderId).toBe(testOrderId);
      expect(exceptionAlert?.message).toContain("Delivery exception");
      expect(exceptionAlert?.details).toHaveProperty("shipmentId", created.id);
      expect(exceptionAlert?.details).toHaveProperty("easypostStatus", "failure");
    });

    it("supports exception → in_transit recovery transition", async () => {
      const db = dbConn.db;
      const adapter = createStubShippingAdapter();
      const alertService = createAdminAlertService();

      // Create shipment through to exception state
      const { shipment: created } = await createShipment(db, {
        orderId: testOrderId,
        packages: [{ weight: 11 }],
        lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
      });
      createdShipmentIds.push(created.id);

      await buyShipmentLabel(
        db,
        {
          shipmentId: created.id,
          providerShipmentId: "shp_recovery_test",
          rateId: "rate_recovery_test",
        },
        adapter,
      );
      await transitionShipmentStatus(db, created.id, "ready");
      await transitionShipmentStatus(db, created.id, "shipped");
      await transitionShipmentStatus(db, created.id, "in_transit");
      await transitionShipmentStatus(db, created.id, "exception");

      // Verify in exception state
      const inException = await findShipmentById(db, created.id);
      expect(inException?.status).toBe("exception");

      // Recover: exception → in_transit via tracking update
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = await handleTrackingUpdate(db, inException!, "in_transit", alertService);

      expect(result.shipmentTransitioned).toBe(true);

      // Verify recovery
      const recovered = await findShipmentById(db, created.id);
      expect(recovered?.status).toBe("in_transit");

      // No new delivery_exception alert since we went to in_transit, not exception
      const alerts = alertService.getAlerts();
      const exceptionAlerts = alerts.filter((a) => a.type === "delivery_exception");
      expect(exceptionAlerts.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // FR-E027: Void-label cost credit
  // -------------------------------------------------------------------------

  describe("void-label cost credit (FR-E027)", () => {
    it("credits label cost when voiding a purchased label", async () => {
      const db = dbConn.db;
      const adapter = createStubShippingAdapter();

      // Create shipment and buy label
      const { shipment: created } = await createShipment(db, {
        orderId: testOrderId,
        packages: [{ weight: 9 }],
        lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
      });
      createdShipmentIds.push(created.id);

      const buyResult = await buyShipmentLabel(
        db,
        {
          shipmentId: created.id,
          providerShipmentId: "shp_credit_test",
          rateId: "rate_credit_test",
        },
        adapter,
      );
      expect(buyResult.purchase.costMinor).toBe(599);

      // Void the label
      const result = await voidShipmentLabel(db, created.id, adapter);

      expect(result.shipment.status).toBe("voided");
      expect(result.refunded).toBe(true);
      expect(result.refundedCostMinor).toBe(599);
      expect(result.labelCostCredited).toBe(true);
    });

    it("does not credit when voiding a draft (no label purchased)", async () => {
      const db = dbConn.db;
      const adapter = createStubShippingAdapter();

      const { shipment: created } = await createShipment(db, {
        orderId: testOrderId,
        packages: [{ weight: 7 }],
        lines: [{ orderLineId: testOrderLineId, quantity: 1 }],
      });
      createdShipmentIds.push(created.id);

      const result = await voidShipmentLabel(db, created.id, adapter);

      expect(result.shipment.status).toBe("voided");
      expect(result.refunded).toBe(false);
      expect(result.refundedCostMinor).toBeNull();
      expect(result.labelCostCredited).toBe(false);
    });

    it("credits label cost when voiding from ready state", async () => {
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
          providerShipmentId: "shp_ready_credit",
          rateId: "rate_ready_credit",
        },
        adapter,
      );
      await transitionShipmentStatus(db, created.id, "ready");

      const result = await voidShipmentLabel(db, created.id, adapter);

      expect(result.shipment.status).toBe("voided");
      expect(result.refunded).toBe(true);
      expect(result.refundedCostMinor).toBe(599);
      expect(result.labelCostCredited).toBe(true);
    });
  });
});
