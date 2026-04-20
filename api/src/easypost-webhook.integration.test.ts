import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine } from "./db/schema/order.js";
import { shipment, shipmentPackage, shipmentLine, shipmentEvent } from "./db/schema/fulfillment.js";
import { eq } from "drizzle-orm";
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

const DATABASE_URL = process.env["DATABASE_URL"];
const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

const EP_WEBHOOK_SECRET = "ep_test_webhook_secret_for_tests";

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

describeWithDeps("EasyPost tracking webhook (T059)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  let testOrderId = "";
  const trackingNumber = `EP-TRACK-${ts}`;
  let testShipmentId = "";

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

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

    // Create order line
    const [line] = await db
      .insert(orderLine)
      .values({
        orderId: testOrderId,
        variantId: "00000000-0000-0000-0000-000000000001",
        skuSnapshot: "KNX-T059-001",
        titleSnapshot: "Test Item T059",
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
      await db.delete(shipmentEvent).where(eq(shipmentEvent.shipmentId, testShipmentId));
      await db.delete(shipmentLine).where(eq(shipmentLine.shipmentId, testShipmentId));
      await db.delete(shipmentPackage).where(eq(shipmentPackage.shipmentId, testShipmentId));
      await db.delete(shipment).where(eq(shipment.id, testShipmentId));
      await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId));
      await db.delete(order).where(eq(order.id, testOrderId));
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

  it("finds shipment by tracking number", async () => {
    const db = dbConn.db;
    const found = await findShipmentByTrackingNumber(db, trackingNumber);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(testShipmentId);
    expect(found?.trackingNumber).toBe(trackingNumber);
  });

  it("returns null for unknown tracking number", async () => {
    const db = dbConn.db;
    const found = await findShipmentByTrackingNumber(db, "NONEXISTENT-TRACKING");
    expect(found).toBeNull();
  });

  it("stores a shipment event", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_store_${ts}`;
    const result = await storeShipmentEvent(db, {
      shipmentId: testShipmentId,
      providerEventId: eventId,
      status: "in_transit",
      description: "Package picked up by carrier",
      occurredAt: new Date(),
      rawPayloadJson: { test: true },
    });
    expect(result.id).toBeTruthy();

    // Verify idempotency check
    const processed = await hasShipmentEventBeenProcessed(db, eventId);
    expect(processed).toBe(true);

    // Unprocessed event
    const notProcessed = await hasShipmentEventBeenProcessed(db, "evt_never_seen");
    expect(notProcessed).toBe(false);
  });

  it("finds shipment events by shipment ID", async () => {
    const db = dbConn.db;
    const events = await findShipmentEventsByShipmentId(db, testShipmentId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events.find((e) => e.providerEventId === `evt_test_store_${ts}`);
    expect(ev).toBeDefined();
    expect(ev?.status).toBe("in_transit");
    expect(ev?.description).toBe("Package picked up by carrier");
  });

  // ---------------------------------------------------------------------------
  // Integration tests: tracking update handler
  // ---------------------------------------------------------------------------

  it("handles in_transit tracking update: shipment + order status", async () => {
    const db = dbConn.db;

    // Shipment is currently "shipped", order shipping_status is "shipped"
    const result = await handleTrackingUpdate(
      db,
      { id: testShipmentId, orderId: testOrderId, status: "shipped" } as Parameters<
        typeof handleTrackingUpdate
      >[1],
      "in_transit",
    );

    expect(result.shipmentTransitioned).toBe(true);
    expect(result.orderTransitioned).toBe(true);

    // Verify shipment status
    const updatedShipment = await findShipmentById(db, testShipmentId);
    expect(updatedShipment).not.toBeNull();
    expect(updatedShipment?.status).toBe("in_transit");

    // Verify order shipping_status
    const updatedOrder = await findOrderById(db, testOrderId);
    expect(updatedOrder).not.toBeNull();
    expect(updatedOrder?.shippingStatus).toBe("in_transit");
  });

  it("handles delivered tracking update: shipment + order status", async () => {
    const db = dbConn.db;

    // Shipment is now "in_transit", order shipping_status is "in_transit"
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
    expect(updatedShipment).not.toBeNull();
    expect(updatedShipment?.status).toBe("delivered");

    // Verify order shipping_status
    const updatedOrder = await findOrderById(db, testOrderId);
    expect(updatedOrder).not.toBeNull();
    expect(updatedOrder?.shippingStatus).toBe("delivered");
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

    // Should not crash - transition errors are caught
    expect(result.shipmentTransitioned).toBe(false);
    expect(result.orderTransitioned).toBe(false);
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

    // Verify signature
    const parsed = JSON.parse(body);
    expect(parsed.id).toBe("evt_test_1");
    expect(parsed.description).toBe("tracker.updated");
    expect(parsed.result.tracking_code).toBe("TEST123");

    const expectedSig = createHmac("sha256", EP_WEBHOOK_SECRET).update(body).digest("hex");
    const sigValue = signature.replace("hmac-sha256-hex=", "");
    expect(sigValue).toBe(expectedSig);
  });
});

// ---------------------------------------------------------------------------
// HTTP-level webhook tests (server-based)
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { createServer, markReady } from "./server.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";

async function isSuperTokensUp(): Promise<boolean> {
  const uri = process.env["SUPERTOKENS_CONNECTION_URI"] ?? "http://localhost:3567";
  try {
    const res = await fetch(`${uri}/hello`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: DATABASE_URL ?? "postgres://localhost/test",
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "whsec_test_xxx",
    PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_xxx",
    STRIPE_TAX_ENABLED: false,
    SUPERTOKENS_API_KEY: "test-key",
    SUPERTOKENS_CONNECTION_URI:
      process.env["SUPERTOKENS_CONNECTION_URI"] ?? "http://localhost:3567",
    EASYPOST_API_KEY: "test-key",
    EASYPOST_WEBHOOK_SECRET: EP_WEBHOOK_SECRET,
    GITHUB_OAUTH_CLIENT_ID: "test-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW_MS: 60000,
    ...overrides,
  };
}

function createFakeProcess(): EventEmitter {
  return new EventEmitter();
}

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

describeWithDeps("EasyPost webhook HTTP handler (T059)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let superTokensAvailable = false;

  const ts2 = Date.now() + 1;
  let testOrderId2 = "";
  let testShipmentId2 = "";
  const trackingNumber2 = `EP-HTTP-TRACK-${ts2}`;

  beforeAll(async () => {
    try {
      superTokensAvailable = await isSuperTokensUp();
    } catch {
      superTokensAvailable = false;
    }
    if (!superTokensAvailable) return;

    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      reservationCleanupIntervalMs: 0,
      taxAdapter: createStubTaxAdapter(),
      shippingAdapter: createStubShippingAdapter(),
      paymentAdapter: createStubPaymentAdapter(),
    });
    app = server.app;

    await server.start();
    markReady();

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
        variantId: "00000000-0000-0000-0000-000000000001",
        skuSnapshot: "KNX-T059H-001",
        titleSnapshot: "Test Item T059H",
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
    if (app) {
      await app.close();
    }
    if (dbConn) {
      const db = dbConn.db;
      await db.delete(shipmentEvent).where(eq(shipmentEvent.shipmentId, testShipmentId2));
      await db.delete(shipmentLine).where(eq(shipmentLine.shipmentId, testShipmentId2));
      await db.delete(shipmentPackage).where(eq(shipmentPackage.shipmentId, testShipmentId2));
      await db.delete(shipment).where(eq(shipment.id, testShipmentId2));
      await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId2));
      await db.delete(order).where(eq(order.id, testOrderId2));
      await dbConn.close();
    }
  });

  it("rejects webhook with missing signature", async () => {
    if (!superTokensAvailable) return;

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
    if (!superTokensAvailable) return;

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

  it("processes tracker.updated in_transit: shipment + order transitions", async () => {
    if (!superTokensAvailable) return;

    const eventId = `evt_http_in_transit_${ts2}`;
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
            datetime: new Date().toISOString(),
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
    expect(updatedShipment).not.toBeNull();
    expect(updatedShipment?.status).toBe("in_transit");

    // Verify order shipping_status updated
    const updatedOrder = await findOrderById(db, testOrderId2);
    expect(updatedOrder).not.toBeNull();
    expect(updatedOrder?.shippingStatus).toBe("in_transit");

    // Verify event stored
    const events = await findShipmentEventsByShipmentId(db, testShipmentId2);
    const stored = events.find((e) => e.providerEventId === eventId);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe("in_transit");
    expect(stored?.description).toBe("In transit to destination");
  });

  it("returns duplicate for already-processed event", async () => {
    if (!superTokensAvailable) return;

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

  it("processes tracker.updated delivered: shipment + order", async () => {
    if (!superTokensAvailable) return;

    const eventId = `evt_http_delivered_${ts2}`;
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
            datetime: new Date().toISOString(),
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
    expect(updatedShipment).not.toBeNull();
    expect(updatedShipment?.status).toBe("delivered");

    const updatedOrder = await findOrderById(db, testOrderId2);
    expect(updatedOrder).not.toBeNull();
    expect(updatedOrder?.shippingStatus).toBe("delivered");
  });

  it("skips non-tracker events", async () => {
    if (!superTokensAvailable) return;

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
    expect(resBody.skipped).toBe(true);
  });

  it("skips tracker event with unknown tracking code", async () => {
    if (!superTokensAvailable) return;

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

    expect(res.statusCode).toBe(200);
    const resBody = JSON.parse(res.body);
    expect(resBody.skipped).toBe(true);
  });
});
