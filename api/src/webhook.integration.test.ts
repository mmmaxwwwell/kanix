import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "./db/schema/inventory.js";
import { order } from "./db/schema/order.js";
import { payment, paymentEvent, dispute } from "./db/schema/payment.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { createHmac } from "node:crypto";
import { assertSuperTokensUp, getSuperTokensUri, requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();
const SUPERTOKENS_URI = getSuperTokensUri();
const WEBHOOK_SECRET = "whsec_test_webhook_secret_for_tests";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: DATABASE_URL,
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_xxx",
    STRIPE_TAX_ENABLED: false,
    SUPERTOKENS_API_KEY: "test-key",
    SUPERTOKENS_CONNECTION_URI: SUPERTOKENS_URI,
    EASYPOST_API_KEY: "test-key",
    EASYPOST_WEBHOOK_SECRET: "",
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

let paymentAdapterCallCount = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      paymentAdapterCallCount++;
      return {
        id: `pi_test_webhook_${paymentAdapterCallCount}_${Date.now()}`,
        clientSecret: `pi_test_webhook_${paymentAdapterCallCount}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_test_webhook_${Date.now()}`, status: "succeeded" };
    },
  };
}

/**
 * Generate a signed Stripe webhook payload for testing.
 * Uses the same algorithm as Stripe's signature verification.
 */
function generateWebhookPayload(
  eventId: string,
  eventType: string,
  data: unknown,
  secret: string,
): { body: string; signature: string } {
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type: eventType,
    data: { object: data },
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    api_version: "2024-12-18.acacia",
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;

  // Use the same HMAC-SHA256 signing that Stripe uses
  const sig = createHmac("sha256", secret).update(signedPayload).digest("hex");
  const signature = `t=${timestamp},v1=${sig}`;

  return { body: payload, signature };
}

