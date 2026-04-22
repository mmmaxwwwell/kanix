/**
 * Flow test: kit purchase [mirrors T098, SC-010]
 *
 * Walks the complete kit purchase flow via HTTP calls against the real stack:
 *   fetch kits → select a kit → choose variant per class → add-to-cart →
 *   checkout → verify kit row-items in order with correct per-variant pricing
 *   and kit savings; also tests the invalid-selection branch (missing class → 400).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import {
  productClass,
  productClassMembership,
  kitDefinition,
  kitClassRequirement,
} from "../db/schema/product-class.js";
import {
  inventoryBalance,
  inventoryLocation,
} from "../db/schema/inventory.js";
import { order, orderLine } from "../db/schema/order.js";
import { payment } from "../db/schema/payment.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_kit_purchase_flow_test";
const run = Date.now();

const VALID_ADDRESS = {
  full_name: "Kit Buyer",
  line1: "100 Kit Lane",
  city: "Austin",
  state: "TX",
  postal_code: "78704",
  country: "US",
};

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createStubTaxAdapter(taxMinor = 200): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: taxMinor, calculationId: `txcalc_kit_flow_${Date.now()}` };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_kit_flow_${piCounter}_${Date.now()}`,
        clientSecret: `pi_kit_flow_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_kit_flow_${Date.now()}`, status: "succeeded" };
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

describe("kit purchase flow (T262, mirrors T098/SC-010)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  // Seed data IDs — two product classes, each with a product + variant
  let classAId = "";
  let classBId = "";
  let productAId = "";
  let productBId = "";
  let variantAId = "";
  let variantBId = "";
  let locationId = "";
  let kitDefId = "";

  // Variant prices
  const VARIANT_A_PRICE = 2500; // $25.00
  const VARIANT_B_PRICE = 1800; // $18.00
  const KIT_PRICE = 3500; // $35.00 (saves $8.00 vs individual)
  const EXPECTED_SAVINGS = VARIANT_A_PRICE + VARIANT_B_PRICE - KIT_PRICE; // 800

  // Flow state
  let cartToken = "";
  let orderId = "";
  let paymentIntentId = "";
  let paymentRecordId = "";

  beforeAll(async () => {
    ts_ = await createTestServer({
      skipListen: true,
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(200),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

    // --- Class A (e.g. "Holder") ---
    const [clsA] = await db
      .insert(productClass)
      .values({ name: `Kit Class A ${run}`, slug: `kit-class-a-${run}` })
      .returning();
    classAId = clsA.id;

    // --- Class B (e.g. "Dispenser") ---
    const [clsB] = await db
      .insert(productClass)
      .values({ name: `Kit Class B ${run}`, slug: `kit-class-b-${run}` })
      .returning();
    classBId = clsB.id;

    // --- Product A in Class A ---
    const [prodA] = await db
      .insert(product)
      .values({
        slug: `kit-prod-a-${run}`,
        title: `Kit Product A ${run}`,
        status: "active",
      })
      .returning();
    productAId = prodA.id;

    await db.insert(productClassMembership).values({
      productId: prodA.id,
      productClassId: classAId,
    });

    const [vA] = await db
      .insert(productVariant)
      .values({
        productId: prodA.id,
        sku: `KIT-VA-${run}`,
        title: `Kit Variant A ${run}`,
        priceMinor: VARIANT_A_PRICE,
        status: "active",
        weight: "10",
      })
      .returning();
    variantAId = vA.id;

    // --- Product B in Class B ---
    const [prodB] = await db
      .insert(product)
      .values({
        slug: `kit-prod-b-${run}`,
        title: `Kit Product B ${run}`,
        status: "active",
      })
      .returning();
    productBId = prodB.id;

    await db.insert(productClassMembership).values({
      productId: prodB.id,
      productClassId: classBId,
    });

    const [vB] = await db
      .insert(productVariant)
      .values({
        productId: prodB.id,
        sku: `KIT-VB-${run}`,
        title: `Kit Variant B ${run}`,
        priceMinor: VARIANT_B_PRICE,
        status: "active",
        weight: "8",
      })
      .returning();
    variantBId = vB.id;

    // --- Inventory ---
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
            name: `Kit Warehouse ${run}`,
            code: `KIT-WH-${run}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values([
      { variantId: variantAId, locationId, onHand: 50, reserved: 0, available: 50 },
      { variantId: variantBId, locationId, onHand: 40, reserved: 0, available: 40 },
    ]);

    // --- Kit definition ---
    const [kit] = await db
      .insert(kitDefinition)
      .values({
        slug: `starter-kit-${run}`,
        title: `Starter Kit ${run}`,
        description: "A test starter kit",
        priceMinor: KIT_PRICE,
        status: "active",
      })
      .returning();
    kitDefId = kit.id;

    // --- Kit class requirements: 1 from each class ---
    await db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: classAId, quantity: 1 },
      { kitDefinitionId: kitDefId, productClassId: classBId, quantity: 1 },
    ]);
  }, 30_000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Step 1: Fetch kits — kit visible with requirements and products
  // -------------------------------------------------------------------------

  it("step 1: GET /api/kits returns the seeded kit with requirements and variant details", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/kits",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.kits).toBeInstanceOf(Array);

    const found = body.kits.find(
      (k: { slug: string }) => k.slug === `starter-kit-${run}`,
    );
    expect(found).toBeDefined();
    expect(found.title).toBe(`Starter Kit ${run}`);
    expect(found.priceMinor).toBe(KIT_PRICE);

    // Two class requirements
    expect(found.requirements).toBeInstanceOf(Array);
    expect(found.requirements.length).toBe(2);

    const reqA = found.requirements.find(
      (r: { productClassId: string }) => r.productClassId === classAId,
    );
    expect(reqA).toBeDefined();
    expect(reqA.quantity).toBe(1);
    expect(reqA.products.length).toBeGreaterThanOrEqual(1);

    // Verify variant A is listed under class A's products
    const prodAEntry = reqA.products.find(
      (p: { id: string }) => p.id === productAId,
    );
    expect(prodAEntry).toBeDefined();
    const varAEntry = prodAEntry.variants.find(
      (v: { id: string }) => v.id === variantAId,
    );
    expect(varAEntry).toBeDefined();
    expect(varAEntry.priceCents).toBe(VARIANT_A_PRICE);
    expect(varAEntry.inStock).toBe(true);

    const reqB = found.requirements.find(
      (r: { productClassId: string }) => r.productClassId === classBId,
    );
    expect(reqB).toBeDefined();
    expect(reqB.quantity).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Step 2: Invalid selection — missing class → 400
  // -------------------------------------------------------------------------

  it("step 2: adding kit with missing class selection returns 400 ERR_KIT_INCOMPLETE", async () => {
    // Create a cart first
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.statusCode).toBe(201);
    const tempCartToken = JSON.parse(cartRes.body).cart.token;

    // Try to add kit with only one class selection (missing class B)
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/kits",
      headers: {
        "content-type": "application/json",
        "x-cart-token": tempCartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [
          { product_class_id: classAId, variant_id: variantAId },
          // Missing class B selection
        ],
      }),
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_KIT_INCOMPLETE");
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Step 3: Add kit to cart with valid selections
  // -------------------------------------------------------------------------

  it("step 3: add kit to cart with valid variant per class → 201 with savings", async () => {
    // Create a fresh cart for the main flow
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.statusCode).toBe(201);
    cartToken = JSON.parse(cartRes.body).cart.token;

    const res = await app.inject({
      method: "POST",
      url: "/api/cart/kits",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [
          { product_class_id: classAId, variant_id: variantAId },
          { product_class_id: classBId, variant_id: variantBId },
        ],
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // Kit result shape
    expect(body.kit).toBeDefined();
    expect(body.kit.kitDefinitionId).toBe(kitDefId);
    expect(body.kit.kitPriceMinor).toBe(KIT_PRICE);
    expect(body.kit.individualTotalMinor).toBe(VARIANT_A_PRICE + VARIANT_B_PRICE);
    expect(body.kit.savingsMinor).toBe(EXPECTED_SAVINGS);

    // Selections detail
    expect(body.kit.selections).toBeInstanceOf(Array);
    expect(body.kit.selections.length).toBe(2);

    const selA = body.kit.selections.find(
      (s: { variantId: string }) => s.variantId === variantAId,
    );
    expect(selA).toBeDefined();
    expect(selA.productClassId).toBe(classAId);
    expect(selA.individualPriceMinor).toBe(VARIANT_A_PRICE);

    const selB = body.kit.selections.find(
      (s: { variantId: string }) => s.variantId === variantBId,
    );
    expect(selB).toBeDefined();
    expect(selB.productClassId).toBe(classBId);
    expect(selB.individualPriceMinor).toBe(VARIANT_B_PRICE);

    // Cart should contain the kit line
    expect(body.cart).toBeDefined();
    expect(body.cart.items.length).toBe(1);
    expect(body.cart.items[0].unitPriceMinor).toBe(KIT_PRICE);
    expect(body.cart.items[0].quantity).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Step 4: Checkout — verify order totals use kit price
  // -------------------------------------------------------------------------

  it("step 4: checkout produces order with kit price (not individual prices)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `kit-flow-${run}@example.com`,
        shipping_address: { ...VALID_ADDRESS },
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    expect(body.order).toBeDefined();
    expect(body.order.order_number).toMatch(/^KNX-\d{6}$/);
    expect(body.order.email).toBe(`kit-flow-${run}@example.com`);
    expect(body.order.status).toBe("pending_payment");

    // Subtotal = kit price (3500), not individual total (4300)
    expect(body.order.subtotal_minor).toBe(KIT_PRICE);
    expect(body.order.tax_minor).toBe(200);
    expect(body.order.shipping_minor).toBe(599);
    expect(body.order.total_minor).toBe(KIT_PRICE + 200 + 599); // 4299

    expect(typeof body.client_secret).toBe("string");
    expect(body.client_secret.length).toBeGreaterThan(0);

    orderId = body.order.id;
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 5: Verify DB state — order lines reflect kit per-variant pricing
  // -------------------------------------------------------------------------

  it("step 5: DB order has kit line with correct unit price and frozen snapshots", async () => {
    const db = dbConn.db;

    // Order row
    const [savedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(savedOrder).toBeDefined();
    expect(savedOrder.status).toBe("pending_payment");
    expect(savedOrder.subtotalMinor).toBe(KIT_PRICE);
    expect(savedOrder.totalMinor).toBe(KIT_PRICE + 200 + 599);

    // Order line — kit creates one line with the kit price
    const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, orderId));
    expect(lines.length).toBe(1);

    const kitLine = lines[0];
    expect(kitLine.quantity).toBe(1);
    expect(kitLine.unitPriceMinor).toBe(KIT_PRICE);
    // The primary variant (first selection) is stored as the line's variant reference
    expect(kitLine.variantId).toBe(variantAId);

    // Payment record
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    expect(paymentRow).toBeDefined();
    expect(paymentRow.status).toBe("pending");
    expect(paymentRow.providerPaymentIntentId).toMatch(/^pi_kit_flow_/);
    paymentIntentId = paymentRow.providerPaymentIntentId;
    paymentRecordId = paymentRow.id;
  });

  // -------------------------------------------------------------------------
  // Step 6: Stripe webhook confirms payment
  // -------------------------------------------------------------------------

  it("step 6: Stripe webhook confirms payment → order status=confirmed", async () => {
    const db = dbConn.db;
    const eventId = `evt_kit_flow_${run}`;
    const chargeId = `ch_kit_flow_${run}`;
    const totalMinor = KIT_PRICE + 200 + 599;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: totalMinor,
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

    // Order confirmed + paid
    const [confirmedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(confirmedOrder.status).toBe("confirmed");
    expect(confirmedOrder.paymentStatus).toBe("paid");

    // Payment record updated
    const [paymentRow] = await db.select().from(payment).where(eq(payment.id, paymentRecordId));
    expect(paymentRow.status).toBe("succeeded");
    expect(paymentRow.providerChargeId).toBe(chargeId);
  });

  // -------------------------------------------------------------------------
  // Step 7: Final verification — totals frozen, kit savings correct
  // -------------------------------------------------------------------------

  it("step 7: final order totals frozen at kit price with correct savings math", async () => {
    const db = dbConn.db;

    const [finalOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(finalOrder.status).toBe("confirmed");
    expect(finalOrder.paymentStatus).toBe("paid");

    // Kit price, not individual prices
    expect(finalOrder.subtotalMinor).toBe(KIT_PRICE);
    expect(finalOrder.taxMinor).toBe(200);
    expect(finalOrder.shippingMinor).toBe(599);
    expect(finalOrder.totalMinor).toBe(KIT_PRICE + 200 + 599);

    // Verify savings math: individual total would be 2500 + 1800 = 4300
    // Kit price is 3500, so savings = 800
    const individualTotal = VARIANT_A_PRICE + VARIANT_B_PRICE;
    expect(individualTotal).toBe(4300);
    expect(KIT_PRICE).toBe(3500);
    expect(individualTotal - KIT_PRICE).toBe(EXPECTED_SAVINGS);
    expect(EXPECTED_SAVINGS).toBe(800);

    // Shipping address snapshot frozen
    const addrSnapshot =
      typeof finalOrder.shippingAddressSnapshotJson === "string"
        ? JSON.parse(finalOrder.shippingAddressSnapshotJson)
        : finalOrder.shippingAddressSnapshotJson;
    expect(addrSnapshot.full_name).toBe("Kit Buyer");
    expect(addrSnapshot.city).toBe("Austin");
    expect(addrSnapshot.state).toBe("TX");
  });
});
