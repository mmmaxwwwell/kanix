import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { shipment, shipmentPackage, shipmentLine, shipmentEvent } from "./db/schema/fulfillment.js";
import { product, productVariant } from "./db/schema/catalog.js";
import { eq, sql } from "drizzle-orm";
import {
  findShipmentById,
  findShipmentEventsByShipmentId,
  storeShipmentEvent,
  hasShipmentEventBeenProcessed,
  findShipmentByTrackingNumber,
  handleTrackingUpdate,
  mapEasyPostStatusToShipmentStatus,
  mapEasyPostStatusToOrderShippingStatus,
} from "./db/queries/shipment.js";
import { findOrderById } from "./db/queries/order-state-machine.js";
import { createHmac } from "node:crypto";
import { requireDatabaseUrl } from "./test-helpers.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

const DATABASE_URL = requireDatabaseUrl();

const EP_WEBHOOK_SECRET = "ep_test_webhook_secret_for_tests";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generate a signed EasyPost webhook payload for testing.
 */
function generateEasyPostWebhookPayload(
  eventId: string,
  description: string,
  trackerData: {
    id: string;
    tracking_code: string;
    status: string;
    tracking_details?: {
      status: string;
      message: string;
      datetime: string;
      tracking_location?: { city: string | null; state: string | null };
    }[];
  },
  secret: string,
): { body: string; signature: string } {
  const payload = JSON.stringify({
    id: eventId,
    object: "Event",
    description,
    result: trackerData,
    created_at: new Date().toISOString(),
    mode: "test",
  });

  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  const signature = `hmac-sha256-hex=${sig}`;

  return { body: payload, signature };
}

