import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { order } from "./db/schema/order.js";
import { payment, refund } from "./db/schema/payment.js";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { createHmac } from "node:crypto";

const DATABASE_URL = process.env["DATABASE_URL"];
const SUPERTOKENS_URI = process.env["SUPERTOKENS_CONNECTION_URI"] ?? "http://localhost:3567";
const WEBHOOK_SECRET = "whsec_test_refund_secret";

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
let refundAdapterCallCount = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      paymentAdapterCallCount++;
      return {
        id: `pi_test_refund_${paymentAdapterCallCount}_${Date.now()}`,
        clientSecret: `pi_test_refund_${paymentAdapterCallCount}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      refundAdapterCallCount++;
      return {
        id: `re_test_${refundAdapterCallCount}_${Date.now()}`,
        status: "succeeded",
      };
    },
  };
}

async function signUpUser(address: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${address}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  const body = (await res.json()) as { status: string; user?: { id: string } };
  if (body.status !== "OK" || !body.user) {
    throw new Error(`Signup failed: ${JSON.stringify(body)}`);
  }
  return body.user.id;
}

async function signInAndGetHeaders(
  address: string,
  email: string,
  password: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${address}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  if (res.status !== 200) {
    throw new Error(`Sign-in failed with status ${res.status}`);
  }
  const cookies = res.headers.getSetCookie();
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const accessToken = res.headers.get("st-access-token");
  const antiCsrf = res.headers.get("anti-csrf");
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    cookie: cookieHeader,
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  if (antiCsrf) headers["anti-csrf"] = antiCsrf;
  return headers;
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

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("refund API (T052)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const adminEmail = `test-refund-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  // Test data
  let orderId = "";
  let paymentIntentId = "";
  let paymentAmountMinor = 0;

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
    address = await server.start();
    markReady();

    // Create admin user with finance role (has orders.refund)
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `test_refund_finance_${ts}`,
        description: "Test finance role for refund tests",
        capabilitiesJson: ROLE_CAPABILITIES.finance,
      })
      .returning();

    const [user] = await db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Refund Admin",
        status: "active",
      })
      .returning();

    await db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Seed product, variant, inventory
    const [prod] = await db
      .insert(product)
      .values({
        slug: `refund-test-prod-${ts}`,
        title: `Refund Test Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `RFD-VAR1-${ts}`,
        title: `Refund Variant ${ts}`,
        priceMinor: 2500,
        status: "active",
        weight: "16",
      })
      .returning();

    // Get or create location
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    let locationId: string;
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const [loc] = await db
        .insert(inventoryLocation)
        .values({
          name: `Refund Warehouse ${ts}`,
          code: `RFD-WH-${ts}`,
          type: "warehouse",
        })
        .returning();
      locationId = loc.id;
    }

    await db.insert(inventoryBalance).values({
      variantId: variant.id,
      locationId,
      onHand: 100,
      reserved: 0,
      available: 100,
    });

    // Create cart → add items → checkout
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
        quantity: 2,
      }),
    });

    // Checkout
    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `refund-test-${ts}@example.com`,
        shipping_address: {
          full_name: "Refund Tester",
          line1: "456 Refund St",
          city: "Austin",
          state: "TX",
          postal_code: "78702",
          country: "US",
        },
      }),
    });

    expect(checkoutRes.statusCode).toBe(201);
    const checkoutData = JSON.parse(checkoutRes.body);
    orderId = checkoutData.order.id;

    // Find the payment record
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    paymentIntentId = paymentRow.providerPaymentIntentId;
    paymentAmountMinor = paymentRow.amountMinor;

    // Simulate payment success via webhook to get order to "paid" state
    const { body: whBody, signature: whSig } = generateWebhookPayload(
      `evt_refund_test_succeeded_${ts}`,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: paymentAmountMinor,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_refund_test_${ts}`,
      },
      WEBHOOK_SECRET,
    );

    const whRes = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": whSig,
      },
      body: whBody,
    });
    expect(whRes.statusCode).toBe(200);

    // Verify order is now paid
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("paid");
  });

  afterAll(async () => {
    if (!superTokensAvailable) return;
    markNotReady();
    await app?.close();
    await dbConn?.close();
  });

  it("should process a partial refund", async () => {
    if (!superTokensAvailable) return;

    const partialAmount = 1000; // $10.00

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${orderId}/refunds`,
      headers: {
        "content-type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({
        amount: partialAmount,
        reason: "Customer requested partial refund",
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.refund).toBeDefined();
    expect(body.refund.amountMinor).toBe(partialAmount);
    expect(body.refund.reason).toBe("Customer requested partial refund");
    expect(body.refund.status).toBe("succeeded");
    expect(body.refund.providerRefundId).toBeTruthy();

    // Verify payment_status is partially_refunded
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("partially_refunded");

    // Verify refund record in DB
    const refunds = await dbConn.db.select().from(refund).where(eq(refund.orderId, orderId));
    expect(refunds.length).toBe(1);
    expect(refunds[0].amountMinor).toBe(partialAmount);
  });

  it("should process a full refund (remaining amount)", async () => {
    if (!superTokensAvailable) return;

    // Total was paymentAmountMinor, we already refunded 1000
    const remainingAmount = paymentAmountMinor - 1000;

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${orderId}/refunds`,
      headers: {
        "content-type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({
        amount: remainingAmount,
        reason: "Full refund for remaining balance",
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.refund.amountMinor).toBe(remainingAmount);

    // Verify payment_status is now fully refunded
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("refunded");

    // Verify total refunds in DB
    const refunds = await dbConn.db.select().from(refund).where(eq(refund.orderId, orderId));
    expect(refunds.length).toBe(2);
  });

  it("should reject over-refund with ERR_REFUND_EXCEEDS_PAYMENT", async () => {
    if (!superTokensAvailable) return;

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${orderId}/refunds`,
      headers: {
        "content-type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({
        amount: 100,
        reason: "This should fail",
      }),
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_REFUND_EXCEEDS_PAYMENT");
  });

  it("should list refunds for an order", async () => {
    if (!superTokensAvailable) return;

    const res = await app.inject({
      method: "GET",
      url: `/api/admin/orders/${orderId}/refunds`,
      headers: adminHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.refunds).toBeInstanceOf(Array);
    expect(body.refunds.length).toBe(2);
  });

  it("should return 404 for refund on non-existent order", async () => {
    if (!superTokensAvailable) return;

    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${fakeId}/refunds`,
      headers: {
        "content-type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({
        amount: 100,
        reason: "Should 404",
      }),
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_ORDER_NOT_FOUND");
  });
});
