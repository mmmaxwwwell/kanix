import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { order } from "./db/schema/order.js";
import { orderStatusHistory } from "./db/schema/order.js";
import { payment, refund } from "./db/schema/payment.js";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "./db/schema/admin.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { createHmac } from "node:crypto";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

const WEBHOOK_SECRET = "whsec_test_refund_secret";

function createStubTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 0, calculationId: null };
    },
  };
}

let paymentAdapterCallCount = 0;
let refundAdapterCallCount = 0;
let refundAdapterShouldFail = false;

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
      if (refundAdapterShouldFail) {
        throw new Error("Stripe API connection timeout");
      }
      return {
        id: `re_test_${refundAdapterCallCount}_${Date.now()}`,
        status: "succeeded",
      };
    },
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
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

/**
 * Create a paid order: product → variant → inventory → cart → checkout → webhook.
 * Returns { orderId, paymentIntentId, paymentAmountMinor }.
 */
async function createPaidOrder(
  app: FastifyInstance,
  db: DatabaseConnection["db"],
  ts: number,
  suffix: string,
): Promise<{ orderId: string; paymentIntentId: string; paymentAmountMinor: number }> {
  const [prod] = await db
    .insert(product)
    .values({
      slug: `refund-test-prod-${suffix}-${ts}`,
      title: `Refund Test Product ${suffix} ${ts}`,
      status: "active",
    })
    .returning();

  const [variant] = await db
    .insert(productVariant)
    .values({
      productId: prod.id,
      sku: `RFD-${suffix}-${ts}`,
      title: `Refund Variant ${suffix} ${ts}`,
      priceMinor: 2500,
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
        name: `Refund Warehouse ${suffix} ${ts}`,
        code: `RFD-WH-${suffix}-${ts}`,
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
    body: JSON.stringify({ variant_id: variant.id, quantity: 2 }),
  });

  const checkoutRes = await app.inject({
    method: "POST",
    url: "/api/checkout",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cart_token: cartToken,
      email: `refund-${suffix}-${ts}@example.com`,
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
  const orderId = checkoutData.order.id;

  const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
  const paymentIntentId = paymentRow.providerPaymentIntentId;
  const paymentAmountMinor = paymentRow.amountMinor;

  // Simulate payment success via webhook
  const { body: whBody, signature: whSig } = generateWebhookPayload(
    `evt_refund_${suffix}_succeeded_${ts}`,
    "payment_intent.succeeded",
    {
      id: paymentIntentId,
      object: "payment_intent",
      amount: paymentAmountMinor,
      currency: "usd",
      status: "succeeded",
      latest_charge: `ch_refund_${suffix}_${ts}`,
    },
    WEBHOOK_SECRET,
  );

  const whRes = await app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": whSig },
    body: whBody,
  });
  expect(whRes.statusCode).toBe(200);

  const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
  expect(orderRow.paymentStatus).toBe("paid");

  return { orderId, paymentIntentId, paymentAmountMinor };
}