describe("EasyPost tracking webhook (T059)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  let testOrderId = "";
  let testProductId = "";
  let testVariantId = "";
  const trackingNumber = `EP-TRACK-${ts}`;
  let testShipmentId = "";

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create real product + variant (FK constraint on order_line.variant_id)
    const [prod] = await db
      .insert(product)
      .values({
        slug: `ep-webhook-test-${ts}`,
        title: `EP Webhook Test Product ${ts}`,
        status: "active",
      })
      .returning();
    testProductId = prod.id;

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `KNX-EP-${ts}`,
        title: `EP Variant ${ts}`,
        priceMinor: 5000,
        status: "active",
      })
      .returning();
    testVariantId = variant.id;

    // Create a test order (confirmed, paid, shipped)
    const [newOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T059-${ts}`,
        email: `t059-${ts}@test.kanix.dev`,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "queued",
        shippingStatus: "shipped",
        subtotalMinor: 5000,
        taxMinor: 250,
        shippingMinor: 599,
        totalMinor: 5849,
        placedAt: new Date(),
      })
      .returning();
    testOrderId = newOrder.id;

    // Create order line with real variant
    const [line] = await db
      .insert(orderLine)
      .values({
        orderId: testOrderId,
        variantId: testVariantId,
        skuSnapshot: `KNX-EP-${ts}`,
        titleSnapshot: `EP Variant ${ts}`,
        quantity: 1,
        unitPriceMinor: 5000,
        totalMinor: 5000,
      })
      .returning();

    // Create a shipped shipment with tracking number
    const [newShipment] = await db
      .insert(shipment)
      .values({
        orderId: testOrderId,
        shipmentNumber: `SHP-KNX-T059-${ts}`,
        status: "shipped",
        carrier: "USPS",
        serviceLevel: "Priority",
        trackingNumber,
        shippedAt: new Date(),
      })
      .returning();
    testShipmentId = newShipment.id;

    // Create shipment package
    await db.insert(shipmentPackage).values({
      shipmentId: testShipmentId,
      weight: "16.0",
      packageType: "parcel",
    });

    // Create shipment line
    await db.insert(shipmentLine).values({
      shipmentId: testShipmentId,
      orderLineId: line.id,
      quantity: 1,
    });
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      try {
        // evidence_record has immutability triggers; disable before cleanup
        await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);
        await db.execute(
          sql`DELETE FROM evidence_record WHERE shipment_id = ${testShipmentId}`,
        );
        await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);
      } catch {
        // Best-effort — evidence may not exist
      }
      await db.delete(shipmentEvent).where(eq(shipmentEvent.shipmentId, testShipmentId));
      await db.delete(shipmentLine).where(eq(shipmentLine.shipmentId, testShipmentId));
      await db.delete(shipmentPackage).where(eq(shipmentPackage.shipmentId, testShipmentId));
      await db.delete(shipment).where(eq(shipment.id, testShipmentId));
      await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, testOrderId));
      await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId));
      await db.delete(order).where(eq(order.id, testOrderId));
      await db.delete(productVariant).where(eq(productVariant.id, testVariantId));
      await db.delete(product).where(eq(product.id, testProductId));
      await dbConn.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Unit tests for status mapping
  // ---------------------------------------------------------------------------

  it("maps EasyPost statuses to shipment statuses correctly", () => {
    expect(mapEasyPostStatusToShipmentStatus("in_transit")).toBe("in_transit");
    expect(mapEasyPostStatusToShipmentStatus("out_for_delivery")).toBe("in_transit");
    expect(mapEasyPostStatusToShipmentStatus("delivered")).toBe("delivered");
    expect(mapEasyPostStatusToShipmentStatus("return_to_sender")).toBe("returned");
    expect(mapEasyPostStatusToShipmentStatus("failure")).toBe("exception");
    expect(mapEasyPostStatusToShipmentStatus("error")).toBe("exception");
    expect(mapEasyPostStatusToShipmentStatus("pre_transit")).toBeNull();
    expect(mapEasyPostStatusToShipmentStatus("unknown")).toBeNull();
  });

  it("maps EasyPost statuses to order shipping statuses correctly", () => {
    expect(mapEasyPostStatusToOrderShippingStatus("in_transit")).toBe("in_transit");
    expect(mapEasyPostStatusToOrderShippingStatus("out_for_delivery")).toBe("out_for_delivery");
    expect(mapEasyPostStatusToOrderShippingStatus("delivered")).toBe("delivered");
    expect(mapEasyPostStatusToOrderShippingStatus("return_to_sender")).toBe("returned");
    expect(mapEasyPostStatusToOrderShippingStatus("failure")).toBe("delivery_exception");
    expect(mapEasyPostStatusToOrderShippingStatus("error")).toBe("delivery_exception");
    expect(mapEasyPostStatusToOrderShippingStatus("pre_transit")).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Integration tests: query layer
  // ---------------------------------------------------------------------------

  it("finds shipment by tracking number with correct fields", async () => {
    const db = dbConn.db;
    const found = await findShipmentByTrackingNumber(db, trackingNumber);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(testShipmentId);
    expect(found!.trackingNumber).toBe(trackingNumber);
    expect(found!.carrier).toBe("USPS");
    expect(found!.orderId).toBe(testOrderId);
    expect(found!.status).toBe("shipped");
  });

  it("returns null for unknown tracking number", async () => {
    const db = dbConn.db;
    const found = await findShipmentByTrackingNumber(db, "NONEXISTENT-TRACKING");
    expect(found).toBeNull();
  });

  it("stores a shipment event with correct fields and timestamp", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_store_${ts}`;
    const eventTime = new Date("2026-04-21T10:00:00Z");
    const result = await storeShipmentEvent(db, {
      shipmentId: testShipmentId,
      providerEventId: eventId,
      status: "in_transit",
      description: "Package picked up by carrier",
      occurredAt: eventTime,
      rawPayloadJson: { test: true, trackingCode: trackingNumber },
    });
    expect(result.id).toMatch(UUID_RE);

    // Verify idempotency check
    const processed = await hasShipmentEventBeenProcessed(db, eventId);
    expect(processed).toBe(true);

    // Unprocessed event
    const notProcessed = await hasShipmentEventBeenProcessed(db, "evt_never_seen");
    expect(notProcessed).toBe(false);
  });

  it("finds shipment events by shipment ID with concrete values", async () => {
    const db = dbConn.db;
    const events = await findShipmentEventsByShipmentId(db, testShipmentId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events.find((e) => e.providerEventId === `evt_test_store_${ts}`);
    expect(ev).not.toBeNull();
    expect(ev!.status).toBe("in_transit");
    expect(ev!.description).toBe("Package picked up by carrier");
    expect(ev!.shipmentId).toBe(testShipmentId);
    // Verify timestamp was stored correctly
    expect(ev!.occurredAt).toBeInstanceOf(Date);
    expect(ev!.occurredAt.toISOString()).toBe("2026-04-21T10:00:00.000Z");
  });

  // ---------------------------------------------------------------------------
  // Integration tests: tracking update handler
  // ---------------------------------------------------------------------------

  it("handles in_transit tracking update: shipment + order status", async () => {
    const db = dbConn.db;

    const result = await handleTrackingUpdate(
      db,
      { id: testShipmentId, orderId: testOrderId, status: "shipped" } as Parameters<
        typeof handleTrackingUpdate
      >[1],
      "in_transit",
    );

    expect(result.shipmentTransitioned).toBe(true);
    expect(result.orderTransitioned).toBe(true);
    expect(result.orderCompleted).toBe(false);

    // Verify shipment status
    const updatedShipment = await findShipmentById(db, testShipmentId);
    expect(updatedShipment!.status).toBe("in_transit");

    // Verify order shipping_status
    const updatedOrder = await findOrderById(db, testOrderId);
    expect(updatedOrder!.shippingStatus).toBe("in_transit");
  });

  it("handles delivered tracking update: shipment + order status + deliveredAt timestamp", async () => {
    const db = dbConn.db;

    const beforeUpdate = new Date();
    const result = await handleTrackingUpdate(
      db,
      { id: testShipmentId, orderId: testOrderId, status: "in_transit" } as Parameters<
        typeof handleTrackingUpdate
      >[1],
      "delivered",
    );

    expect(result.shipmentTransitioned).toBe(true);
    expect(result.orderTransitioned).toBe(true);

    // Verify shipment status
    const updatedShipment = await findShipmentById(db, testShipmentId);
    expect(updatedShipment!.status).toBe("delivered");

    // Verify deliveredAt timestamp was set (not in findShipmentById select, query raw table)
    const [rawShipment] = await db
      .select({ deliveredAt: shipment.deliveredAt })
      .from(shipment)
      .where(eq(shipment.id, testShipmentId));
    expect(rawShipment.deliveredAt).toBeInstanceOf(Date);
    expect(rawShipment.deliveredAt!.getTime()).toBeGreaterThanOrEqual(beforeUpdate.getTime() - 1000);

    // Verify order shipping_status
    const updatedOrder = await findOrderById(db, testOrderId);
    expect(updatedOrder!.shippingStatus).toBe("delivered");
  });

  it("ignores pre_transit events (no status change)", async () => {
    const db = dbConn.db;

    const result = await handleTrackingUpdate(
      db,
      { id: testShipmentId, orderId: testOrderId, status: "delivered" } as Parameters<
        typeof handleTrackingUpdate
      >[1],
      "pre_transit",
    );

    expect(result.shipmentTransitioned).toBe(false);
    expect(result.orderTransitioned).toBe(false);
    expect(result.orderCompleted).toBe(false);

    // Verify shipment status unchanged
    const unchangedShipment = await findShipmentById(db, testShipmentId);
    expect(unchangedShipment!.status).toBe("delivered");
  });

  it("handles out-of-order events (in_transit after delivered) without regression", async () => {
    const db = dbConn.db;

    // Shipment is "delivered", now we receive a late "in_transit" event
    const result = await handleTrackingUpdate(
      db,
      { id: testShipmentId, orderId: testOrderId, status: "delivered" } as Parameters<
        typeof handleTrackingUpdate
      >[1],
      "in_transit",
    );

    // in_transit maps to shipment status "in_transit", but delivered→in_transit is invalid
    // so the transition is silently skipped (isTransitionError caught)
    expect(result.shipmentTransitioned).toBe(false);
    expect(result.orderTransitioned).toBe(false);

    // Verify statuses remain at "delivered" — no regression
    const unchangedShipment = await findShipmentById(db, testShipmentId);
    expect(unchangedShipment!.status).toBe("delivered");

    const unchangedOrder = await findOrderById(db, testOrderId);
    expect(unchangedOrder!.shippingStatus).toBe("delivered");
  });

  it("handles duplicate/idempotent transitions gracefully", async () => {
    const db = dbConn.db;

    // Already delivered - sending delivered again should not throw
    const result = await handleTrackingUpdate(
      db,
      { id: testShipmentId, orderId: testOrderId, status: "delivered" } as Parameters<
        typeof handleTrackingUpdate
      >[1],
      "delivered",
    );

    expect(result.shipmentTransitioned).toBe(false);
    expect(result.orderTransitioned).toBe(false);

    // Status still delivered
    const unchangedShipment = await findShipmentById(db, testShipmentId);
    expect(unchangedShipment!.status).toBe("delivered");
  });

  // ---------------------------------------------------------------------------
  // Integration tests: webhook payload generation helper
  // ---------------------------------------------------------------------------

  it("generates valid EasyPost webhook payload with signature", () => {
    const { body, signature } = generateEasyPostWebhookPayload(
      "evt_test_1",
      "tracker.updated",
      {
        id: "trk_test_1",
        tracking_code: "TEST123",
        status: "in_transit",
        tracking_details: [
          {
            status: "in_transit",
            message: "Package in transit",
            datetime: new Date().toISOString(),
            tracking_location: { city: "Austin", state: "TX" },
          },
        ],
      },
      EP_WEBHOOK_SECRET,
    );

    const parsed = JSON.parse(body);
    expect(parsed.id).toBe("evt_test_1");
    expect(parsed.object).toBe("Event");
    expect(parsed.description).toBe("tracker.updated");
    expect(parsed.result.tracking_code).toBe("TEST123");
    expect(parsed.result.status).toBe("in_transit");
    expect(parsed.result.tracking_details).toHaveLength(1);
    expect(parsed.result.tracking_details[0].message).toBe("Package in transit");

    const expectedSig = createHmac("sha256", EP_WEBHOOK_SECRET).update(body).digest("hex");
    const sigValue = signature.replace("hmac-sha256-hex=", "");
    expect(sigValue).toBe(expectedSig);
  });
});

