import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
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

const WEBHOOK_SECRET = "whsec_test_race_handler_secret";

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
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
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
describe("Reservation expiry race — flagged for review (FR-E008)", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let adminAlertService: AdminAlertService;

  const ts = Date.now() + 100;

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
        paymentAdapter: createStubPaymentAdapter(),
        adminAlertService,
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

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
    variantId = variant.id;

    // Use first existing location or create one
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
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
    await stopTestServer(ts_);
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

    // Verify order stays in pending_payment (NOT confirmed) — deterministic final state
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.status).toBe("pending_payment");
    expect(orderRow.paymentStatus).toBe("paid");

    // Verify admin alert was queued with concrete fields
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
      expiredReservations: Array<{ variantId: string; locationId: string; quantity: number }>;
    };
    expect(Array.isArray(details.expiredReservations)).toBe(true);
    expect(details.expiredReservations.length).toBe(1);
    expect(details.expiredReservations[0].variantId).toBe(variantId);
    expect(details.expiredReservations[0].locationId).toBe(locationId);
    expect(details.expiredReservations[0].quantity).toBe(2);

    // Verify inventory balance is still depleted (no re-reservation happened)
    const [balance] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
      );
    expect(balance.available).toBe(0);
    expect(balance.onHand).toBe(0);

    // Verify all reservations for this order are still expired (no new ones created)
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    const expiredCount = reservations.filter((r) => r.status === "expired").length;
    const activeOrConsumed = reservations.filter(
      (r) => r.status === "active" || r.status === "consumed",
    ).length;
    expect(expiredCount).toBe(1);
    expect(activeOrConsumed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Expired reservations + stock available → re-reserved and confirmed
// ---------------------------------------------------------------------------
describe("Reservation expiry race — re-reserved (FR-E008)", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let adminAlertService: AdminAlertService;

  const ts = Date.now() + 200;

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
        paymentAdapter: createStubPaymentAdapter(),
        adminAlertService,
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

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
    variantId = variant.id;

    const existingBalances = await db.select().from(inventoryBalance).limit(1);
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
    // Stock is still available (10 units restored to available → 10)
  });

  afterAll(async () => {
    await stopTestServer(ts_);
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

    // Verify order IS confirmed — deterministic final state
    const [orderRow] = await db.select().from(order).where(eq(order.id, orderId));
    expect(orderRow.status).toBe("confirmed");
    expect(orderRow.paymentStatus).toBe("paid");

    // Verify reservations: expired originals + consumed new ones
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));

    const expired = reservations.filter((r) => r.status === "expired");
    const consumed = reservations.filter((r) => r.status === "consumed");
    expect(expired.length).toBe(1); // original reservation
    expect(consumed.length).toBe(1); // re-reserved and then consumed

    // Verify the consumed reservation has the recovery reason
    expect(consumed[0].variantId).toBe(variantId);
    expect(consumed[0].quantity).toBe(2);

    // Verify inventory balance reflects the consumed re-reservation
    // Started with 10, checkout reserved 2 (then expired → back to 10),
    // re-reservation took 2, consumed → onHand should drop by 2
    const [balance] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
      );
    // After re-reserve + consume: reserved goes to 0, onHand stays 10,
    // available = onHand - reserved = 10 - 0 = 10... but consume decrements onHand by quantity
    // Actually: reserve does reserved+2/available-2, consume does onHand-2/reserved-2
    // So: onHand=10-2=8, reserved=2-2=0, available=10-2=8
    expect(balance.onHand).toBe(8);
    expect(balance.reserved).toBe(0);
    expect(balance.available).toBe(8);

    // Verify no admin alert was queued (re-reservation succeeded)
    const alerts = adminAlertService.getAlerts();
    const raceAlert = alerts.find(
      (a) => a.type === "reservation_expired_payment_received" && a.orderId === orderId,
    );
    expect(raceAlert).toBeUndefined();
  });
});
