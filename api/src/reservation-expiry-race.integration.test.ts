import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "./db/schema/inventory.js";
import { order } from "./db/schema/order.js";
import { payment } from "./db/schema/payment.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { createAdminAlertService, type AdminAlertService } from "./services/admin-alert.js";
import { createHmac } from "node:crypto";
import { assertSuperTokensUp, getSuperTokensUri, requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();
const SUPERTOKENS_URI = getSuperTokensUri();
const WEBHOOK_SECRET = "whsec_test_race_handler_secret";

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
        id: `pi_test_race_${paymentAdapterCallCount}_${Date.now()}`,
        clientSecret: `pi_test_race_${paymentAdapterCallCount}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_test_race_${Date.now()}`, status: "succeeded" };
    },
  };
}

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
  const sig = createHmac("sha256", secret).update(signedPayload).digest("hex");
  const signature = `t=${timestamp},v1=${sig}`;

  return { body: payload, signature };
}

// ---------------------------------------------------------------------------
// Test 1: Expired reservations + out of stock → order flagged for review
// ---------------------------------------------------------------------------
describe("Reservation expiry race — flagged for review (T054b)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let adminAlertService: AdminAlertService;

  const ts = Date.now() + 100;

  let orderId = "";
  let paymentIntentId = "";

  beforeAll(async () => {
    await assertSuperTokensUp();
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;
    adminAlertService = createAdminAlertService();

    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      reservationCleanupIntervalMs: 0,
      taxAdapter: createStubTaxAdapter(),
      shippingAdapter: createStubShippingAdapter(),
      paymentAdapter: createStubPaymentAdapter(),
      adminAlertService,
    });
    app = server.app;
    await server.start();
    markReady();

    // Seed product + variant + location + inventory
    const [prod] = await db
      .insert(product)
      .values({
        slug: `race-review-prod-${ts}`,
        title: `Race Review Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `RACE-REV-${ts}`,
        title: `Race Review Variant ${ts}`,
        priceMinor: 2000,
        status: "active",
        weight: "16",
      })
      .returning();

    // Use first existing location or create one
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    let locationId: string;
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const [loc] = await db
        .insert(inventoryLocation)
        .values({
          name: `Race Review WH ${ts}`,
          code: `RACE-RW-${ts}`,
          type: "warehouse",
        })
        .returning();
      locationId = loc.id;
    }

    // Set inventory to exactly 2 — just enough for checkout
    await db.insert(inventoryBalance).values({
      variantId: variant.id,
      locationId,
      onHand: 2,
      reserved: 0,
      available: 2,
    });

    // Cart + checkout (reserves 2 units)
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
      body: JSON.stringify({ variant_id: variant.id, quantity: 2 }),
    });

    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `race-review-${ts}@example.com`,
        shipping_address: {
          full_name: "Race Tester",
          line1: "123 Race St",
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

    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    paymentIntentId = paymentRow.providerPaymentIntentId;

    // Force-expire reservations by setting expires_at to the past and status to expired
    // Simulate what the cleanup cron would do
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));

    for (const res of reservations) {
      // Release inventory back (simulating cron expiry)
      await db.execute(
        sql`UPDATE inventory_balance
            SET reserved = reserved - ${res.quantity},
                available = available + ${res.quantity},
                updated_at = now()
            WHERE variant_id = ${res.variantId} AND location_id = ${res.locationId}`,
      );
      // Mark reservation as expired
      await db
        .update(inventoryReservation)
        .set({ status: "expired", releasedAt: new Date() })
        .where(eq(inventoryReservation.id, res.id));
    }

    // Now drain the available inventory so re-reservation fails
    // Set available to 0 (simulating another customer bought the stock)
    for (const res of reservations) {
      await db.execute(
        sql`UPDATE inventory_balance
            SET available = 0, on_hand = 0
            WHERE variant_id = ${res.variantId} AND location_id = ${res.locationId}`,
      );
    }
  });

  afterAll(async () => {
    markNotReady();
    await app?.close();
    await dbConn?.close();
  });

  it("should flag order for review when reservations expired and stock unavailable", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_race_review_${ts}`;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 4599,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_test_race_review_${ts}`,
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

    // Verify order stays in pending_payment (NOT confirmed)
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.status).toBe("pending_payment");
    expect(orderRow.paymentStatus).toBe("paid");

    // Verify admin alert was queued
    const alerts = adminAlertService.getAlerts();
    const raceAlert = alerts.find(
      (a) => a.type === "reservation_expired_payment_received" && a.orderId === orderId,
    );
    expect(raceAlert).toBeDefined();
    expect(raceAlert?.message).toContain("manual review");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Expired reservations + stock available → re-reserved and confirmed
// ---------------------------------------------------------------------------
describe("Reservation expiry race — re-reserved (T054b)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let adminAlertService: AdminAlertService;

  const ts = Date.now() + 200;

  let orderId = "";
  let paymentIntentId = "";

  beforeAll(async () => {
    await assertSuperTokensUp();
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;
    adminAlertService = createAdminAlertService();

    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      reservationCleanupIntervalMs: 0,
      taxAdapter: createStubTaxAdapter(),
      shippingAdapter: createStubShippingAdapter(),
      paymentAdapter: createStubPaymentAdapter(),
      adminAlertService,
    });
    app = server.app;
    await server.start();
    markReady();

    // Seed product + variant + location + inventory
    const [prod] = await db
      .insert(product)
      .values({
        slug: `race-reresv-prod-${ts}`,
        title: `Race Re-reserve Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `RACE-RR-${ts}`,
        title: `Race Re-reserve Variant ${ts}`,
        priceMinor: 1500,
        status: "active",
        weight: "16",
      })
      .returning();

    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    let locationId: string;
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const [loc] = await db
        .insert(inventoryLocation)
        .values({
          name: `Race Rereserve WH ${ts}`,
          code: `RACE-RRW-${ts}`,
          type: "warehouse",
        })
        .returning();
      locationId = loc.id;
    }

    // Set inventory to 10 — plenty for re-reservation
    await db.insert(inventoryBalance).values({
      variantId: variant.id,
      locationId,
      onHand: 10,
      reserved: 0,
      available: 10,
    });

    // Cart + checkout (reserves 2 units)
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
      body: JSON.stringify({ variant_id: variant.id, quantity: 2 }),
    });

    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `race-rereserve-${ts}@example.com`,
        shipping_address: {
          full_name: "Rereserve Tester",
          line1: "456 Reserve St",
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

    // Force-expire reservations (simulate cron expiry)
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));

    for (const res of reservations) {
      // Release inventory back
      await db.execute(
        sql`UPDATE inventory_balance
            SET reserved = reserved - ${res.quantity},
                available = available + ${res.quantity},
                updated_at = now()
            WHERE variant_id = ${res.variantId} AND location_id = ${res.locationId}`,
      );
      // Mark reservation as expired
      await db
        .update(inventoryReservation)
        .set({ status: "expired", releasedAt: new Date() })
        .where(eq(inventoryReservation.id, res.id));
    }
    // Stock is still available (10 units restored to available)
  });

  afterAll(async () => {
    markNotReady();
    await app?.close();
    await dbConn?.close();
  });

  it("should re-reserve and confirm order when stock is available", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_race_rereserve_${ts}`;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 3599,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_test_race_rr_${ts}`,
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

    // Verify order IS confirmed (re-reservation succeeded)
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.status).toBe("confirmed");
    expect(orderRow.paymentStatus).toBe("paid");

    // Verify new reservations were created and consumed
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));

    // Should have both expired originals and consumed new ones
    const expired = reservations.filter((r) => r.status === "expired");
    const consumed = reservations.filter((r) => r.status === "consumed");
    expect(expired.length).toBeGreaterThan(0);
    expect(consumed.length).toBeGreaterThan(0);

    // Verify no admin alert was queued (re-reservation succeeded)
    const alerts = adminAlertService.getAlerts();
    const raceAlert = alerts.find(
      (a) => a.type === "reservation_expired_payment_received" && a.orderId === orderId,
    );
    expect(raceAlert).toBeUndefined();
  });
});