describe("Stripe webhook handler (T051)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now();

  // Test data
  let activeProductId = "";
  let activeVariantId = "";
  let locationId = "";
  let cartToken = "";
  let orderId = "";
  let paymentIntentId = "";
  let paymentRecordId = "";

  beforeAll(async () => {
    await assertSuperTokensUp();
    dbConn = createDatabaseConnection(DATABASE_URL);
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

    // Seed test data
    const [prod] = await db
      .insert(product)
      .values({
        slug: `webhook-test-prod-${ts}`,
        title: `Webhook Test Product ${ts}`,
        status: "active",
      })
      .returning();
    activeProductId = prod.id;

    const [variant1] = await db
      .insert(productVariant)
      .values({
        productId: activeProductId,
        sku: `WHK-VAR1-${ts}`,
        title: `Webhook Variant 1 ${ts}`,
        priceMinor: 1500,
        status: "active",
        weight: "16",
      })
      .returning();
    activeVariantId = variant1.id;

    // Use the first existing location (matches checkout's findInventoryBalances behavior)
    // or create one if none exists
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const [loc] = await db
        .insert(inventoryLocation)
        .values({
          name: `Webhook Warehouse ${ts}`,
          code: `WHK-WH-${ts}`,
          type: "warehouse",
        })
        .returning();
      locationId = loc.id;
    }

    await db.insert(inventoryBalance).values({
      variantId: activeVariantId,
      locationId,
      onHand: 50,
      reserved: 0,
      available: 50,
    });

    // Create cart, add items, checkout
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartData = JSON.parse(cartRes.body);
    cartToken = cartData.cart.token;

    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        quantity: 2,
      }),
    });

    // Perform checkout
    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `webhook-test-${ts}@example.com`,
        shipping_address: {
          full_name: "Webhook Tester",
          line1: "123 Test St",
          city: "Austin",
          state: "TX",
          postal_code: "78701",
          country: "US",
        },
      }),
    });

    expect(checkoutRes.statusCode).toBe(201);
    const checkoutData = JSON.parse(checkoutRes.body);
    orderId = checkoutData.order.id;

    // Find the payment record and intent ID
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    paymentRecordId = paymentRow.id;
    paymentIntentId = paymentRow.providerPaymentIntentId;
  });

  afterAll(async () => {
    markNotReady();
    await app?.close();
    await dbConn?.close();
  });

  it("should return 401 for missing stripe-signature header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "payment_intent.succeeded" }),
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_MISSING_SIGNATURE");
  });

  it("should return 401 for invalid signature", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1234567890,v1=invalid_signature",
      },
      body: JSON.stringify({ type: "payment_intent.succeeded" }),
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_INVALID_SIGNATURE");
  });

  it("should handle payment_intent.succeeded and confirm order", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_succeeded_${ts}`;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 3599,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_test_${ts}`,
      },
      WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });

    expect(res.statusCode).toBe(200);
    const resBody = JSON.parse(res.body);
    expect(resBody.received).toBe(true);

    // Verify order status updated to confirmed
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.status).toBe("confirmed");
    expect(orderRow.paymentStatus).toBe("paid");

    // Verify payment record updated
    const [paymentRow] = await db.select().from(payment).where(eq(payment.id, paymentRecordId));
    expect(paymentRow.status).toBe("succeeded");
    expect(paymentRow.providerChargeId).toBe(`ch_test_${ts}`);

    // Verify payment_event record created
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, eventId));
    expect(eventRow).toBeDefined();
    expect(eventRow.eventType).toBe("payment_intent.succeeded");

    // Verify reservations consumed
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    for (const res of reservations) {
      expect(res.status).toBe("consumed");
    }
  });

  it("should handle duplicate webhook as no-op", async () => {
    const eventId = `evt_test_succeeded_${ts}`; // Same event ID as above

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 3599,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_test_${ts}`,
      },
      WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });

    expect(res.statusCode).toBe(200);
    const resBody = JSON.parse(res.body);
    expect(resBody.received).toBe(true);
    expect(resBody.duplicate).toBe(true);
  });

  it("should handle charge.dispute.created and create dispute record", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_dispute_${ts}`;
    const disputeId = `dp_test_${ts}`;
    const chargeId = `ch_test_${ts}`;
    const createdTime = Math.floor(Date.now() / 1000);
    const dueByTime = createdTime + 7 * 24 * 60 * 60; // 7 days

    const { body, signature } = generateWebhookPayload(
      eventId,
      "charge.dispute.created",
      {
        id: disputeId,
        object: "dispute",
        charge: chargeId,
        payment_intent: paymentIntentId,
        amount: 3599,
        currency: "usd",
        reason: "fraudulent",
        status: "needs_response",
        created: createdTime,
        evidence_details: {
          due_by: dueByTime,
        },
      },
      WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });

    expect(res.statusCode).toBe(200);

    // Verify dispute record created
    const [disputeRow] = await db
      .select()
      .from(dispute)
      .where(eq(dispute.providerDisputeId, disputeId));
    expect(disputeRow).toBeDefined();
    expect(disputeRow.reason).toBe("fraudulent");
    expect(disputeRow.amountMinor).toBe(3599);
    expect(disputeRow.orderId).toBe(orderId);

    // Verify order payment status changed to disputed
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("disputed");
  });

  it("should handle charge.dispute.closed (won) and update dispute + payment_status", async () => {
    const db = dbConn.db;
    const disputeId = `dp_test_${ts}`;
    const chargeId = `ch_test_${ts}`;
    const closeEventId = `evt_test_dispute_close_won_${ts}`;

    const { body, signature } = generateWebhookPayload(
      closeEventId,
      "charge.dispute.closed",
      {
        id: disputeId,
        object: "dispute",
        charge: chargeId,
        payment_intent: paymentIntentId,
        amount: 3599,
        currency: "usd",
        reason: "fraudulent",
        status: "won",
        created: Math.floor(Date.now() / 1000),
        evidence_details: {},
      },
      WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });

    expect(res.statusCode).toBe(200);

    // Verify dispute is now closed
    const [disputeRow] = await db
      .select()
      .from(dispute)
      .where(eq(dispute.providerDisputeId, disputeId));
    expect(disputeRow).toBeDefined();
    expect(disputeRow.status).toBe("closed");
    expect(disputeRow.closedAt).not.toBeNull();

    // Verify order payment_status reverted to paid (dispute won)
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("paid");
  });
});

