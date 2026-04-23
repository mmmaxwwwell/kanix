import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";
import type { DatabaseConnection } from "./db/connection.js";
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

const WEBHOOK_SECRET = "whsec_test_webhook_secret_for_tests";

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
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
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

/**
 * Helper: seed a product + variant + inventory + cart + checkout to get an
 * order with a payment record. Returns the IDs needed for webhook tests.
 */
async function seedOrderWithPayment(
  app: FastifyInstance,
  db: DatabaseConnection["db"],
  ts: number,
  label: string,
  opts: { quantity?: number; priceMinor?: number } = {},
): Promise<{
  orderId: string;
  paymentIntentId: string;
  paymentRecordId: string;
  variantId: string;
}> {
  const quantity = opts.quantity ?? 2;
  const priceMinor = opts.priceMinor ?? 1500;

  const [prod] = await db
    .insert(product)
    .values({
      slug: `whk-${label}-prod-${ts}`,
      title: `WHK ${label} Product ${ts}`,
      status: "active",
    })
    .returning();

  const [variant] = await db
    .insert(productVariant)
    .values({
      productId: prod.id,
      sku: `WHK-${label.toUpperCase()}-${ts}`,
      title: `WHK ${label} Variant ${ts}`,
      priceMinor,
      status: "active",
      weight: "16",
    })
    .returning();

  // Use existing location or create one
  const existingBalances = await db.select().from(inventoryBalance).limit(1);
  let locationId: string;
  if (existingBalances.length > 0) {
    locationId = existingBalances[0].locationId;
  } else {
    const [loc] = await db
      .insert(inventoryLocation)
      .values({
        name: `WHK ${label} WH ${ts}`,
        code: `WHK-${label.toUpperCase()}-WH-${ts}`,
        type: "warehouse",
      })
      .returning();
    locationId = loc.id;
  }

  await db.insert(inventoryBalance).values({
    variantId: variant.id,
    locationId,
    onHand: 50,
    reserved: 0,
    available: 50,
  });

  // Cart → add items → checkout
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
    body: JSON.stringify({ variant_id: variant.id, quantity }),
  });

  const checkoutRes = await app.inject({
    method: "POST",
    url: "/api/checkout",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cart_token: cartToken,
      email: `whk-${label}-${ts}@example.com`,
      shipping_address: {
        full_name: `WHK ${label} Tester`,
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
  const orderId = checkoutData.order.id;

  const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));

  return {
    orderId,
    paymentIntentId: paymentRow.providerPaymentIntentId,
    paymentRecordId: paymentRow.id,
    variantId: variant.id,
  };
}

