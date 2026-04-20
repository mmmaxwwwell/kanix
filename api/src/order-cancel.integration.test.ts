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
import { payment, refund } from "./db/schema/payment.js";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { createHmac } from "node:crypto";

const DATABASE_URL = process.env["DATABASE_URL"];
const SUPERTOKENS_URI = process.env["SUPERTOKENS_CONNECTION_URI"] ?? "http://localhost:3567";
const WEBHOOK_SECRET = "whsec_test_cancel_secret";

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
let refundAdapterCalls: { paymentIntentId: string; amountMinor: number }[] = [];
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      paymentAdapterCallCount++;
      return {
        id: `pi_test_cancel_${paymentAdapterCallCount}_${Date.now()}`,
        clientSecret: `pi_test_cancel_${paymentAdapterCallCount}_secret_${Date.now()}`,
      };
    },
    async createRefund(input) {
      refundAdapterCalls.push({
        paymentIntentId: input.paymentIntentId,
        amountMinor: input.amountMinor,
      });
      return {
        id: `re_test_cancel_${Date.now()}`,
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

describeWithDeps("order cancellation API (T053)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const adminEmail = `test-cancel-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  let variantId = "";
  let locationId = "";

  // We'll create multiple orders for different test scenarios
  let unpaidOrderId = "";
  let paidOrderId = "";
  let shippedOrderId = "";

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

    // Create admin user with finance role (has orders.cancel)
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `test_cancel_finance_${ts}`,
        description: "Test finance role for cancel tests",
        capabilitiesJson: ROLE_CAPABILITIES.finance,
      })
      .returning();

    const [user] = await db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Cancel Admin",
        status: "active",
      })
      .returning();

    await db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Seed product + variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `cancel-test-prod-${ts}`,
        title: `Cancel Test Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `CXL-VAR1-${ts}`,
        title: `Cancel Variant ${ts}`,
        priceMinor: 2000,
        status: "active",
        weight: "16",
      })
      .returning();
    variantId = variant.id;

    // Get or create location
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const [loc] = await db
        .insert(inventoryLocation)
        .values({
          name: `Cancel Warehouse ${ts}`,
          code: `CXL-WH-${ts}`,
          type: "warehouse",
        })
        .returning();
      locationId = loc.id;
    }

    await db.insert(inventoryBalance).values({
      variantId,
      locationId,
      onHand: 200,
      reserved: 0,
      available: 200,
    });

    // --- Create order 1: unpaid (pending_payment) ---
    unpaidOrderId = await createCheckoutOrder(app, db, variantId, `cxl-unpaid-${ts}`);

    // --- Create order 2: paid (confirmed) ---
    paidOrderId = await createCheckoutOrder(app, db, variantId, `cxl-paid-${ts}`);
    await simulatePaymentSuccess(app, db, paidOrderId, `evt_cancel_paid_${ts}`);

    // --- Create order 3: shipped (for rejection test) ---
    shippedOrderId = await createCheckoutOrder(app, db, variantId, `cxl-shipped-${ts}`);
    await simulatePaymentSuccess(app, db, shippedOrderId, `evt_cancel_shipped_${ts}`);
    // Manually set shipping_status to "shipped"
    await db.update(order).set({ shippingStatus: "shipped" }).where(eq(order.id, shippedOrderId));
  });

  async function createCheckoutOrder(
    appInst: FastifyInstance,
    db: ReturnType<typeof createDatabaseConnection>["db"],
    vId: string,
    emailPrefix: string,
  ): Promise<string> {
    const cartRes = await appInst.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartData = JSON.parse(cartRes.body);
    const token = cartData.cart.token;

    await appInst.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": token,
      },
      body: JSON.stringify({ variant_id: vId, quantity: 2 }),
    });

    const checkoutRes = await appInst.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: token,
        email: `${emailPrefix}@example.com`,
        shipping_address: {
          full_name: "Cancel Tester",
          line1: "789 Cancel St",
          city: "Austin",
          state: "TX",
          postal_code: "78703",
          country: "US",
        },
      }),
    });

    expect(checkoutRes.statusCode).toBe(201);
    return JSON.parse(checkoutRes.body).order.id;
  }

  async function simulatePaymentSuccess(
    appInst: FastifyInstance,
    db: ReturnType<typeof createDatabaseConnection>["db"],
    oid: string,
    eventId: string,
  ): Promise<void> {
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, oid));
    const { body: whBody, signature: whSig } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentRow.providerPaymentIntentId,
        object: "payment_intent",
        amount: paymentRow.amountMinor,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_cancel_test_${oid.substring(0, 8)}`,
      },
      WEBHOOK_SECRET,
    );

    const whRes = await appInst.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": whSig,
      },
      body: whBody,
    });
    expect(whRes.statusCode).toBe(200);
  }

  afterAll(async () => {
    if (!superTokensAvailable) return;
    markNotReady();
    await app?.close();
    await dbConn?.close();
  });

  it("should cancel an unpaid order and release reservations", async () => {
    if (!superTokensAvailable) return;

    const db = dbConn.db;

    // Verify reservations exist before cancel
    const resBefore = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, unpaidOrderId));
    // Reservations may be active or consumed depending on flow;
    // for unpaid orders they should be active
    const activeResBefore = resBefore.filter((r) => r.status === "active");
    expect(activeResBefore.length).toBeGreaterThan(0);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${unpaidOrderId}/cancel`,
      headers: {
        "content-type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({ reason: "Customer changed their mind" }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.orderId).toBe(unpaidOrderId);
    expect(body.reservationsReleased).toBeGreaterThan(0);
    expect(body.refundInitiated).toBe(false);

    // Verify order status is canceled
    const [orderRow] = await db.select().from(order).where(eq(order.id, unpaidOrderId));
    expect(orderRow.status).toBe("canceled");

    // Verify reservations are released
    const resAfter = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, unpaidOrderId));
    const activeResAfter = resAfter.filter((r) => r.status === "active");
    expect(activeResAfter.length).toBe(0);
  });

  it("should cancel a paid order with refund and release reservations", async () => {
    if (!superTokensAvailable) return;

    const db = dbConn.db;

    // Clear refund adapter call log
    refundAdapterCalls = [];

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${paidOrderId}/cancel`,
      headers: {
        "content-type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({ reason: "Order canceled by admin" }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.orderId).toBe(paidOrderId);
    expect(body.refundInitiated).toBe(true);
    expect(body.refundId).toBeTruthy();

    // Verify order status is canceled
    const [orderRow] = await db.select().from(order).where(eq(order.id, paidOrderId));
    expect(orderRow.status).toBe("canceled");
    expect(orderRow.paymentStatus).toBe("refunded");

    // Verify refund record created in DB
    const refunds = await db.select().from(refund).where(eq(refund.orderId, paidOrderId));
    expect(refunds.length).toBe(1);
    expect(refunds[0].reason).toBe("Order canceled by admin");
    expect(refunds[0].status).toBe("succeeded");

    // Verify payment adapter was called for refund
    expect(refundAdapterCalls.length).toBeGreaterThan(0);
  });

  it("should reject cancellation of shipped order with ERR_ORDER_ALREADY_SHIPPED", async () => {
    if (!superTokensAvailable) return;

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${shippedOrderId}/cancel`,
      headers: {
        "content-type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({ reason: "Trying to cancel shipped order" }),
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_ORDER_ALREADY_SHIPPED");
  });

  it("should return 404 for non-existent order", async () => {
    if (!superTokensAvailable) return;

    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${fakeId}/cancel`,
      headers: {
        "content-type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({ reason: "Should 404" }),
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_ORDER_NOT_FOUND");
  });
});