// ---------------------------------------------------------------------------
// HTTP-level webhook tests (server-based)
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";

function createStubTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 0, calculationId: null };
    },
  };
}

function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      return { id: `pi_test_ep_${Date.now()}`, clientSecret: `pi_secret_${Date.now()}` };
    },
    async createRefund() {
      return { id: `re_test_ep_${Date.now()}`, status: "succeeded" };
    },
  };
}

describe("EasyPost webhook HTTP handler (T059)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts2 = Date.now() + 1;
  let testOrderId2 = "";
  let testShipmentId2 = "";
  let testProductId2 = "";
  let testVariantId2 = "";
  const trackingNumber2 = `EP-HTTP-TRACK-${ts2}`;

  beforeAll(async () => {
    ts_ = await createTestServer({
      skipListen: true,
      configOverrides: {
        STRIPE_WEBHOOK_SECRET: "whsec_test_xxx",
        EASYPOST_WEBHOOK_SECRET: EP_WEBHOOK_SECRET,
      },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

    // Create real product + variant (FK constraint on order_line.variant_id)
    const [prod] = await db
      .insert(product)
      .values({
        slug: `ep-http-test-${ts2}`,
        title: `EP HTTP Test Product ${ts2}`,
        status: "active",
      })
      .returning();
    testProductId2 = prod.id;

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: testProductId2,
        sku: `KNX-EPH-${ts2}`,
        title: `EP HTTP Variant ${ts2}`,
        priceMinor: 3000,
        status: "active",
      })
      .returning();
    testVariantId2 = variant.id;

    // Seed test data: order + shipment in "shipped" status
    const [newOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T059H-${ts2}`,
        email: `t059h-${ts2}@test.kanix.dev`,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "queued",
        shippingStatus: "shipped",
        subtotalMinor: 3000,
        taxMinor: 150,
        shippingMinor: 599,
        totalMinor: 3749,
        placedAt: new Date(),
      })
      .returning();
    testOrderId2 = newOrder.id;

    const [line] = await db
      .insert(orderLine)
      .values({
        orderId: testOrderId2,
        variantId: testVariantId2,
        skuSnapshot: `KNX-EPH-${ts2}`,
        titleSnapshot: `EP HTTP Variant ${ts2}`,
        quantity: 1,
        unitPriceMinor: 3000,
        totalMinor: 3000,
      })
      .returning();

    const [newShipment] = await db
      .insert(shipment)
      .values({
        orderId: testOrderId2,
        shipmentNumber: `SHP-KNX-T059H-${ts2}`,
        status: "shipped",
        carrier: "USPS",
        serviceLevel: "Priority",
        trackingNumber: trackingNumber2,
        shippedAt: new Date(),
      })
      .returning();
    testShipmentId2 = newShipment.id;

    await db.insert(shipmentPackage).values({
      shipmentId: testShipmentId2,
      weight: "12.0",
      packageType: "parcel",
    });

    await db.insert(shipmentLine).values({
      shipmentId: testShipmentId2,
      orderLineId: line.id,
      quantity: 1,
    });
  });

  afterAll(async () => {
    if (dbConn) {
      try {
        const db = dbConn.db;
        // evidence_record has immutability triggers; disable before cleanup
        await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);
        await db.execute(
          sql`DELETE FROM evidence_record WHERE shipment_id = ${testShipmentId2}`,
        );
        await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);
        await db.delete(shipmentEvent).where(eq(shipmentEvent.shipmentId, testShipmentId2));
        await db.delete(shipmentLine).where(eq(shipmentLine.shipmentId, testShipmentId2));
        await db.delete(shipmentPackage).where(eq(shipmentPackage.shipmentId, testShipmentId2));
        await db.delete(shipment).where(eq(shipment.id, testShipmentId2));
        await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, testOrderId2));
        await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId2));
        await db.delete(order).where(eq(order.id, testOrderId2));
        await db.delete(productVariant).where(eq(productVariant.id, testVariantId2));
        await db.delete(product).where(eq(product.id, testProductId2));
      } catch {
        // Best-effort cleanup
      }
    }
    await stopTestServer(ts_);
  });

  it("rejects webhook with missing signature", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/easypost",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ id: "evt_no_sig", description: "tracker.updated", result: {} }),
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_MISSING_SIGNATURE");
  });

  it("rejects webhook with invalid signature", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/easypost",
      headers: {
        "content-type": "application/json",
        "x-hmac-signature":
          "hmac-sha256-hex=0000000000000000000000000000000000000000000000000000000000000000",
      },
      payload: JSON.stringify({
        id: "evt_bad_sig",
        description: "tracker.updated",
        result: {},
      }),
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_INVALID_SIGNATURE");
  });

  it("processes tracker.updated in_transit: shipment + order transitions + event stored with timestamp", async () => {
    const eventId = `evt_http_in_transit_${ts2}`;
    const eventDatetime = "2026-04-21T14:30:00.000Z";
    const { body, signature } = generateEasyPostWebhookPayload(
      eventId,
      "tracker.updated",
      {
        id: `trk_http_${ts2}`,
        tracking_code: trackingNumber2,
        status: "in_transit",
        tracking_details: [
          {
            status: "in_transit",
            message: "In transit to destination",
            datetime: eventDatetime,
            tracking_location: { city: "Dallas", state: "TX" },
          },
        ],
      },
      EP_WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/easypost",
      headers: {
        "content-type": "application/json",
        "x-hmac-signature": signature,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const resBody = JSON.parse(res.body);
    expect(resBody.received).toBe(true);

    // Verify shipment status updated
    const db = dbConn.db;
    const updatedShipment = await findShipmentById(db, testShipmentId2);
    expect(updatedShipment!.status).toBe("in_transit");
    expect(updatedShipment!.carrier).toBe("USPS");

    // Verify order shipping_status updated
    const updatedOrder = await findOrderById(db, testOrderId2);
    expect(updatedOrder!.shippingStatus).toBe("in_transit");

    // Verify event stored with correct timestamp and payload
    const events = await findShipmentEventsByShipmentId(db, testShipmentId2);
    const stored = events.find((e) => e.providerEventId === eventId);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("in_transit");
    expect(stored!.description).toBe("In transit to destination");
    expect(stored!.occurredAt).toBeInstanceOf(Date);
    expect(stored!.occurredAt.toISOString()).toBe(eventDatetime);
  });

  it("returns duplicate for already-processed event", async () => {
    const eventId = `evt_http_in_transit_${ts2}`; // Same as above
    const { body, signature } = generateEasyPostWebhookPayload(
      eventId,
      "tracker.updated",
      {
        id: `trk_http_${ts2}`,
        tracking_code: trackingNumber2,
        status: "in_transit",
        tracking_details: [],
      },
      EP_WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/easypost",
      headers: {
        "content-type": "application/json",
        "x-hmac-signature": signature,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const resBody = JSON.parse(res.body);
    expect(resBody.received).toBe(true);
    expect(resBody.duplicate).toBe(true);
  });

  it("processes tracker.updated delivered: shipment + order + deliveredAt timestamp", async () => {
    const eventId = `evt_http_delivered_${ts2}`;
    const deliveredDatetime = "2026-04-21T18:00:00.000Z";
    const { body, signature } = generateEasyPostWebhookPayload(
      eventId,
      "tracker.updated",
      {
        id: `trk_http_${ts2}`,
        tracking_code: trackingNumber2,
        status: "delivered",
        tracking_details: [
          {
            status: "delivered",
            message: "Delivered to front door",
            datetime: deliveredDatetime,
            tracking_location: { city: "Houston", state: "TX" },
          },
        ],
      },
      EP_WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/easypost",
      headers: {
        "content-type": "application/json",
        "x-hmac-signature": signature,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);

    const db = dbConn.db;
    const updatedShipment = await findShipmentById(db, testShipmentId2);
    expect(updatedShipment!.status).toBe("delivered");

    // Verify deliveredAt timestamp set (query raw table)
    const [rawShipment] = await db
      .select({ deliveredAt: shipment.deliveredAt })
      .from(shipment)
      .where(eq(shipment.id, testShipmentId2));
    expect(rawShipment.deliveredAt).toBeInstanceOf(Date);

    const updatedOrder = await findOrderById(db, testOrderId2);
    expect(updatedOrder!.shippingStatus).toBe("delivered");

    // Verify event stored with correct timestamp
    const events = await findShipmentEventsByShipmentId(db, testShipmentId2);
    const stored = events.find((e) => e.providerEventId === eventId);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("delivered");
    expect(stored!.description).toBe("Delivered to front door");
    expect(stored!.occurredAt.toISOString()).toBe(deliveredDatetime);
  });

  it("handles out-of-order event via HTTP (in_transit after delivered) without regression", async () => {
    const eventId = `evt_http_ooo_${ts2}`;
    const { body, signature } = generateEasyPostWebhookPayload(
      eventId,
      "tracker.updated",
      {
        id: `trk_http_ooo_${ts2}`,
        tracking_code: trackingNumber2,
        status: "in_transit",
        tracking_details: [
          {
            status: "in_transit",
            message: "Late in_transit event",
            datetime: "2026-04-20T08:00:00.000Z",
            tracking_location: { city: "Austin", state: "TX" },
          },
        ],
      },
      EP_WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/easypost",
      headers: {
        "content-type": "application/json",
        "x-hmac-signature": signature,
      },
      payload: body,
    });

    // Webhook accepted (200) — the event is stored but transition is silently skipped
    expect(res.statusCode).toBe(200);
    const resBody = JSON.parse(res.body);
    expect(resBody.received).toBe(true);

    // Verify statuses remain at "delivered" — no regression
    const db = dbConn.db;
    const unchangedShipment = await findShipmentById(db, testShipmentId2);
    expect(unchangedShipment!.status).toBe("delivered");

    const unchangedOrder = await findOrderById(db, testOrderId2);
    expect(unchangedOrder!.shippingStatus).toBe("delivered");
  });

  it("skips non-tracker events", async () => {
    const { body, signature } = generateEasyPostWebhookPayload(
      `evt_http_other_${ts2}`,
      "batch.completed",
      {
        id: `batch_${ts2}`,
        tracking_code: trackingNumber2,
        status: "delivered",
      },
      EP_WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/easypost",
      headers: {
        "content-type": "application/json",
        "x-hmac-signature": signature,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const resBody = JSON.parse(res.body);
    expect(resBody.received).toBe(true);
    expect(resBody.skipped).toBe(true);
  });

  it("skips tracker event with unknown tracking code (logs + discards without erroring)", async () => {
    const { body, signature } = generateEasyPostWebhookPayload(
      `evt_http_unknown_${ts2}`,
      "tracker.updated",
      {
        id: `trk_unknown_${ts2}`,
        tracking_code: "UNKNOWN-TRACKING-999",
        status: "in_transit",
      },
      EP_WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/easypost",
      headers: {
        "content-type": "application/json",
        "x-hmac-signature": signature,
      },
      payload: body,
    });

    // Returns 200 (webhook acknowledged) with skipped=true — does not error
    expect(res.statusCode).toBe(200);
    const resBody = JSON.parse(res.body);
    expect(resBody.received).toBe(true);
    expect(resBody.skipped).toBe(true);
  });
});
