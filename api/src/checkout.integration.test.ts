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
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { payment } from "./db/schema/payment.js";
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

// Stub tax adapter that always returns 0 tax
function createStubTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 0, calculationId: null };
    },
  };
}

// Stub payment adapter that returns fake PaymentIntent data
let paymentAdapterCallCount = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      paymentAdapterCallCount++;
      return {
        id: `pi_test_${paymentAdapterCallCount}_${Date.now()}`,
        clientSecret: `pi_test_${paymentAdapterCallCount}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_test_${Date.now()}`, status: "succeeded" };
    },
  };
}

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("checkout API (T049)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let superTokensAvailable = false;

  const ts = Date.now();

  // Test data IDs
  let activeProductId = "";
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
      paymentAdapter: createStubPaymentAdapter(),
    });
    app = server.app;

    await server.start();
    markReady();

    // Seed test data
    // 1. Product
    const [prod] = await db
      .insert(product)
      .values({
        slug: `checkout-test-prod-${ts}`,
        title: `Checkout Test Product ${ts}`,
        status: "active",
      })
      .returning();
    activeProductId = prod.id;

    // 2. Variants
    const [variant1] = await db
      .insert(productVariant)
      .values({
        productId: activeProductId,
        sku: `CHKT-VAR1-${ts}`,
        title: `Checkout Variant 1 ${ts}`,
        priceMinor: 1500,
        status: "active",
        weight: "16",
      })
      .returning();
    activeVariantId = variant1.id;

    const [variant2] = await db
      .insert(productVariant)
      .values({
        productId: activeProductId,
        sku: `CHKT-VAR2-${ts}`,
        title: `Checkout Variant 2 ${ts}`,
        priceMinor: 2000,
        status: "active",
        weight: "8",
      })
      .returning();
    secondVariantId = variant2.id;

    // 3. Inventory location
    const [loc] = await db
      .insert(inventoryLocation)
      .values({
        name: `Checkout Warehouse ${ts}`,
        code: `CHKT-WH-${ts}`,
        type: "warehouse",
      })
      .returning();
    locationId = loc.id;

    // 4. Inventory balances
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

    // 5. Create a cart with items
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartData = JSON.parse(cartRes.body);
    cartToken = cartData.cart.token;

    // Add items to cart
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

  it("should reject checkout with missing cart_token", async () => {
    if (!superTokensAvailable) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "test@example.com",
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
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_VALIDATION");
  });

  it("should reject checkout with missing email", async () => {
    if (!superTokensAvailable) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
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
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_VALIDATION");
  });

  it("should reject non-US addresses", async () => {
    if (!superTokensAvailable) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: "test@example.com",
        shipping_address: {
          full_name: "Test User",
          line1: "123 Main St",
          city: "London",
          state: "EN",
          postal_code: "SW1A 1AA",
          country: "GB",
        },
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_NON_US_ADDRESS");
  });

  it("should reject checkout with invalid cart token", async () => {
    if (!superTokensAvailable) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: "00000000-0000-0000-0000-000000000000",
        email: "test@example.com",
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
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_CART_NOT_FOUND");
  });

  it("should complete full checkout flow with order creation, email stored, and inventory reserved", async () => {
    if (!superTokensAvailable) return;

    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: "checkout-test@example.com",
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

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // Verify order fields
    expect(body.order).toBeDefined();
    expect(body.order.order_number).toMatch(/^KNX-\d{6}$/);
    expect(body.order.email).toBe("checkout-test@example.com");
    expect(body.order.status).toBe("pending_payment");
    expect(body.order.payment_status).toBe("unpaid");
    expect(body.order.subtotal_minor).toBe(5000); // 1500*2 + 2000*1
    expect(body.order.tax_minor).toBe(0); // stub tax adapter
    expect(body.order.shipping_minor).toBe(599); // stub shipping adapter
    expect(body.order.total_minor).toBe(5599); // 5000 + 0 + 599
    expect(body.client_secret).toBeDefined();

    // Verify order was persisted with snapshots
    const db = dbConn.db;
    const [savedOrder] = await db.select().from(order).where(eq(order.id, body.order.id));
    expect(savedOrder).toBeDefined();
    expect(savedOrder.email).toBe("checkout-test@example.com");
    expect(savedOrder.shippingAddressSnapshotJson).toBeDefined();
    expect(savedOrder.status).toBe("pending_payment");

    // Verify order lines (snapshots)
    const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, body.order.id));
    expect(lines.length).toBe(2);
    const skus = lines.map((l) => l.skuSnapshot).sort();
    expect(skus).toContain(`CHKT-VAR1-${ts}`);
    expect(skus).toContain(`CHKT-VAR2-${ts}`);

    // Verify status history
    const history = await db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, body.order.id));
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].statusType).toBe("status");
    expect(history[0].newValue).toBe("pending_payment");

    // Verify payment record
    const payments = await db.select().from(payment).where(eq(payment.orderId, body.order.id));
    expect(payments.length).toBe(1);
    expect(payments[0].provider).toBe("stripe");
    expect(payments[0].status).toBe("pending");

    // Verify inventory was reserved (reservations linked to order via orderId)
    const allActiveReservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, body.order.id));
    expect(allActiveReservations.length).toBe(2); // 2 line items = 2 reservations
  }, 30000);
});