describe("refund API (T052, FR-030)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;

  const ts = Date.now();
  const adminEmail = `test-refund-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  // Separate orders for independent test scenarios
  let partialOrderId = "";
  let partialPaymentAmount = 0;
  let fullRefundOrderId = "";
  let fullRefundPaymentAmount = 0;
  let stripeFailOrderId = "";

  beforeAll(async () => {
    ts_ = await createTestServer({
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // Create admin user with finance role (has ORDERS_REFUND capability)
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
    adminUserId = user.id;

    await db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Create separate paid orders for each test scenario
    const partial = await createPaidOrder(app, db, ts, "partial");
    partialOrderId = partial.orderId;
    partialPaymentAmount = partial.paymentAmountMinor;

    const full = await createPaidOrder(app, db, ts, "full");
    fullRefundOrderId = full.orderId;
    fullRefundPaymentAmount = full.paymentAmountMinor;

    const fail = await createPaidOrder(app, db, ts, "fail");
    stripeFailOrderId = fail.orderId;
  }, 60_000);

  afterAll(async () => {
    refundAdapterShouldFail = false;
    await stopTestServer(ts_);
  });

  it("should process a partial refund with concrete field assertions", async () => {
    const partialAmount = 1000; // $10.00

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${partialOrderId}/refunds`,
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        amount: partialAmount,
        reason: "Customer requested partial refund",
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const r = body.refund;

    // Concrete field assertions — no toBeDefined/toBeTruthy
    expect(r.amountMinor).toBe(partialAmount);
    expect(r.reason).toBe("Customer requested partial refund");
    expect(r.status).toBe("succeeded");
    expect(r.orderId).toBe(partialOrderId);
    expect(typeof r.id).toBe("string");
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof r.providerRefundId).toBe("string");
    expect(r.providerRefundId).toMatch(/^re_test_/);
    expect(r.actorAdminUserId).toBe(adminUserId);

    // Verify payment_status is partially_refunded
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, partialOrderId));
    expect(orderRow.paymentStatus).toBe("partially_refunded");

    // Verify refund record in DB
    const refunds = await dbConn.db.select().from(refund).where(eq(refund.orderId, partialOrderId));
    expect(refunds.length).toBe(1);
    expect(refunds[0].amountMinor).toBe(partialAmount);
    expect(refunds[0].reason).toBe("Customer requested partial refund");
    expect(refunds[0].actorAdminUserId).toBe(adminUserId);

    // Verify order_status_history has the payment_status transition
    const history = await dbConn.db
      .select()
      .from(orderStatusHistory)
      .where(
        and(
          eq(orderStatusHistory.orderId, partialOrderId),
          eq(orderStatusHistory.statusType, "payment_status"),
          eq(orderStatusHistory.newValue, "partially_refunded"),
        ),
      );
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].oldValue).toBe("paid");
    expect(history[0].reason).toMatch(/Admin refund.*1000 cents/);
  });

  it("should process a full refund against a paid order and update status + fire event", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${fullRefundOrderId}/refunds`,
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        amount: fullRefundPaymentAmount,
        reason: "Defective product — full refund",
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const r = body.refund;

    expect(r.amountMinor).toBe(fullRefundPaymentAmount);
    expect(r.reason).toBe("Defective product — full refund");
    expect(r.status).toBe("succeeded");
    expect(r.orderId).toBe(fullRefundOrderId);
    expect(r.actorAdminUserId).toBe(adminUserId);
    expect(r.providerRefundId).toMatch(/^re_test_/);

    // Verify payment_status is now "refunded"
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, fullRefundOrderId));
    expect(orderRow.paymentStatus).toBe("refunded");

    // Verify the status transition event was recorded
    const history = await dbConn.db
      .select()
      .from(orderStatusHistory)
      .where(
        and(
          eq(orderStatusHistory.orderId, fullRefundOrderId),
          eq(orderStatusHistory.statusType, "payment_status"),
          eq(orderStatusHistory.newValue, "refunded"),
        ),
      );
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].oldValue).toBe("paid");
    expect(history[0].reason).toMatch(/Admin refund/);
    expect(history[0].actorAdminUserId).toBe(adminUserId);

    // Verify refund record in DB
    const refunds = await dbConn.db
      .select()
      .from(refund)
      .where(eq(refund.orderId, fullRefundOrderId));
    expect(refunds.length).toBe(1);
    expect(refunds[0].amountMinor).toBe(fullRefundPaymentAmount);
  });

  it("should reject refund on already-refunded order with 409", async () => {
    // fullRefundOrderId is already fully refunded from previous test
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${fullRefundOrderId}/refunds`,
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        amount: 100,
        reason: "This should fail — order already refunded",
      }),
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_ORDER_ALREADY_REFUNDED");
    expect(typeof body.message).toBe("string");
  });

  it("should reject over-refund (amount exceeds remaining) with 400", async () => {
    // partialOrderId has remaining = partialPaymentAmount - 1000
    const overAmount = partialPaymentAmount; // more than remaining

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${partialOrderId}/refunds`,
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        amount: overAmount,
        reason: "Exceeds remaining amount",
      }),
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_REFUND_EXCEEDS_PAYMENT");
    expect(typeof body.message).toBe("string");
    expect(body.message).toMatch(/exceeds remaining/i);
  });

  it("should handle Stripe failure — return 502 and keep order state unchanged", async () => {
    // Record order state before the failed refund
    const [beforeOrder] = await dbConn.db
      .select()
      .from(order)
      .where(eq(order.id, stripeFailOrderId));
    expect(beforeOrder.paymentStatus).toBe("paid");

    refundAdapterShouldFail = true;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/orders/${stripeFailOrderId}/refunds`,
        headers: { "content-type": "application/json", ...adminHeaders },
        body: JSON.stringify({
          amount: 500,
          reason: "Stripe should fail",
        }),
      });

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_REFUND_PROVIDER_FAILURE");
    } finally {
      refundAdapterShouldFail = false;
    }

    // Verify order payment_status is unchanged
    const [afterOrder] = await dbConn.db
      .select()
      .from(order)
      .where(eq(order.id, stripeFailOrderId));
    expect(afterOrder.paymentStatus).toBe("paid");

    // Verify no refund record was created
    const refunds = await dbConn.db
      .select()
      .from(refund)
      .where(eq(refund.orderId, stripeFailOrderId));
    expect(refunds.length).toBe(0);
  });

  it("should write admin audit log entry for each refund with actor + reason", async () => {
    // Wait briefly for async onResponse audit hook to complete
    await new Promise((r) => setTimeout(r, 200));

    // Check audit log for the partial refund
    const partialAudits = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(
        and(eq(adminAuditLog.entityId, partialOrderId), eq(adminAuditLog.action, "refund.create")),
      );
    expect(partialAudits.length).toBeGreaterThanOrEqual(1);
    const partialAudit = partialAudits[0];
    expect(partialAudit.actorAdminUserId).toBe(adminUserId);
    expect(partialAudit.entityType).toBe("order");
    const partialAfter = partialAudit.afterJson as {
      refundId: string;
      amountMinor: number;
      reason: string;
    };
    expect(partialAfter.amountMinor).toBe(1000);
    expect(partialAfter.reason).toBe("Customer requested partial refund");
    expect(typeof partialAfter.refundId).toBe("string");

    // Check audit log for the full refund
    const fullAudits = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.entityId, fullRefundOrderId),
          eq(adminAuditLog.action, "refund.create"),
        ),
      );
    expect(fullAudits.length).toBeGreaterThanOrEqual(1);
    const fullAudit = fullAudits[0];
    expect(fullAudit.actorAdminUserId).toBe(adminUserId);
    const fullAfter = fullAudit.afterJson as {
      refundId: string;
      amountMinor: number;
      reason: string;
    };
    expect(fullAfter.amountMinor).toBe(fullRefundPaymentAmount);
    expect(fullAfter.reason).toBe("Defective product — full refund");
  });

  it("should list refunds for an order with correct shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/orders/${partialOrderId}/refunds`,
      headers: adminHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.refunds)).toBe(true);
    expect(body.refunds.length).toBe(1);
    const r = body.refunds[0];
    expect(r.amountMinor).toBe(1000);
    expect(r.reason).toBe("Customer requested partial refund");
    expect(r.status).toBe("succeeded");
    expect(r.orderId).toBe(partialOrderId);
  });

  it("should return 404 for refund on non-existent order", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${fakeId}/refunds`,
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({ amount: 100, reason: "Should 404" }),
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_ORDER_NOT_FOUND");
    expect(typeof body.message).toBe("string");
  });
});
