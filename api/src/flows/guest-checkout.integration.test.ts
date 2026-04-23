/**
 * Flow test: guest checkout on Astro [mirrors T096, SC-001]
 *
 * Walks the complete guest checkout flow via HTTP calls against the real stack:
 *   fetch catalog → add to cart → set shipping address → compute totals →
 *   create payment intent → simulate Stripe confirm via webhook →
 *   verify order.status=confirmed + paymentStatus=paid →
 *   verify snapshots (price, tax, shipping) are frozen on the order.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import { productClass, productClassMembership } from "../db/schema/product-class.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "../db/schema/inventory.js";
import { order, orderLine, orderStatusHistory } from "../db/schema/order.js";
import { payment, paymentEvent } from "../db/schema/payment.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_guest_checkout_flow_test";

const VALID_ADDRESS = {
  full_name: "Jane Guest",
  line1: "456 Commerce Ave",
  city: "Austin",
  state: "TX",
  postal_code: "78702",
  country: "US",
};

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createStubTaxAdapter(taxMinor = 325): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: taxMinor, calculationId: `txcalc_flow_${Date.now()}` };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_guest_flow_${piCounter}_${Date.now()}`,
        clientSecret: `pi_guest_flow_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_guest_flow_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook helper
// ---------------------------------------------------------------------------

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
// Tests
// ---------------------------------------------------------------------------

describe("guest checkout flow (T260, mirrors T096/SC-001)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const run = Date.now();

  // Seed data IDs
  let productId = "";
  let variantAId = "";
  let variantBId = "";
  let locationId = "";
  let classId = "";

  // Flow state (populated step by step)
  let cartToken = "";
  let orderId = "";
  let orderNumber = "";
  let paymentIntentId = "";
  let paymentRecordId = "";
  let clientSecret = "";

  beforeAll(async () => {
    ts_ = await createTestServer({
      skipListen: true,
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(325),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

    // 1. Product with two variants
    const [prod] = await db
      .insert(product)
      .values({
        slug: `gflow-prod-${run}`,
        title: `Guest Flow Product ${run}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    const [vA] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `GFLOW-A-${run}`,
        title: `Guest Variant A ${run}`,
        priceMinor: 2500, // $25.00
        status: "active",
        weight: "12",
      })
      .returning();
    variantAId = vA.id;

    const [vB] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `GFLOW-B-${run}`,
        title: `Guest Variant B ${run}`,
        priceMinor: 1000, // $10.00
        status: "active",
        weight: "6",
      })
      .returning();
    variantBId = vB.id;

    // 2. Product class + membership (needed for catalog listing)
    const [cls] = await db
      .insert(productClass)
      .values({ name: `GFlow Class ${run}`, slug: `gflow-class-${run}` })
      .returning();
    classId = cls.id;

    await db.insert(productClassMembership).values({
      productId: prod.id,
      productClassId: cls.id,
    });

    // 3. Inventory
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const existingLocs = await db.select().from(inventoryLocation).limit(1);
      if (existingLocs.length > 0) {
        locationId = existingLocs[0].id;
      } else {
        const [loc] = await db
          .insert(inventoryLocation)
          .values({
            name: `GFlow Warehouse ${run}`,
            code: `GFLOW-WH-${run}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values([
      { variantId: variantAId, locationId, onHand: 50, reserved: 0, available: 50 },
      { variantId: variantBId, locationId, onHand: 30, reserved: 0, available: 30 },
    ]);
  }, 30_000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Step 1: Browse catalog — product visible with variants
  // -------------------------------------------------------------------------

  it("step 1: public catalog returns the seeded product with variants", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/products",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.products).toBeInstanceOf(Array);

    // Our product should be in the list (it has class membership + active status)
    const found = body.products.find((p: { slug: string }) => p.slug === `gflow-prod-${run}`);
    expect(found).toBeDefined();
    expect(found.title).toBe(`Guest Flow Product ${run}`);

    // Verify at least our two variants are present
    expect(found.variants).toBeInstanceOf(Array);
    expect(found.variants.length).toBeGreaterThanOrEqual(2);

    const skus = found.variants.map((v: { sku: string }) => v.sku);
    expect(skus).toContain(`GFLOW-A-${run}`);
    expect(skus).toContain(`GFLOW-B-${run}`);

    // Verify pricing is exposed
    const varA = found.variants.find((v: { sku: string }) => v.sku === `GFLOW-A-${run}`);
    expect(varA.priceMinor).toBe(2500);
    expect(varA.inStock).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Step 2: Create guest cart and add items
  // -------------------------------------------------------------------------

  it("step 2: create guest cart and add items (2×A + 1×B)", async () => {
    // Create empty cart (no auth needed — guest)
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(cartRes.statusCode).toBe(201);
    const cartData = JSON.parse(cartRes.body);
    expect(cartData.cart).toBeDefined();
    expect(typeof cartData.cart.token).toBe("string");
    cartToken = cartData.cart.token;

    // Add 2× variant A ($25 each)
    const addARes = await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variantAId, quantity: 2 }),
    });
    expect(addARes.statusCode).toBeLessThan(300);

    // Add 1× variant B ($10)
    const addBRes = await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variantBId, quantity: 1 }),
    });
    expect(addBRes.statusCode).toBeLessThan(300);

    // Verify cart contents
    const getCartRes = await app.inject({
      method: "GET",
      url: "/api/cart",
      headers: { "x-cart-token": cartToken },
    });
    expect(getCartRes.statusCode).toBe(200);
    const cart = JSON.parse(getCartRes.body);
    expect(cart.cart.items.length).toBe(2);

    const itemA = cart.cart.items.find((i: { variantId: string }) => i.variantId === variantAId);
    expect(itemA.quantity).toBe(2);
    const itemB = cart.cart.items.find((i: { variantId: string }) => i.variantId === variantBId);
    expect(itemB.quantity).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Step 3: Checkout — shipping address + totals + payment intent
  // -------------------------------------------------------------------------

  it("step 3: checkout produces order with correct totals and client_secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `guest-flow-${run}@example.com`,
        shipping_address: { ...VALID_ADDRESS },
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // Order shape
    expect(body.order).toBeDefined();
    expect(body.order.order_number).toMatch(/^KNX-\d{6}$/);
    expect(body.order.email).toBe(`guest-flow-${run}@example.com`);
    expect(body.order.status).toBe("pending_payment");
    expect(body.order.payment_status).toBe("unpaid");

    // Totals: 2500*2 + 1000*1 = 6000 subtotal, 325 tax (stub), 599 shipping (stub)
    expect(body.order.subtotal_minor).toBe(6000);
    expect(body.order.tax_minor).toBe(325);
    expect(body.order.shipping_minor).toBe(599);
    expect(body.order.total_minor).toBe(6000 + 325 + 599); // 6924

    // client_secret for Stripe.js
    expect(typeof body.client_secret).toBe("string");
    expect(body.client_secret.length).toBeGreaterThan(0);

    // Capture for subsequent steps
    orderId = body.order.id;
    orderNumber = body.order.order_number;
    clientSecret = body.client_secret;
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 4: Verify pre-webhook DB state (pending_payment)
  // -------------------------------------------------------------------------

  it("step 4: DB has order in pending_payment with frozen snapshots", async () => {
    const db = dbConn.db;

    // Order row
    const [savedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(savedOrder).toBeDefined();
    expect(savedOrder.status).toBe("pending_payment");
    expect(savedOrder.paymentStatus).toBe("unpaid");
    expect(savedOrder.email).toBe(`guest-flow-${run}@example.com`);

    // Totals frozen
    expect(savedOrder.subtotalMinor).toBe(6000);
    expect(savedOrder.taxMinor).toBe(325);
    expect(savedOrder.shippingMinor).toBe(599);
    expect(savedOrder.totalMinor).toBe(6924);

    // Shipping address snapshot
    const addrSnapshot =
      typeof savedOrder.shippingAddressSnapshotJson === "string"
        ? JSON.parse(savedOrder.shippingAddressSnapshotJson)
        : savedOrder.shippingAddressSnapshotJson;
    expect(addrSnapshot.full_name).toBe("Jane Guest");
    expect(addrSnapshot.line1).toBe("456 Commerce Ave");
    expect(addrSnapshot.city).toBe("Austin");
    expect(addrSnapshot.state).toBe("TX");
    expect(addrSnapshot.postal_code).toBe("78702");

    // Order lines with price snapshots
    const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, orderId));
    expect(lines.length).toBe(2);

    const lineA = lines.find((l) => l.skuSnapshot === `GFLOW-A-${run}`);
    expect(lineA).toBeDefined();
    expect(lineA!.quantity).toBe(2);
    expect(lineA!.unitPriceMinor).toBe(2500);

    const lineB = lines.find((l) => l.skuSnapshot === `GFLOW-B-${run}`);
    expect(lineB).toBeDefined();
    expect(lineB!.quantity).toBe(1);
    expect(lineB!.unitPriceMinor).toBe(1000);

    // Payment record exists with pending status
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    expect(paymentRow).toBeDefined();
    expect(paymentRow.status).toBe("pending");
    expect(paymentRow.provider).toBe("stripe");
    expect(paymentRow.providerPaymentIntentId).toMatch(/^pi_guest_flow_/);
    paymentIntentId = paymentRow.providerPaymentIntentId;
    paymentRecordId = paymentRow.id;

    // Inventory reservations created
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    expect(reservations.length).toBe(2);
    for (const r of reservations) {
      expect(r.status).toBe("active");
    }
  });

  // -------------------------------------------------------------------------
  // Step 5: Simulate Stripe payment_intent.succeeded webhook
  // -------------------------------------------------------------------------

  it("step 5: Stripe webhook confirms payment → order status=confirmed, paymentStatus=paid", async () => {
    const db = dbConn.db;
    const eventId = `evt_guest_flow_${run}`;
    const chargeId = `ch_guest_flow_${run}`;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 6924,
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
    expect(JSON.parse(res.body).received).toBe(true);

    // Order transitioned to confirmed + paid
    const [confirmedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(confirmedOrder.status).toBe("confirmed");
    expect(confirmedOrder.paymentStatus).toBe("paid");

    // Payment record updated
    const [paymentRow] = await db.select().from(payment).where(eq(payment.id, paymentRecordId));
    expect(paymentRow.status).toBe("succeeded");
    expect(paymentRow.providerChargeId).toBe(chargeId);

    // Payment event logged
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, eventId));
    expect(eventRow).toBeDefined();
    expect(eventRow.eventType).toBe("payment_intent.succeeded");
    expect(eventRow.paymentId).toBe(paymentRecordId);

    // Reservations consumed
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    expect(reservations.length).toBe(2);
    for (const r of reservations) {
      expect(r.status).toBe("consumed");
    }
  });

  // -------------------------------------------------------------------------
  // Step 6: Verify snapshots are still frozen after payment
  // -------------------------------------------------------------------------

  it("step 6: price, tax, and shipping snapshots remain frozen after payment", async () => {
    const db = dbConn.db;

    // Order totals unchanged
    const [finalOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(finalOrder.subtotalMinor).toBe(6000);
    expect(finalOrder.taxMinor).toBe(325);
    expect(finalOrder.shippingMinor).toBe(599);
    expect(finalOrder.totalMinor).toBe(6924);
    expect(finalOrder.orderNumber).toBe(orderNumber);

    // Shipping address snapshot unchanged
    const addrSnapshot =
      typeof finalOrder.shippingAddressSnapshotJson === "string"
        ? JSON.parse(finalOrder.shippingAddressSnapshotJson)
        : finalOrder.shippingAddressSnapshotJson;
    expect(addrSnapshot.full_name).toBe("Jane Guest");
    expect(addrSnapshot.line1).toBe("456 Commerce Ave");
    expect(addrSnapshot.state).toBe("TX");
    expect(addrSnapshot.postal_code).toBe("78702");

    // Line-item price snapshots unchanged
    const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, orderId));
    expect(lines.length).toBe(2);

    const lineA = lines.find((l) => l.skuSnapshot === `GFLOW-A-${run}`);
    expect(lineA!.unitPriceMinor).toBe(2500);
    expect(lineA!.quantity).toBe(2);

    const lineB = lines.find((l) => l.skuSnapshot === `GFLOW-B-${run}`);
    expect(lineB!.unitPriceMinor).toBe(1000);
    expect(lineB!.quantity).toBe(1);

    // Status history tracks the full transition chain
    const history = await db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId));
    expect(history.length).toBeGreaterThanOrEqual(2);

    const statusEntries = history.filter((h) => h.statusType === "status");
    const statuses = statusEntries.map((h) => h.newValue);
    expect(statuses).toContain("pending_payment");
    expect(statuses).toContain("confirmed");
  });
});