// ---------------------------------------------------------------------------
// Main webhook handler tests (T236)
// ---------------------------------------------------------------------------
describe("Stripe webhook handler (T236)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now();

  let orderId = "";
  let paymentIntentId = "";
  let paymentRecordId = "";

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

    const result = await seedOrderWithPayment(app, dbConn.db, ts, "main");
    orderId = result.orderId;
    paymentIntentId = result.paymentIntentId;
    paymentRecordId = result.paymentRecordId;
  });

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  // ---- Signature verification ----

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
    expect(body.message).toMatch(/missing/i);
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
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("should return 401 for signature signed with wrong secret", async () => {
    const { body, signature } = generateWebhookPayload(
      `evt_wrong_secret_${ts}`,
      "payment_intent.succeeded",
      { id: paymentIntentId, object: "payment_intent", status: "succeeded" },
      "whsec_WRONG_SECRET",
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

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("ERR_INVALID_SIGNATURE");
  });

  // ---- payment_intent.succeeded ----

  it("should handle payment_intent.succeeded and confirm order", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_succeeded_${ts}`;
    const chargeId = `ch_test_${ts}`;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 3599,
        currency: "usd",
        status: "succeeded",
        latest_charge: chargeId,
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
    expect(paymentRow.providerChargeId).toBe(chargeId);

    // Verify payment_event record created with concrete fields
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, eventId));
    expect(eventRow.eventType).toBe("payment_intent.succeeded");
    expect(eventRow.paymentId).toBe(paymentRecordId);
    expect(eventRow.providerEventId).toBe(eventId);
    expect(eventRow.payloadJson).toMatchObject({
      id: paymentIntentId,
      object: "payment_intent",
      status: "succeeded",
    });
    expect(eventRow.createdAt).toBeInstanceOf(Date);

    // Verify reservations consumed
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    expect(reservations.length).toBeGreaterThan(0);
    for (const r of reservations) {
      expect(r.status).toBe("consumed");
    }
  });

  // ---- Idempotency ----

  it("should handle duplicate webhook as no-op (idempotency)", async () => {
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

    // Verify order state unchanged (still confirmed, not double-processed)
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.status).toBe("confirmed");
    expect(orderRow.paymentStatus).toBe("paid");
  });

  // ---- charge.dispute.created ----

  it("should handle charge.dispute.created and create dispute record", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_dispute_${ts}`;
    const disputeId = `dp_test_${ts}`;
    const chargeId = `ch_test_${ts}`;
    const createdTime = Math.floor(Date.now() / 1000);
    const dueByTime = createdTime + 7 * 24 * 60 * 60;

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
        evidence_details: { due_by: dueByTime },
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
    expect(JSON.parse(res.body).received).toBe(true);

    // Verify dispute record created with concrete fields
    const [disputeRow] = await db
      .select()
      .from(dispute)
      .where(eq(dispute.providerDisputeId, disputeId));
    expect(disputeRow.reason).toBe("fraudulent");
    expect(disputeRow.amountMinor).toBe(3599);
    expect(disputeRow.currency).toBe("USD");
    expect(disputeRow.orderId).toBe(orderId);
    expect(disputeRow.paymentId).toBe(paymentRecordId);
    expect(disputeRow.status).toBe("opened");
    expect(disputeRow.openedAt).toBeInstanceOf(Date);
    expect(disputeRow.dueBy).toBeInstanceOf(Date);

    // Verify payment_event stored for the dispute event
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, eventId));
    expect(eventRow.eventType).toBe("charge.dispute.created");
    expect(eventRow.paymentId).toBe(paymentRecordId);

    // Verify order payment_status changed to disputed
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("disputed");
  });

  // ---- charge.dispute.closed (won) ----

  it("should handle charge.dispute.closed (won) and revert payment_status to paid", async () => {
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
    expect(disputeRow.status).toBe("closed");
    expect(disputeRow.closedAt).toBeInstanceOf(Date);
    expect(disputeRow.closedAt!.getTime()).toBeGreaterThan(0);

    // Verify payment_event stored for close event
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, closeEventId));
    expect(eventRow.eventType).toBe("charge.dispute.closed");
    expect(eventRow.paymentId).toBe(paymentRecordId);

    // Verify order payment_status reverted to paid (dispute won)
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("paid");
  });

  // ---- Unhandled event type ----

  it("should return 200 for unhandled event types (acknowledge without processing)", async () => {
    const eventId = `evt_test_unhandled_${ts}`;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "customer.subscription.created",
      { id: "sub_test_123", object: "subscription", status: "active" },
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
    expect(JSON.parse(res.body).received).toBe(true);

    // Verify NO payment_event record stored for unhandled types
    const events = await dbConn.db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, eventId));
    expect(events.length).toBe(0);
  });

  // ---- Unknown payment intent ----

  it("should return 200 with skipped=true for unknown payment intent", async () => {
    const eventId = `evt_test_unknown_pi_${ts}`;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: "pi_DOES_NOT_EXIST",
        object: "payment_intent",
        amount: 999,
        currency: "usd",
        status: "succeeded",
        latest_charge: "ch_unknown",
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
    expect(resBody.skipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dispute close (lost) — needs its own order lifecycle
// ---------------------------------------------------------------------------
describe("Stripe webhook — dispute close lost (T236)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now() + 3;

  let orderId = "";
  let paymentIntentId = "";
  let paymentRecordId = "";

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

    const result = await seedOrderWithPayment(app, dbConn.db, ts, "dlost");
    orderId = result.orderId;
    paymentIntentId = result.paymentIntentId;
    paymentRecordId = result.paymentRecordId;

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
    await stopTestServer(ts_);
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

    // Verify dispute is now closed with concrete assertions
    const [disputeRow] = await db
      .select()
      .from(dispute)
      .where(eq(dispute.providerDisputeId, disputeId));
    expect(disputeRow.status).toBe("closed");
    expect(disputeRow.closedAt).toBeInstanceOf(Date);
    expect(disputeRow.reason).toBe("product_not_received");
    expect(disputeRow.amountMinor).toBe(2500);

    // Verify payment_event stored
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, closeEventId));
    expect(eventRow.eventType).toBe("charge.dispute.closed");
    expect(eventRow.paymentId).toBe(paymentRecordId);

    // Verify order payment_status changed to refunded (dispute lost)
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("refunded");
  });
});

