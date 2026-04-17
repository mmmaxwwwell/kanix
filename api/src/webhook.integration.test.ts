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

const DATABASE_URL = process.env["DATABASE_URL"];
const SUPERTOKENS_URI = process.env["SUPERTOKENS_CONNECTION_URI"] ?? "http://localhost:3567";
const WEBHOOK_SECRET = "whsec_test_webhook_secret_for_tests";

async function isSuperTokensUp(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPERTOKENS_URI}/hello`, { signal: AbortSignal.timeout(2000) });
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
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
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

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("Stripe webhook handler (T051)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let superTokensAvailable = false;

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
    if (!superTokensAvailable) return;
    markNotReady();
    await app?.close();
    await dbConn?.close();
  });

  it("should return 401 for missing stripe-signature header", async () => {
    if (!superTokensAvailable) return;

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
    if (!superTokensAvailable) return;

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
    if (!superTokensAvailable) return;

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
    if (!superTokensAvailable) return;

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
    if (!superTokensAvailable) return;

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
});

// Separate describe for payment_failed scenario (needs its own checkout)
describeWithDeps("Stripe webhook — payment_failed (T051)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let superTokensAvailable = false;

  const ts = Date.now() + 1; // Differentiate from above

  let orderId = "";
  let paymentIntentId = "";
  let locationId = "";

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
    if (!superTokensAvailable) return;
    markNotReady();
    await app?.close();
    await dbConn?.close();
  });

  it("should handle payment_intent.payment_failed and release reservations", async () => {
    if (!superTokensAvailable) return;

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