// Separate describe for dispute close (lost) scenario
describe("Stripe webhook — dispute close lost (T064)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now() + 3; // Differentiate from above

  let orderId = "";
  let paymentIntentId = "";
  let locationId = "";

  beforeAll(async () => {
    await assertSuperTokensUp();
    dbConn = createDatabaseConnection(DATABASE_URL);
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

    // Seed product + variant + location + inventory
    const [prod] = await db
      .insert(product)
      .values({
        slug: `whk-dispute-lost-prod-${ts}`,
        title: `WHK Dispute Lost Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `WHK-DLOST-VAR-${ts}`,
        title: `Dispute Lost Variant ${ts}`,
        priceMinor: 2500,
        status: "active",
        weight: "16",
      })
      .returning();

    // Use existing location or create one
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const [loc] = await db
        .insert(inventoryLocation)
        .values({ name: `Dispute Lost Loc ${ts}`, code: `DL-WH-${ts}`, type: "warehouse" })
        .returning();
      locationId = loc.id;
    }

    await db.insert(inventoryBalance).values({
      variantId: variant.id,
      locationId,
      onHand: 10,
      reserved: 0,
      available: 10,
    });

    // Create cart, add items, checkout (matching existing webhook test pattern)
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartData = JSON.parse(cartRes.body);
    const cartToken = cartData.cart.token;

    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({
        variant_id: variant.id,
        quantity: 1,
      }),
    });

    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `dispute-lost-${ts}@example.com`,
        shipping_address: {
          full_name: "Dispute Lost Tester",
          line1: "123 Test St",
          city: "Austin",
          state: "TX",
          postal_code: "78701",
          country: "US",
        },
      }),
    });

    const checkoutData = JSON.parse(checkoutRes.body);
    orderId = checkoutData.order.id;

    // Find the payment record and intent ID
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    paymentIntentId = paymentRow.providerPaymentIntentId;

    // Simulate payment_intent.succeeded
    const { body: piBody, signature: piSig } = generateWebhookPayload(
      `evt_pi_succeeded_dlost_${ts}`,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 2500,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_dlost_${ts}`,
      },
      WEBHOOK_SECRET,
    );

    await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": piSig,
      },
      body: piBody,
    });

    // Create dispute
    const { body: dpBody, signature: dpSig } = generateWebhookPayload(
      `evt_dispute_created_dlost_${ts}`,
      "charge.dispute.created",
      {
        id: `dp_dlost_${ts}`,
        object: "dispute",
        charge: `ch_dlost_${ts}`,
        payment_intent: paymentIntentId,
        amount: 2500,
        currency: "usd",
        reason: "product_not_received",
        status: "needs_response",
        created: Math.floor(Date.now() / 1000),
        evidence_details: {
          due_by: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        },
      },
      WEBHOOK_SECRET,
    );

    await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": dpSig,
      },
      body: dpBody,
    });
  });

  afterAll(async () => {
    markNotReady();
    await app?.close();
    await dbConn?.close();
  });

  it("should handle charge.dispute.closed (lost) and set payment_status to refunded", async () => {
    const db = dbConn.db;
    const disputeId = `dp_dlost_${ts}`;
    const closeEventId = `evt_dispute_close_lost_${ts}`;

    const { body, signature } = generateWebhookPayload(
      closeEventId,
      "charge.dispute.closed",
      {
        id: disputeId,
        object: "dispute",
        charge: `ch_dlost_${ts}`,
        payment_intent: paymentIntentId,
        amount: 2500,
        currency: "usd",
        reason: "product_not_received",
        status: "lost",
        created: Math.floor(Date.now() / 1000),
        evidence_details: {},
      },
      WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });

    expect(res.statusCode).toBe(200);

    // Verify dispute is now closed
    const [disputeRow] = await db
      .select()
      .from(dispute)
      .where(eq(dispute.providerDisputeId, disputeId));
    expect(disputeRow).toBeDefined();
    expect(disputeRow.status).toBe("closed");
    expect(disputeRow.closedAt).not.toBeNull();

    // Verify order payment_status changed to refunded (dispute lost)
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("refunded");
  });
});

// Separate describe for payment_failed scenario (needs its own checkout)
describe("Stripe webhook — payment_failed (T051)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now() + 1; // Differentiate from above

  let orderId = "";
  let paymentIntentId = "";
  let locationId = "";

  beforeAll(async () => {
    await assertSuperTokensUp();
    dbConn = createDatabaseConnection(DATABASE_URL);
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

    // Seed product + variant + location + inventory
    const [prod] = await db
      .insert(product)
      .values({
        slug: `whk-fail-prod-${ts}`,
        title: `WHK Fail Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `WHK-FAIL-${ts}`,
        title: `WHK Fail Variant ${ts}`,
        priceMinor: 1000,
        status: "active",
        weight: "16",
      })
      .returning();

    // Use the first existing location (matches checkout's findInventoryBalances behavior)
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const [loc] = await db
        .insert(inventoryLocation)
        .values({
          name: `WHK Fail WH ${ts}`,
          code: `WHK-FW-${ts}`,
          type: "warehouse",
        })
        .returning();
      locationId = loc.id;
    }

    await db.insert(inventoryBalance).values({
      variantId: variant.id,
      locationId,
      onHand: 20,
      reserved: 0,
      available: 20,
    });

    // Cart + checkout
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartToken = JSON.parse(cartRes.body).cart.token;

    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variant.id, quantity: 3 }),
    });

    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `whk-fail-${ts}@example.com`,
        shipping_address: {
          full_name: "Fail Tester",
          line1: "456 Fail St",
          city: "Houston",
          state: "TX",
          postal_code: "77001",
          country: "US",
        },
      }),
    });

    expect(checkoutRes.statusCode).toBe(201);
    const checkoutData = JSON.parse(checkoutRes.body);
    orderId = checkoutData.order.id;

    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    paymentIntentId = paymentRow.providerPaymentIntentId;
  });

  afterAll(async () => {
    markNotReady();
    await app?.close();
    await dbConn?.close();
  });

  it("should handle payment_intent.payment_failed and release reservations", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_failed_${ts}`;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.payment_failed",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 3599,
        currency: "usd",
        status: "requires_payment_method",
        last_payment_error: {
          code: "card_declined",
          message: "Your card was declined.",
        },
      },
      WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });

    expect(res.statusCode).toBe(200);

    // Verify order payment_status is failed
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("failed");

    // Verify reservations released
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    for (const res of reservations) {
      expect(res.status).toBe("released");
    }

    // Verify payment_event stored
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, eventId));
    expect(eventRow).toBeDefined();
    expect(eventRow.eventType).toBe("payment_intent.payment_failed");
  });
});