// ---------------------------------------------------------------------------
// payment_intent.payment_failed — needs own order (before payment)
// ---------------------------------------------------------------------------
describe("Stripe webhook — payment_failed (T236)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now() + 1;

  let orderId = "";
  let paymentIntentId = "";
  let paymentRecordId = "";

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

    const result = await seedOrderWithPayment(app, dbConn.db, ts, "fail", {
      quantity: 3,
      priceMinor: 1000,
    });
    orderId = result.orderId;
    paymentIntentId = result.paymentIntentId;
    paymentRecordId = result.paymentRecordId;
  });

  afterAll(async () => {
    await stopTestServer(ts_);
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
    expect(JSON.parse(res.body).received).toBe(true);

    // Verify order payment_status is failed
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("failed");

    // Verify payment record status
    const [paymentRow] = await db.select().from(payment).where(eq(payment.id, paymentRecordId));
    expect(paymentRow.status).toBe("failed");

    // Verify reservations released
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    expect(reservations.length).toBeGreaterThan(0);
    for (const r of reservations) {
      expect(r.status).toBe("released");
    }

    // Verify payment_event stored with concrete fields
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, eventId));
    expect(eventRow.eventType).toBe("payment_intent.payment_failed");
    expect(eventRow.paymentId).toBe(paymentRecordId);
    expect(eventRow.payloadJson).toMatchObject({
      id: paymentIntentId,
      status: "requires_payment_method",
    });
  });
});

// ---------------------------------------------------------------------------
// charge.refunded — full and partial refund via webhook
// ---------------------------------------------------------------------------
describe("Stripe webhook — charge.refunded (T236)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now() + 4;

  let orderId = "";
  let paymentIntentId = "";
  let paymentRecordId = "";

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

    const result = await seedOrderWithPayment(app, dbConn.db, ts, "refund", {
      quantity: 2,
      priceMinor: 2000,
    });
    orderId = result.orderId;
    paymentIntentId = result.paymentIntentId;
    paymentRecordId = result.paymentRecordId;

    // Simulate payment_intent.succeeded first (order must be paid before refund)
    const { body: piBody, signature: piSig } = generateWebhookPayload(
      `evt_pi_succeeded_refund_${ts}`,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 4599,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_refund_${ts}`,
      },
      WEBHOOK_SECRET,
    );

    const piRes = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": piSig,
      },
      body: piBody,
    });
    expect(piRes.statusCode).toBe(200);
  });

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  it("should handle charge.refunded (full refund) and update payment_status", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_refund_full_${ts}`;
    const chargeId = `ch_refund_${ts}`;

    // Get the actual payment amount so we can do a "full" refund
    const [paymentRow] = await db.select().from(payment).where(eq(payment.id, paymentRecordId));
    const fullAmount = paymentRow.amountMinor;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "charge.refunded",
      {
        id: chargeId,
        object: "charge",
        payment_intent: paymentIntentId,
        amount: fullAmount,
        amount_refunded: fullAmount,
        currency: "usd",
        refunded: true,
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
    expect(JSON.parse(res.body).received).toBe(true);

    // Verify order payment_status is refunded
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("refunded");

    // Verify payment_event stored
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, eventId));
    expect(eventRow.eventType).toBe("charge.refunded");
    expect(eventRow.paymentId).toBe(paymentRecordId);
    expect(eventRow.payloadJson).toMatchObject({
      id: chargeId,
      object: "charge",
      amount_refunded: fullAmount,
    });
  });
});

