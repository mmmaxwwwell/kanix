/**
 * Flow test: reservation expiry → late payment race [mirrors T104d, FR-E008]
 *
 * Walks both outcome branches of the reservation-expiry race condition:
 *
 * Branch A (stock available):
 *   checkout → short-TTL reservation → force expiry via cleanup job →
 *   payment_intent.succeeded webhook → re-reservation succeeds → order confirmed
 *
 * Branch B (stock exhausted):
 *   checkout → short-TTL reservation → force expiry via cleanup job →
 *   drain inventory → payment_intent.succeeded webhook →
 *   re-reservation fails → order flagged for manual review + admin alert
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "../db/schema/inventory.js";
import { order } from "../db/schema/order.js";
import { payment } from "../db/schema/payment.js";
import { releaseExpiredReservations } from "../db/queries/reservation.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";
import { createAdminAlertService, type AdminAlertService } from "../services/admin-alert.js";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_reservation_late_payment_flow";
const run = Date.now();

const VALID_ADDRESS = {
  full_name: "Late Payment Tester",
  line1: "789 Race Condition Blvd",
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
function createFlowPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_late_pay_${piCounter}_${run}`,
        clientSecret: `pi_late_pay_${piCounter}_secret_${run}`,
      };
    },
    async createRefund() {
      return { id: `re_late_pay_${run}`, status: "succeeded" };
    },
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook helper
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
// Helper: create a checkout with reservation, returning IDs needed later
// ---------------------------------------------------------------------------

async function createCheckoutWithReservation(
  app: FastifyInstance,
  db: DatabaseConnection["db"],
  suffix: string,
  priceMinor: number,
  quantity: number,
  stockOnHand: number,
): Promise<{
  orderId: string;
  paymentIntentId: string;
  variantId: string;
  locationId: string;
}> {
  // Product + variant
  const [prod] = await db
    .insert(product)
    .values({
      slug: `late-pay-prod-${suffix}-${run}`,
      title: `Late Payment Product ${suffix} ${run}`,
      status: "active",
    })
    .returning();

  const [variant] = await db
    .insert(productVariant)
    .values({
      productId: prod.id,
      sku: `LATE-PAY-${suffix}-${run}`,
      title: `Late Payment Variant ${suffix} ${run}`,
      priceMinor,
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
        name: `Late Pay WH ${suffix} ${run}`,
        code: `LP-WH-${suffix}-${run}`,
        type: "warehouse",
      })
      .returning();
    locationId = loc.id;
  }

  await db.insert(inventoryBalance).values({
    variantId: variant.id,
    locationId,
    onHand: stockOnHand,
    reserved: 0,
    available: stockOnHand,
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
    headers: { "content-type": "application/json", "x-cart-token": cartToken },
    body: JSON.stringify({ variant_id: variant.id, quantity }),
  });

  const checkoutRes = await app.inject({
    method: "POST",
    url: "/api/checkout",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cart_token: cartToken,
      email: `late-pay-${suffix}-${run}@example.com`,
      shipping_address: VALID_ADDRESS,
    }),
  });

  expect(checkoutRes.statusCode).toBe(201);
  const checkoutData = JSON.parse(checkoutRes.body);
  const orderId = checkoutData.order.id;

  const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
  const paymentIntentId = paymentRow.providerPaymentIntentId;

  return { orderId, paymentIntentId, variantId: variant.id, locationId };
}

// ---------------------------------------------------------------------------
// Helper: force-expire reservations for an order via the cleanup job
// ---------------------------------------------------------------------------

async function forceExpireReservations(
  db: DatabaseConnection["db"],
  orderId: string,
): Promise<void> {
  // Set expiresAt to the past so the cleanup job picks them up
  await db
    .update(inventoryReservation)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(
      and(eq(inventoryReservation.orderId, orderId), eq(inventoryReservation.status, "active")),
    );

  // Run the actual cleanup job (same as the cron would)
  await releaseExpiredReservations(db);
}

// ===========================================================================
// Branch A: stock available → re-reservation succeeds → order confirmed
// ===========================================================================

describe("reservation late-payment race — stock available (FR-E008)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let adminAlertService: AdminAlertService;

  // Flow state
  let orderId = "";
  let paymentIntentId = "";
  let variantId = "";
  let locationId = "";

  beforeAll(async () => {
    adminAlertService = createAdminAlertService();

    ts_ = await createTestServer({
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createFlowPaymentAdapter(),
        adminAlertService,
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
  }, 30_000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  it("step 1: checkout creates reservation against available inventory", async () => {
    const result = await createCheckoutWithReservation(app, dbConn.db, "avail", 2500, 2, 20);
    orderId = result.orderId;
    paymentIntentId = result.paymentIntentId;
    variantId = result.variantId;
    locationId = result.locationId;

    // Verify order in pending_payment state
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.status).toBe("pending_payment");
    expect(orderRow.paymentStatus).toBe("unpaid");

    // Verify active reservations exist
    const reservations = await dbConn.db
      .select()
      .from(inventoryReservation)
      .where(
        and(eq(inventoryReservation.orderId, orderId), eq(inventoryReservation.status, "active")),
      );
    expect(reservations.length).toBe(1);
    expect(reservations[0].quantity).toBe(2);
    expect(reservations[0].variantId).toBe(variantId);

    // Verify inventory balance reflects the reservation
    const [balance] = await dbConn.db
      .select()
      .from(inventoryBalance)
      .where(
        and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
      );
    expect(balance.reserved).toBe(2);
    expect(balance.available).toBe(18); // 20 - 2
  });

  it("step 2: force-expire reservations via cleanup job", async () => {
    await forceExpireReservations(dbConn.db, orderId);

    // Verify reservations are now expired
    const reservations = await dbConn.db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    const expired = reservations.filter((r) => r.status === "expired");
    expect(expired.length).toBe(1);
    const active = reservations.filter((r) => r.status === "active");
    expect(active.length).toBe(0);

    // Verify inventory released (stock fully available again)
    const [balance] = await dbConn.db
      .select()
      .from(inventoryBalance)
      .where(
        and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
      );
    expect(balance.reserved).toBe(0);
    expect(balance.available).toBe(20); // fully restored
  });

  it("step 3: late payment_intent.succeeded webhook → re-reserves and confirms order", async () => {
    const eventId = `evt_late_pay_avail_${run}`;

    const { body, signature } = generateStripeWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 5599, // price doesn't matter for this test path
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_late_pay_avail_${run}`,
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

    // Verify order is confirmed (re-reservation succeeded)
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.status).toBe("confirmed");
    expect(orderRow.paymentStatus).toBe("paid");
  });

  it("step 4: verify reservation state — expired originals + consumed re-reservations", async () => {
    const reservations = await dbConn.db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));

    const expired = reservations.filter((r) => r.status === "expired");
    const consumed = reservations.filter((r) => r.status === "consumed");

    expect(expired.length).toBe(1); // original reservation
    expect(consumed.length).toBe(1); // re-reserved and consumed

    // Consumed re-reservation has correct variant + quantity
    expect(consumed[0].variantId).toBe(variantId);
    expect(consumed[0].quantity).toBe(2);
  });

  it("step 5: verify inventory balance after re-reserve + consume", async () => {
    // Started with 20, checkout reserved 2 (then expired → back to 20),
    // re-reservation took 2, consumed → onHand-=2, reserved-=2
    // Result: onHand=18, reserved=0, available=18
    const [balance] = await dbConn.db
      .select()
      .from(inventoryBalance)
      .where(
        and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
      );
    expect(balance.onHand).toBe(18);
    expect(balance.reserved).toBe(0);
    expect(balance.available).toBe(18);
  });

  it("step 6: no admin alert queued (re-reservation succeeded)", () => {
    const alerts = adminAlertService.getAlerts();
    const raceAlert = alerts.find(
      (a) => a.type === "reservation_expired_payment_received" && a.orderId === orderId,
    );
    expect(raceAlert).toBeUndefined();
  });
});

// ===========================================================================
// Branch B: stock exhausted → order flagged for manual review + admin alert
// ===========================================================================

describe("reservation late-payment race — stock exhausted (FR-E008)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let adminAlertService: AdminAlertService;

  // Flow state
  let orderId = "";
  let paymentIntentId = "";
  let variantId = "";
  let locationId = "";

  beforeAll(async () => {
    adminAlertService = createAdminAlertService();

    ts_ = await createTestServer({
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createFlowPaymentAdapter(),
        adminAlertService,
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
  }, 30_000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  it("step 1: checkout creates reservation with limited stock", async () => {
    const result = await createCheckoutWithReservation(
      app,
      dbConn.db,
      "exhaust",
      3000,
      2,
      2, // exactly 2 units — just enough for checkout
    );
    orderId = result.orderId;
    paymentIntentId = result.paymentIntentId;
    variantId = result.variantId;
    locationId = result.locationId;

    // Verify order in pending_payment state
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.status).toBe("pending_payment");
    expect(orderRow.paymentStatus).toBe("unpaid");

    // Verify active reservations exist
    const reservations = await dbConn.db
      .select()
      .from(inventoryReservation)
      .where(
        and(eq(inventoryReservation.orderId, orderId), eq(inventoryReservation.status, "active")),
      );
    expect(reservations.length).toBe(1);
    expect(reservations[0].quantity).toBe(2);
  });

  it("step 2: force-expire reservations via cleanup job", async () => {
    await forceExpireReservations(dbConn.db, orderId);

    // Verify reservations are expired
    const reservations = await dbConn.db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    const expired = reservations.filter((r) => r.status === "expired");
    expect(expired.length).toBe(1);
  });

  it("step 3: drain inventory so re-reservation will fail", async () => {
    // Simulate another customer buying all the stock
    await dbConn.db.execute(
      sql`UPDATE inventory_balance
          SET available = 0, on_hand = 0, reserved = 0
          WHERE variant_id = ${variantId} AND location_id = ${locationId}`,
    );

    const [balance] = await dbConn.db
      .select()
      .from(inventoryBalance)
      .where(
        and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
      );
    expect(balance.available).toBe(0);
    expect(balance.onHand).toBe(0);
  });

  it("step 4: late payment_intent.succeeded webhook → order flagged for manual review", async () => {
    const eventId = `evt_late_pay_exhaust_${run}`;

    const { body, signature } = generateStripeWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 6599,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_late_pay_exhaust_${run}`,
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

    // Order stays in pending_payment (NOT confirmed) — deterministic final state
    const [orderRow] = await dbConn.db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.status).toBe("pending_payment");
    expect(orderRow.paymentStatus).toBe("paid");
  });

  it("step 5: admin alert queued with correct details", () => {
    const alerts = adminAlertService.getAlerts();
    const raceAlert = alerts.find(
      (a) => a.type === "reservation_expired_payment_received" && a.orderId === orderId,
    );

    expect(raceAlert).not.toBeUndefined();
    expect(raceAlert!.type).toBe("reservation_expired_payment_received");
    expect(raceAlert!.orderId).toBe(orderId);
    expect(raceAlert!.message).toBe(
      "Payment received but inventory reservations expired and stock is no longer available. Order requires manual review.",
    );
    expect(raceAlert!.timestamp).toBeInstanceOf(Date);

    // Verify alert details contain the expired reservation info
    const details = raceAlert!.details as {
      expiredReservations: Array<{
        variantId: string;
        locationId: string;
        quantity: number;
      }>;
    };
    expect(Array.isArray(details.expiredReservations)).toBe(true);
    expect(details.expiredReservations.length).toBe(1);
    expect(details.expiredReservations[0].variantId).toBe(variantId);
    expect(details.expiredReservations[0].locationId).toBe(locationId);
    expect(details.expiredReservations[0].quantity).toBe(2);
  });

  it("step 6: verify inventory balance unchanged (no re-reservation happened)", async () => {
    const [balance] = await dbConn.db
      .select()
      .from(inventoryBalance)
      .where(
        and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
      );
    expect(balance.available).toBe(0);
    expect(balance.onHand).toBe(0);
    expect(balance.reserved).toBe(0);
  });

  it("step 7: verify no new reservations created (only expired originals)", async () => {
    const reservations = await dbConn.db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));

    const expired = reservations.filter((r) => r.status === "expired");
    const active = reservations.filter((r) => r.status === "active");
    const consumed = reservations.filter((r) => r.status === "consumed");

    expect(expired.length).toBe(1);
    expect(active.length).toBe(0);
    expect(consumed.length).toBe(0);
  });
});
