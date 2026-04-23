/**
 * Flow test: Stripe Tax calculation [mirrors T104f, FR-117, FR-118]
 *
 * Walks checkout with different tax scenarios via HTTP calls against the real stack:
 *   1. TX shipping address → Stripe Tax API ��� non-zero tax on order +
 *      PaymentIntent metadata includes tax_calculation_id
 *   2. Tax-exempt state (OR/MT/NH/DE) → zero tax
 *   3. Missing state in address → 400 validation error
 *
 * Uses custom tax adapters to simulate Stripe Tax behavior per-scenario.
 * Preconditions: STRIPE_TAX_ENABLED=true conceptually — the test wires
 * a non-zero tax adapter (same as the real Stripe Tax adapter would produce)
 * to verify the full tax flow. If real sk_test_ keys were required, setup
 * would fail loudly (no skip).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import { productClass, productClassMembership } from "../db/schema/product-class.js";
import { inventoryBalance, inventoryLocation } from "../db/schema/inventory.js";
import { order } from "../db/schema/order.js";
import type {
  TaxAdapter,
  ShippingAddress,
  TaxLineItem,
  TaxCalculationResult,
} from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type {
  PaymentAdapter,
  CreatePaymentIntentInput,
  PaymentIntentResult,
} from "../services/payment-adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_stripe_tax_flow_test";

const TX_ADDRESS = {
  full_name: "Tax Tester",
  line1: "100 Congress Ave",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
};

// Oregon has no sales tax
const OR_ADDRESS = {
  full_name: "Tax Exempt Tester",
  line1: "200 Pioneer Blvd",
  city: "Portland",
  state: "OR",
  postal_code: "97201",
  country: "US",
};

// ---------------------------------------------------------------------------
// Tax adapter that returns non-zero tax for TX, zero for tax-exempt states
// ---------------------------------------------------------------------------

const TAX_EXEMPT_STATES = ["OR", "MT", "NH", "DE"];
const TX_TAX_RATE = 0.0825; // 8.25% Texas combined rate

function createStateSensitiveTaxAdapter(): TaxAdapter {
  return {
    async calculate(
      lineItems: TaxLineItem[],
      shippingAddress: ShippingAddress,
    ): Promise<TaxCalculationResult> {
      if (TAX_EXEMPT_STATES.includes(shippingAddress.state)) {
        return { taxAmountMinor: 0, calculationId: null };
      }
      const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
      const taxAmount = Math.round(subtotal * TX_TAX_RATE);
      return {
        taxAmountMinor: taxAmount,
        calculationId: `txcalc_flow_${shippingAddress.state}_${Date.now()}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Payment adapter that captures metadata for assertion
// ---------------------------------------------------------------------------

let capturedMetadata: Record<string, string> = {};
let piCounter = 0;

function createCapturingPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult> {
      piCounter++;
      capturedMetadata = { ...input.metadata };
      return {
        id: `pi_tax_flow_${piCounter}_${Date.now()}`,
        clientSecret: `pi_tax_flow_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_tax_flow_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence(input: { providerDisputeId: string }) {
      return { id: input.providerDisputeId, status: "under_review" };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Stripe Tax calculation flow (T274, mirrors T104f, FR-117/FR-118)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const run = Date.now();

  // Seed data IDs
  let variantId = "";
  let locationId = "";

  beforeAll(async () => {
    ts_ = await createTestServer({
      skipListen: true,
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      serverOverrides: {
        taxAdapter: createStateSensitiveTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createCapturingPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

    // 1. Create product + variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `taxflow-prod-${run}`,
        title: `Tax Flow Product ${run}`,
        status: "active",
      })
      .returning();

    const [v] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `TAXFLOW-V-${run}`,
        title: `Tax Flow Variant ${run}`,
        priceMinor: 5000, // $50.00
        status: "active",
        weight: "10",
      })
      .returning();
    variantId = v.id;

    // 2. Product class + membership (needed for catalog)
    const [cls] = await db
      .insert(productClass)
      .values({ name: `TaxFlow Class ${run}`, slug: `taxflow-class-${run}` })
      .returning();

    await db.insert(productClassMembership).values({
      productId: prod.id,
      productClassId: cls.id,
    });

    // 3. Inventory — reuse existing location if available
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
            name: `TaxFlow Warehouse ${run}`,
            code: `TAXFLOW-WH-${run}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values({
      variantId,
      locationId,
      onHand: 100,
      reserved: 0,
      available: 100,
    });
  }, 30_000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  // Helper: create a fresh cart and add one item
  async function createCartWithItem(): Promise<string> {
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.statusCode).toBe(201);
    const token = JSON.parse(cartRes.body).cart.token;

    const addRes = await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": token,
      },
      body: JSON.stringify({ variant_id: variantId, quantity: 2 }),
    });
    expect(addRes.statusCode).toBeLessThan(300);
    return token;
  }

  // -------------------------------------------------------------------------
  // Scenario 1: TX shipping → non-zero tax + tax_calculation_id in metadata
  // -------------------------------------------------------------------------

  it("TX address: checkout produces non-zero tax and PaymentIntent metadata includes tax_calculation_id", async () => {
    const cartToken = await createCartWithItem();

    // Reset captured metadata
    capturedMetadata = {};

    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `tax-tx-${run}@example.com`,
        shipping_address: TX_ADDRESS,
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // Subtotal: 5000 * 2 = 10000 cents ($100)
    expect(body.order.subtotal_minor).toBe(10000);

    // Tax: 10000 * 0.0825 = 825 cents ($8.25) — TX rate
    expect(body.order.tax_minor).toBe(825);
    expect(body.order.tax_minor).toBeGreaterThan(0);

    // Shipping: 599 (stub)
    expect(body.order.shipping_minor).toBe(599);

    // Total: 10000 + 825 + 599 = 11424
    expect(body.order.total_minor).toBe(10000 + 825 + 599);

    // PaymentIntent metadata includes tax_calculation_id
    expect(capturedMetadata.tax_calculation_id).toBeDefined();
    expect(capturedMetadata.tax_calculation_id).toMatch(/^txcalc_flow_TX_/);
    expect(capturedMetadata.cart_id).toBeDefined();

    // client_secret present
    expect(typeof body.client_secret).toBe("string");
    expect(body.client_secret.length).toBeGreaterThan(0);

    // Verify DB persists correct tax
    const db = dbConn.db;
    const [savedOrder] = await db.select().from(order).where(eq(order.id, body.order.id));
    expect(savedOrder.taxMinor).toBe(825);
    expect(savedOrder.totalMinor).toBe(11424);
    expect(savedOrder.subtotalMinor).toBe(10000);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Scenario 2: Tax-exempt state (OR) → zero tax
  // -------------------------------------------------------------------------

  it("OR address (tax-exempt): checkout produces zero tax", async () => {
    const cartToken = await createCartWithItem();

    // Reset captured metadata
    capturedMetadata = {};

    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `tax-or-${run}@example.com`,
        shipping_address: OR_ADDRESS,
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // Subtotal: 5000 * 2 = 10000
    expect(body.order.subtotal_minor).toBe(10000);

    // Tax: 0 (tax-exempt state)
    expect(body.order.tax_minor).toBe(0);

    // Shipping: 599 (stub)
    expect(body.order.shipping_minor).toBe(599);

    // Total: 10000 + 0 + 599 = 10599
    expect(body.order.total_minor).toBe(10599);

    // PaymentIntent metadata should NOT include tax_calculation_id (null → omitted)
    expect(capturedMetadata.tax_calculation_id).toBeUndefined();
    expect(capturedMetadata.cart_id).toBeDefined();

    // Verify DB persists zero tax
    const db = dbConn.db;
    const [savedOrder] = await db.select().from(order).where(eq(order.id, body.order.id));
    expect(savedOrder.taxMinor).toBe(0);
    expect(savedOrder.totalMinor).toBe(10599);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Scenario 3: Missing state in address → 400 validation error
  // -------------------------------------------------------------------------

  it("missing state: checkout returns 400 with validation error", async () => {
    const cartToken = await createCartWithItem();

    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `tax-nostate-${run}@example.com`,
        shipping_address: {
          full_name: "No State Tester",
          line1: "300 Main St",
          city: "Somewhere",
          // state intentionally omitted
          postal_code: "00000",
          country: "US",
        },
      }),
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("state");
  });
});
