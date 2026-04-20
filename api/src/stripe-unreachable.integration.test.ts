import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "./db/schema/inventory.js";
import { order } from "./db/schema/order.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const SUPERTOKENS_URI = process.env["SUPERTOKENS_CONNECTION_URI"] ?? "http://localhost:3567";

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
    STRIPE_WEBHOOK_SECRET: "whsec_xxx",
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

/** Payment adapter that simulates Stripe being unreachable (connection error / timeout). */
function createFailingPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
      (err as unknown as Record<string, string>).type = "StripeConnectionError";
      throw err;
    },
    async createRefund() {
      return { id: `re_stub_${Date.now()}`, status: "succeeded" };
    },
  };
}

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("Stripe unreachable checkout error (T054d)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let superTokensAvailable = false;

  const ts = Date.now();

  let activeVariantId = "";
  let secondVariantId = "";
  let locationId = "";
  let cartToken = "";

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
      paymentAdapter: createFailingPaymentAdapter(),
    });
    app = server.app;
    await server.start();
    markReady();

    // Seed test data
    const [prod] = await db
      .insert(product)
      .values({
        slug: `stripe-fail-prod-${ts}`,
        title: `Stripe Fail Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant1] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `SFAIL-V1-${ts}`,
        title: `Stripe Fail Variant 1 ${ts}`,
        priceMinor: 1500,
        status: "active",
        weight: "16",
      })
      .returning();
    activeVariantId = variant1.id;

    const [variant2] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `SFAIL-V2-${ts}`,
        title: `Stripe Fail Variant 2 ${ts}`,
        priceMinor: 2000,
        status: "active",
        weight: "8",
      })
      .returning();
    secondVariantId = variant2.id;

    const [loc] = await db
      .insert(inventoryLocation)
      .values({
        name: `Stripe Fail Warehouse ${ts}`,
        code: `SFAIL-WH-${ts}`,
        type: "warehouse",
      })
      .returning();
    locationId = loc.id;

    await db.insert(inventoryBalance).values({
      variantId: activeVariantId,
      locationId,
      onHand: 50,
      reserved: 0,
      available: 50,
    });
    await db.insert(inventoryBalance).values({
      variantId: secondVariantId,
      locationId,
      onHand: 30,
      reserved: 0,
      available: 30,
    });

    // Create a cart with items
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
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 2 }),
    });
    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: secondVariantId, quantity: 1 }),
    });
  }, 30000);

  afterAll(async () => {
    if (!superTokensAvailable) return;
    markNotReady();
    try {
      await app?.close();
    } catch {
      // ignore
    }
    try {
      await dbConn?.close();
    } catch {
      // ignore
    }
  });

  it("should return 502 with ERR_EXTERNAL_SERVICE_UNAVAILABLE when Stripe is unreachable, create no order, and release reservations", async () => {
    if (!superTokensAvailable) return;

    const db = dbConn.db;

    // Count orders before checkout attempt
    const ordersBefore = await db.select().from(order);
    const ordersBeforeCount = ordersBefore.length;

    // Attempt checkout — Stripe is unreachable
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: "stripe-fail@example.com",
        shipping_address: {
          full_name: "Test User",
          line1: "123 Main St",
          city: "Austin",
          state: "TX",
          postal_code: "78701",
          country: "US",
        },
      }),
    });

    // 1. Verify 502 response with correct error code
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_EXTERNAL_SERVICE_UNAVAILABLE");
    expect(body.message).toBe("Payment service is temporarily unavailable");

    // 2. Verify NO order was created
    const ordersAfter = await db.select().from(order);
    expect(ordersAfter.length).toBe(ordersBeforeCount);

    // 3. Verify inventory reservations were released (available back to original)
    const [balance1] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, activeVariantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );
    expect(balance1.available).toBe(50); // back to original

    const [balance2] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, secondVariantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );
    expect(balance2.available).toBe(30); // back to original

    // 4. Verify any reservations that were created are now released
    const activeReservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.status, "active"));
    const ourReservations = activeReservations.filter(
      (r) => r.variantId === activeVariantId || r.variantId === secondVariantId,
    );
    expect(ourReservations.length).toBe(0);
  }, 30000);
});