// ---------------------------------------------------------------------------
// charge.refunded — partial refund (separate order to avoid state collision)
// ---------------------------------------------------------------------------
describe("Stripe webhook — partial refund (T236)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now() + 5;

  let orderId = "";
  let paymentIntentId = "";
  let paymentRecordId = "";

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

    const result = await seedOrderWithPayment(app, dbConn.db, ts, "partial-refund", {
      quantity: 2,
      priceMinor: 3000,
    });
    orderId = result.orderId;
    paymentIntentId = result.paymentIntentId;
    paymentRecordId = result.paymentRecordId;

    // Payment succeeded
    const { body: piBody, signature: piSig } = generateWebhookPayload(
      `evt_pi_succeeded_partial_${ts}`,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 6599,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_partial_${ts}`,
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
  });

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  it("should handle charge.refunded (partial) and set payment_status to partially_refunded", async () => {
    const db = dbConn.db;
    const eventId = `evt_test_refund_partial_${ts}`;
    const chargeId = `ch_partial_${ts}`;

    // Get the actual payment amount
    const [paymentRow] = await db.select().from(payment).where(eq(payment.id, paymentRecordId));
    const partialAmount = Math.floor(paymentRow.amountMinor / 2); // Refund half

    const { body, signature } = generateWebhookPayload(
      eventId,
      "charge.refunded",
      {
        id: chargeId,
        object: "charge",
        payment_intent: paymentIntentId,
        amount: paymentRow.amountMinor,
        amount_refunded: partialAmount,
        currency: "usd",
        refunded: false, // partial refund -> not fully refunded
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
    expect(JSON.parse(res.body).received).toBe(true);

    // Verify order payment_status is partially_refunded
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.paymentStatus).toBe("partially_refunded");

    // Verify payment_event stored
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, eventId));
    expect(eventRow.eventType).toBe("charge.refunded");
    expect(eventRow.paymentId).toBe(paymentRecordId);
  });
});

// ---------------------------------------------------------------------------
// Event ordering: dispute-before-succeeded (out-of-order delivery)
// ---------------------------------------------------------------------------
describe("Stripe webhook — event ordering: dispute-before-succeeded (T236)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now() + 6;

  let orderId = "";
  let paymentIntentId = "";
  let paymentRecordId = "";

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

    const result = await seedOrderWithPayment(app, dbConn.db, ts, "ordering");
    orderId = result.orderId;
    paymentIntentId = result.paymentIntentId;
    paymentRecordId = result.paymentRecordId;
  });

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  it("should handle succeeded-then-dispute ordering correctly", async () => {
    const db = dbConn.db;

    // Step 1: payment_intent.succeeded
    const { body: succBody, signature: succSig } = generateWebhookPayload(
      `evt_ordering_succ_${ts}`,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 3599,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_ordering_${ts}`,
      },
      WEBHOOK_SECRET,
    );

    const succRes = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": succSig,
      },
      body: succBody,
    });
    expect(succRes.statusCode).toBe(200);

    // Verify order confirmed + paid
    const [afterSucc] = await db.select().from(order).where(eq(order.id, orderId));
    expect(afterSucc.status).toBe("confirmed");
    expect(afterSucc.paymentStatus).toBe("paid");

    // Step 2: charge.dispute.created (while already paid)
    const { body: dispBody, signature: dispSig } = generateWebhookPayload(
      `evt_ordering_disp_${ts}`,
      "charge.dispute.created",
      {
        id: `dp_ordering_${ts}`,
        object: "dispute",
        charge: `ch_ordering_${ts}`,
        payment_intent: paymentIntentId,
        amount: 3599,
        currency: "usd",
        reason: "general",
        status: "needs_response",
        created: Math.floor(Date.now() / 1000),
        evidence_details: { due_by: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 },
      },
      WEBHOOK_SECRET,
    );

    const dispRes = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": dispSig,
      },
      body: dispBody,
    });
    expect(dispRes.statusCode).toBe(200);

    // Verify order payment_status is now disputed (overrides paid)
    const [afterDisp] = await db.select().from(order).where(eq(order.id, orderId));
    expect(afterDisp.paymentStatus).toBe("disputed");
    // Order status should still be confirmed (dispute doesn't change fulfillment status)
    expect(afterDisp.status).toBe("confirmed");

    // Verify dispute record exists with correct order linkage
    const [disputeRow] = await db
      .select()
      .from(dispute)
      .where(eq(dispute.providerDisputeId, `dp_ordering_${ts}`));
    expect(disputeRow.orderId).toBe(orderId);
    expect(disputeRow.reason).toBe("general");
  });
});
