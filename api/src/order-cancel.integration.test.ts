import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "./db/schema/inventory.js";
import { order, orderStatusHistory } from "./db/schema/order.js";
import { payment, refund } from "./db/schema/payment.js";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "./db/schema/admin.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { createHmac } from "node:crypto";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

const WEBHOOK_SECRET = "whsec_test_cancel_secret";

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

describe("order cancellation API (T053)", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;

  const ts = Date.now();
  const adminEmail = `test-cancel-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  let variantId = "";
  let locationId = "";

  // We'll create multiple orders for different test scenarios
  let unpaidOrderId = "";
  let paidOrderId = "";
  let shippedOrderId = "";
  let alreadyCanceledOrderId = "";

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
    adminUserId = user.id;

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

    // --- Create order 4: already canceled (for duplicate-cancel rejection) ---
    alreadyCanceledOrderId = await createCheckoutOrder(app, db, variantId, `cxl-already-${ts}`);
    await db
      .update(order)
      .set({ status: "canceled" })
      .where(eq(order.id, alreadyCanceledOrderId));
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
    await stopTestServer(ts_);
  });

  it("should cancel an unpaid order, release reservations, and restore inventory balance", async () => {
    const db = dbConn.db;

    // Capture inventory balance before cancel
    const [balanceBefore] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
      );

    // Verify reservations exist before cancel
    const resBefore = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, unpaidOrderId));
    const activeResBefore = resBefore.filter((r) => r.status === "active");
    expect(activeResBefore.length).toBeGreaterThan(0);
    const reservationCount = activeResBefore.length;

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
    expect(body.reservationsReleased).toBe(reservationCount);
    expect(body.refundInitiated).toBe(false);
    expect(body.refundId).toBeUndefined();

    // Verify order status is canceled
    const [orderRow] = await db.select().from(order).where(eq(order.id, unpaidOrderId));
    expect(orderRow.status).toBe("canceled");

    // Verify reservations are all released (none active)
    const resAfter = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, unpaidOrderId));
    const activeResAfter = resAfter.filter((r) => r.status === "active");
    expect(activeResAfter.length).toBe(0);

    // Verify inventory balance was restored
    const [balanceAfter] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
      );
    expect(balanceAfter.available).toBeGreaterThan(balanceBefore.available);

    // Verify order status history entry for the cancellation
    const history = await db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, unpaidOrderId))
      .orderBy(desc(orderStatusHistory.createdAt));
    const cancelEntry = history.find(
      (h) => h.statusType === "status" && h.newValue === "canceled",
    );
    expect(cancelEntry).toBeDefined();
    expect(cancelEntry!.reason).toBe("Customer changed their mind");
    expect(cancelEntry!.actorAdminUserId).toBe(adminUserId);
  });

  it("should cancel a paid order with full refund via Stripe", async () => {
    const db = dbConn.db;

    // Clear refund adapter call log
    refundAdapterCalls = [];

    // Capture the payment record to verify refund amount
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, paidOrderId));
    expect(paymentRow.amountMinor).toBeGreaterThan(0);

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
    expect(typeof body.refundId).toBe("string");
    expect(body.refundId.length).toBeGreaterThan(0);

    // Verify order status is canceled
    const [orderRow] = await db.select().from(order).where(eq(order.id, paidOrderId));
    expect(orderRow.status).toBe("canceled");
    expect(orderRow.paymentStatus).toBe("refunded");

    // Verify refund record created in DB with correct details
    const refunds = await db.select().from(refund).where(eq(refund.orderId, paidOrderId));
    expect(refunds.length).toBe(1);
    expect(refunds[0].reason).toBe("Order canceled by admin");
    expect(refunds[0].status).toBe("succeeded");
    expect(refunds[0].amountMinor).toBe(paymentRow.amountMinor);
    expect(refunds[0].paymentId).toBe(paymentRow.id);
    expect(refunds[0].actorAdminUserId).toBe(adminUserId);

    // Verify payment adapter was called with correct refund amount
    expect(refundAdapterCalls.length).toBe(1);
    expect(refundAdapterCalls[0].paymentIntentId).toBe(paymentRow.providerPaymentIntentId);
    expect(refundAdapterCalls[0].amountMinor).toBe(paymentRow.amountMinor);

    // Verify order status history includes both payment + status transitions
    const history = await db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, paidOrderId))
      .orderBy(desc(orderStatusHistory.createdAt));
    const cancelEntry = history.find(
      (h) => h.statusType === "status" && h.newValue === "canceled",
    );
    expect(cancelEntry).toBeDefined();
    expect(cancelEntry!.reason).toBe("Order canceled by admin");

    const refundEntry = history.find(
      (h) => h.statusType === "payment_status" && h.newValue === "refunded",
    );
    expect(refundEntry).toBeDefined();
  });

  it("should write an audit log entry on successful cancellation", async () => {
    const db = dbConn.db;

    // The audit log entries for paidOrderId were written by the cancel in the
    // previous test. Query them by entity_id.
    const auditEntries = await db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.entityId, paidOrderId),
          eq(adminAuditLog.action, "order.cancel"),
        ),
      );

    expect(auditEntries.length).toBeGreaterThanOrEqual(1);
    const entry = auditEntries[0];
    expect(entry.actorAdminUserId).toBe(adminUserId);
    expect(entry.entityType).toBe("order");
    expect(entry.entityId).toBe(paidOrderId);

    const afterJson = entry.afterJson as Record<string, unknown>;
    expect(afterJson.reason).toBe("Order canceled by admin");
    expect(afterJson.refundInitiated).toBe(true);
    expect(typeof afterJson.refundId).toBe("string");
  });

  it("should reject cancellation of shipped order with 400 ERR_ORDER_ALREADY_SHIPPED", async () => {
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
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);

    // Verify the shipped order status was NOT changed
    const db = dbConn.db;
    const [orderRow] = await db.select().from(order).where(eq(order.id, shippedOrderId));
    expect(orderRow.status).not.toBe("canceled");
    expect(orderRow.shippingStatus).toBe("shipped");
  });

  it("should reject cancellation of already-canceled order with ERR_INVALID_TRANSITION", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${alreadyCanceledOrderId}/cancel`,
      headers: {
        "content-type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({ reason: "Already canceled" }),
    });

    // The handler catches ERR_INVALID_TRANSITION and returns an error
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_INVALID_TRANSITION");
  });

  it("should return 404 for non-existent order", async () => {
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
    expect(typeof body.message).toBe("string");
  });

  it("should require reason field in request body", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${shippedOrderId}/cancel`,
      headers: {
        "content-type": "application/json",
        ...adminHeaders,
      },
      body: JSON.stringify({}),
    });

    // Fastify schema validation returns 400 when required field is missing
    expect(res.statusCode).toBe(400);
  });

  it("should require admin authentication to cancel", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${shippedOrderId}/cancel`,
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ reason: "No auth" }),
    });

    // Unauthenticated request should be rejected
    expect(res.statusCode).toBe(401);
  });
});
