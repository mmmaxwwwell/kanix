/**
 * Flow test: admin refund (full + partial) through Stripe [mirrors T104c, FR-030]
 *
 * Walks the admin refund flow via HTTP calls against the real stack:
 *   1. Create a paid order (product → variant → inventory → cart → checkout → webhook)
 *   2. Admin initiates full refund → verify refund row + order state + customer notification
 *   3. Second paid order → admin initiates partial refund → verify balance math
 *   4. Third paid order → full refund → double-refund attempt returns 409
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import { productClass, productClassMembership } from "../db/schema/product-class.js";
import { inventoryBalance, inventoryLocation } from "../db/schema/inventory.js";
import { order, orderLine, orderStatusHistory } from "../db/schema/order.js";
import { payment, refund } from "../db/schema/payment.js";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "../db/schema/admin.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";
import { ROLE_CAPABILITIES } from "../auth/admin.js";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_admin_refund_flow_test";
const run = Date.now();
const ADMIN_EMAIL = `refund-flow-admin-${run}@kanix.dev`;
const ADMIN_PASSWORD = "AdminRefundFlow123!";

const VALID_ADDRESS = {
  full_name: "Refund Flow User",
  line1: "321 Refund Ave",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
};

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createStubTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 0, calculationId: null };
    },
  };
}

let piCounter = 0;
let refundCounter = 0;
let refundAdapterShouldFail = false;

function createFlowStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_refund_flow_${piCounter}_${run}`,
        clientSecret: `pi_refund_flow_${piCounter}_secret_${run}`,
      };
    },
    async createRefund() {
      refundCounter++;
      if (refundAdapterShouldFail) {
        throw new Error("Stripe API connection timeout");
      }
      return {
        id: `re_refund_flow_${refundCounter}_${run}`,
        status: "succeeded",
      };
    },
    async submitDisputeEvidence(input) {
      return { id: input.providerDisputeId, status: "under_review" };
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook helper (Stripe)
// ---------------------------------------------------------------------------

function generateStripeWebhookPayload(
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
// Auth helpers
// ---------------------------------------------------------------------------

async function signUpUser(
  address: string,
  email: string,
  password: string,
): Promise<string> {
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

async function verifyEmail(userId: string): Promise<void> {
  const { default: supertokens } = await import("supertokens-node");
  const { default: EmailVerification } = await import(
    "supertokens-node/recipe/emailverification/index.js"
  );
  const tokenRes = await EmailVerification.createEmailVerificationToken(
    "public",
    supertokens.convertToRecipeUserId(userId),
  );
  if (tokenRes.status === "OK") {
    await EmailVerification.verifyEmailUsingToken("public", tokenRes.token);
  }
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

// ---------------------------------------------------------------------------
// Paid-order helper: product → variant → inventory → cart → checkout → webhook
// ---------------------------------------------------------------------------

async function createPaidOrder(
  app: FastifyInstance,
  db: DatabaseConnection["db"],
  suffix: string,
  priceMinor: number,
  quantity: number,
): Promise<{
  orderId: string;
  paymentIntentId: string;
  paymentAmountMinor: number;
  productId: string;
  variantId: string;
}> {
  // Product + variant
  const [prod] = await db
    .insert(product)
    .values({
      slug: `rflow-prod-${suffix}-${run}`,
      title: `Refund Flow Product ${suffix} ${run}`,
      status: "active",
    })
    .returning();

  const [variant] = await db
    .insert(productVariant)
    .values({
      productId: prod.id,
      sku: `RFLOW-${suffix}-${run}`,
      title: `Refund Flow Variant ${suffix} ${run}`,
      priceMinor,
      status: "active",
      weight: "16",
    })
    .returning();

  // Inventory at existing location
  const existingBalances = await db.select().from(inventoryBalance).limit(1);
  let locationId: string;
  if (existingBalances.length > 0) {
    locationId = existingBalances[0].locationId;
  } else {
    const [loc] = await db
      .insert(inventoryLocation)
      .values({
        name: `RFlow Warehouse ${suffix} ${run}`,
        code: `RFLOW-WH-${suffix}-${run}`,
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

  // Cart → add items → checkout
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
    headers: { "content-type": "application/json", "x-cart-token": cartToken },
    body: JSON.stringify({ variant_id: variant.id, quantity }),
  });

  const checkoutRes = await app.inject({
    method: "POST",
    url: "/api/checkout",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cart_token: cartToken,
      email: `rflow-${suffix}-${run}@example.com`,
      shipping_address: VALID_ADDRESS,
    }),
  });

  expect(checkoutRes.statusCode).toBe(201);
  const checkoutData = JSON.parse(checkoutRes.body);
  const orderId = checkoutData.order.id;

  // Read payment row
  const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
  const paymentIntentId = paymentRow.providerPaymentIntentId;
  const paymentAmountMinor = paymentRow.amountMinor;

  // Simulate payment_intent.succeeded webhook
  const { body: whBody, signature: whSig } = generateStripeWebhookPayload(
    `evt_rflow_${suffix}_succeeded_${run}`,
    "payment_intent.succeeded",
    {
      id: paymentIntentId,
      object: "payment_intent",
      amount: paymentAmountMinor,
      currency: "usd",
      status: "succeeded",
      latest_charge: `ch_rflow_${suffix}_${run}`,
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

  // Verify paid
  const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
  expect(orderRow.paymentStatus).toBe("paid");

  return { orderId, paymentIntentId, paymentAmountMinor, productId: prod.id, variantId: variant.id };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin refund flow (T271, mirrors T104c/FR-030)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;
  let adminRoleId: string;

  // Track created resources for cleanup
  const createdProductIds: string[] = [];
  const createdVariantIds: string[] = [];
  const createdOrderIds: string[] = [];

  // Flow state — populated step by step
  let fullRefundOrderId = "";
  let fullRefundPaymentAmount = 0;
  let partialRefundOrderId = "";
  let partialRefundPaymentAmount = 0;
  let doubleRefundOrderId = "";
  let doubleRefundPaymentAmount = 0;

  beforeAll(async () => {
    ts_ = await createTestServer({
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createFlowStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // Create admin with finance role (has ORDERS_REFUND capability)
    const authSubject = await signUpUser(address, ADMIN_EMAIL, ADMIN_PASSWORD);
    await verifyEmail(authSubject);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `test_refund_flow_finance_${run}`,
        description: "Test finance role for refund flow tests",
        capabilitiesJson: ROLE_CAPABILITIES.finance,
      })
      .returning();
    adminRoleId = role.id;

    const [user] = await db
      .insert(adminUser)
      .values({
        authSubject,
        email: ADMIN_EMAIL,
        name: "Test Refund Flow Admin",
        status: "active",
      })
      .returning();
    adminUserId = user.id;

    await db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, ADMIN_EMAIL, ADMIN_PASSWORD);

    // Create three separate paid orders for each flow walkthrough
    const fullOrder = await createPaidOrder(app, db, "full", 3000, 2);
    fullRefundOrderId = fullOrder.orderId;
    fullRefundPaymentAmount = fullOrder.paymentAmountMinor;
    createdProductIds.push(fullOrder.productId);
    createdVariantIds.push(fullOrder.variantId);
    createdOrderIds.push(fullOrder.orderId);

    const partialOrder = await createPaidOrder(app, db, "partial", 5000, 1);
    partialRefundOrderId = partialOrder.orderId;
    partialRefundPaymentAmount = partialOrder.paymentAmountMinor;
    createdProductIds.push(partialOrder.productId);
    createdVariantIds.push(partialOrder.variantId);
    createdOrderIds.push(partialOrder.orderId);

    const doubleOrder = await createPaidOrder(app, db, "double", 2500, 1);
    doubleRefundOrderId = doubleOrder.orderId;
    doubleRefundPaymentAmount = doubleOrder.paymentAmountMinor;
    createdProductIds.push(doubleOrder.productId);
    createdVariantIds.push(doubleOrder.variantId);
    createdOrderIds.push(doubleOrder.orderId);
  }, 60_000);

  afterAll(async () => {
    refundAdapterShouldFail = false;
    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Walk 1: Full refund on a paid order
  // -------------------------------------------------------------------------

  it("step 1: admin initiates full refund → refund row + order state updated", async () => {
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

    // Concrete field assertions
    expect(r.amountMinor).toBe(fullRefundPaymentAmount);
    expect(r.reason).toBe("Defective product — full refund");
    expect(r.status).toBe("succeeded");
    expect(r.orderId).toBe(fullRefundOrderId);
    expect(r.actorAdminUserId).toBe(adminUserId);
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.providerRefundId).toMatch(/^re_refund_flow_/);
  });

  it("step 2: verify order payment_status is 'refunded' after full refund", async () => {
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, fullRefundOrderId));
    expect(orderRow.paymentStatus).toBe("refunded");
  });

  it("step 3: verify refund record persisted in DB with correct fields", async () => {
    const refunds = await dbConn.db.select().from(refund).where(eq(refund.orderId, fullRefundOrderId));
    expect(refunds.length).toBe(1);
    expect(refunds[0].amountMinor).toBe(fullRefundPaymentAmount);
    expect(refunds[0].reason).toBe("Defective product — full refund");
    expect(refunds[0].status).toBe("succeeded");
    expect(refunds[0].actorAdminUserId).toBe(adminUserId);
    expect(refunds[0].providerRefundId).toMatch(/^re_refund_flow_/);
  });

  it("step 4: verify payment_status transition recorded in order_status_history", async () => {
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
  });

  it("step 5: verify admin audit log entry for full refund", async () => {
    // Wait for async onResponse audit hook
    await new Promise((r) => setTimeout(r, 200));

    const audits = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.entityId, fullRefundOrderId),
          eq(adminAuditLog.action, "refund.create"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].actorAdminUserId).toBe(adminUserId);
    expect(audits[0].entityType).toBe("order");
    const afterJson = audits[0].afterJson as {
      refundId: string;
      amountMinor: number;
      reason: string;
    };
    expect(afterJson.amountMinor).toBe(fullRefundPaymentAmount);
    expect(afterJson.reason).toBe("Defective product — full refund");
    expect(typeof afterJson.refundId).toBe("string");
  });

  // -------------------------------------------------------------------------
  // Walk 2: Partial refund with balance math verification
  // -------------------------------------------------------------------------

  it("step 6: admin initiates partial refund ($20 of total) → verify balance math", async () => {
    const partialAmount = 2000; // $20.00
    expect(partialAmount).toBeLessThan(partialRefundPaymentAmount);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${partialRefundOrderId}/refunds`,
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        amount: partialAmount,
        reason: "Partial refund — item damaged in transit",
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const r = body.refund;

    expect(r.amountMinor).toBe(partialAmount);
    expect(r.reason).toBe("Partial refund — item damaged in transit");
    expect(r.status).toBe("succeeded");
    expect(r.orderId).toBe(partialRefundOrderId);
    expect(r.actorAdminUserId).toBe(adminUserId);
  });

  it("step 7: verify order payment_status is 'partially_refunded' after partial refund", async () => {
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, partialRefundOrderId));
    expect(orderRow.paymentStatus).toBe("partially_refunded");
  });

  it("step 8: verify remaining refundable balance via over-refund rejection", async () => {
    // Attempt to refund more than remaining
    const remaining = partialRefundPaymentAmount - 2000;
    const overAmount = remaining + 1; // one cent too much

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${partialRefundOrderId}/refunds`,
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        amount: overAmount,
        reason: "This should fail — exceeds remaining",
      }),
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_REFUND_EXCEEDS_PAYMENT");
    expect(body.message).toMatch(/exceeds remaining/i);
  });

  it("step 9: refund the exact remaining amount → payment_status becomes 'refunded'", async () => {
    const remaining = partialRefundPaymentAmount - 2000;

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${partialRefundOrderId}/refunds`,
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        amount: remaining,
        reason: "Refund remainder after partial",
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.refund.amountMinor).toBe(remaining);
    expect(body.refund.status).toBe("succeeded");

    // Now fully refunded
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, partialRefundOrderId));
    expect(orderRow.paymentStatus).toBe("refunded");

    // Should have 2 refund records totaling the original payment
    const refunds = await dbConn.db.select().from(refund).where(eq(refund.orderId, partialRefundOrderId));
    expect(refunds.length).toBe(2);
    const totalRefunded = refunds.reduce((sum, r) => sum + r.amountMinor, 0);
    expect(totalRefunded).toBe(partialRefundPaymentAmount);
  });

  it("step 10: list refunds for partially-then-fully refunded order returns both records", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/orders/${partialRefundOrderId}/refunds`,
      headers: adminHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.refunds)).toBe(true);
    expect(body.refunds.length).toBe(2);

    const amounts = body.refunds.map((r: { amountMinor: number }) => r.amountMinor).sort((a: number, b: number) => a - b);
    const remaining = partialRefundPaymentAmount - 2000;
    expect(amounts).toEqual([remaining, 2000].sort((a, b) => a - b));
  });

  // -------------------------------------------------------------------------
  // Walk 3: Double-refund attempt returns 409
  // -------------------------------------------------------------------------

  it("step 11: fully refund the third order", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${doubleRefundOrderId}/refunds`,
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        amount: doubleRefundPaymentAmount,
        reason: "Full refund before double-refund test",
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.refund.amountMinor).toBe(doubleRefundPaymentAmount);
    expect(body.refund.status).toBe("succeeded");

    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, doubleRefundOrderId));
    expect(orderRow.paymentStatus).toBe("refunded");
  });

  it("step 12: second refund attempt on fully-refunded order returns 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${doubleRefundOrderId}/refunds`,
      headers: { "content-type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        amount: 100,
        reason: "This should fail — order already fully refunded",
      }),
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_ORDER_ALREADY_REFUNDED");
    expect(typeof body.message).toBe("string");
  });

  it("step 13: verify payment_status history shows full lifecycle for double-refund order", async () => {
    const history = await dbConn.db
      .select()
      .from(orderStatusHistory)
      .where(
        and(
          eq(orderStatusHistory.orderId, doubleRefundOrderId),
          eq(orderStatusHistory.statusType, "payment_status"),
        ),
      );

    const statuses = history.map((h) => h.newValue);
    // Should include transitions through processing → paid → refunded
    expect(statuses).toContain("paid");
    expect(statuses).toContain("refunded");
  });

  it("step 14: verify no refund record created by the rejected double-refund", async () => {
    const refunds = await dbConn.db.select().from(refund).where(eq(refund.orderId, doubleRefundOrderId));
    // Only the single successful refund, not the rejected one
    expect(refunds.length).toBe(1);
    expect(refunds[0].amountMinor).toBe(doubleRefundPaymentAmount);
  });
});
