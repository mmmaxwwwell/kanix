/**
 * T102 E2E: concurrent inventory [SC-003]
 *
 * Scripted API-level concurrency test (no MCP needed):
 *   1 unit available → 10 concurrent checkout POSTs →
 *   exactly 1 succeeds → 9 fail with ERR_INVENTORY_INSUFFICIENT →
 *   available = 0
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import { productClass, productClassMembership } from "../db/schema/product-class.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "../db/schema/inventory.js";
import { policySnapshot } from "../db/schema/evidence.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_concurrent_inventory_flow_test";

/** Total stock for the variant under test — exactly 1 unit */
const STOCK_M = 1;

/** Number of concurrent checkout attempts */
const CONCURRENCY_N = 10;

const VALID_ADDRESS = {
  full_name: "Concurrent Tester",
  line1: "789 Race Condition Blvd",
  city: "Austin",
  state: "TX",
  postal_code: "78702",
  country: "US",
};

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createStubTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 100, calculationId: `txcalc_conc_${Date.now()}` };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_conc_flow_${piCounter}_${Date.now()}`,
        clientSecret: `pi_conc_flow_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_conc_flow_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("concurrent inventory (T102, SC-003)", () => {
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
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

    // 1. Product + variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `conc-prod-${run}`,
        title: `Concurrent Product ${run}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `CONC-V-${run}`,
        title: `Concurrent Variant ${run}`,
        priceMinor: 1500,
        status: "active",
        weight: "8",
      })
      .returning();
    variantId = variant.id;

    // 2. Product class + membership (needed for catalog listing)
    const [cls] = await db
      .insert(productClass)
      .values({ name: `Conc Class ${run}`, slug: `conc-class-${run}` })
      .returning();

    await db.insert(productClassMembership).values({
      productId: prod.id,
      productClassId: cls.id,
    });

    // 3. Inventory location + balance with exactly 1 unit available
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
            name: `Conc Warehouse ${run}`,
            code: `CONC-WH-${run}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values({
      variantId,
      locationId,
      onHand: STOCK_M,
      reserved: 0,
      available: STOCK_M,
    });

    // 4. Seed required policy snapshots for checkout
    const policyTypes = ["terms_of_service", "refund_policy", "shipping_policy", "privacy_policy"];
    for (const pType of policyTypes) {
      await db
        .insert(policySnapshot)
        .values({
          policyType: pType,
          version: 1,
          contentHtml: `<p>${pType} v1</p>`,
          contentText: `${pType} v1`,
          effectiveAt: new Date(Date.now() - 86400000),
        })
        .onConflictDoNothing();
    }
  }, 30_000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Helper: create a guest cart with 1 unit of our variant
  // -------------------------------------------------------------------------

  async function createCartWithOneUnit(): Promise<string> {
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartData = JSON.parse(cartRes.body);
    const token = cartData.cart.token;

    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": token,
      },
      body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
    });

    return token;
  }

  // -------------------------------------------------------------------------
  // Step 1: Pre-create N carts, each with 1 unit
  // -------------------------------------------------------------------------

  let cartTokens: string[] = [];

  it("step 1: pre-create 10 carts each with 1 unit of the variant", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < CONCURRENCY_N; i++) {
      tokens.push(await createCartWithOneUnit());
    }
    cartTokens = tokens;
    expect(cartTokens.length).toBe(CONCURRENCY_N);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Step 2: Fire 10 concurrent checkouts — exactly 1 succeeds, 9 fail
  // -------------------------------------------------------------------------

  let successOrderIds: string[] = [];

  it("step 2: 10 concurrent checkouts with 1 unit → exactly 1 succeeds, 9 fail ERR_INVENTORY_INSUFFICIENT", async () => {
    const results = await Promise.allSettled(
      cartTokens.map((token, i) =>
        app.inject({
          method: "POST",
          url: "/api/checkout",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cart_token: token,
            email: `conc-${i}-${run}@example.com`,
            shipping_address: { ...VALID_ADDRESS },
          }),
        }),
      ),
    );

    const successes: string[] = [];
    let inv400 = 0;

    for (const result of results) {
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") continue;

      const res = result.value;
      if (res.statusCode === 201) {
        const body = JSON.parse(res.body);
        expect(body.order).toBeDefined();
        expect(body.order.id).toBeTruthy();
        successes.push(body.order.id);
      } else if (res.statusCode === 400) {
        const body = JSON.parse(res.body);
        expect(body.error).toBe("ERR_INVENTORY_INSUFFICIENT");
        inv400++;
      } else {
        // Unexpected status — fail with details
        throw new Error(
          `Unexpected status ${res.statusCode}: ${res.body}`,
        );
      }
    }

    successOrderIds = successes;

    // Exactly 1 succeeds (1 unit available)
    expect(successes.length).toBe(1);
    // Exactly 9 fail with ERR_INVENTORY_INSUFFICIENT
    expect(inv400).toBe(CONCURRENCY_N - STOCK_M);
    // All 10 accounted for
    expect(successes.length + inv400).toBe(CONCURRENCY_N);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Step 3: Verify final inventory balance — available=0
  // -------------------------------------------------------------------------

  it("step 3: final inventory balance has available=0", async () => {
    const db = dbConn.db;

    const [balance] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
      );

    expect(balance).toBeDefined();
    expect(balance.available).toBe(0);
    expect(balance.reserved).toBe(STOCK_M);
    expect(balance.onHand).toBe(STOCK_M);
    expect(balance.available).toBeGreaterThanOrEqual(0);
    expect(balance.reserved).toBeGreaterThanOrEqual(0);
    expect(balance.onHand).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // Step 4: Exactly 1 active reservation exists
  // -------------------------------------------------------------------------

  it("step 4: exactly 1 active reservation exists for this variant", async () => {
    const db = dbConn.db;

    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(
        and(
          eq(inventoryReservation.variantId, variantId),
          eq(inventoryReservation.status, "active"),
        ),
      );

    expect(reservations.length).toBe(STOCK_M);
    expect(reservations[0].quantity).toBe(1);

    // The successful order should have its reservation linked
    const linked = reservations.find((r) => r.orderId === successOrderIds[0]);
    expect(linked).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Step 5: No orphan or leaked reservations
  // -------------------------------------------------------------------------

  it("step 5: no orphan or leaked reservations for this variant", async () => {
    const db = dbConn.db;

    const allReservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.variantId, variantId));

    for (const res of allReservations) {
      expect(["active", "released"]).toContain(res.status);
    }

    const activeCount = allReservations.filter((r) => r.status === "active").length;
    expect(activeCount).toBe(STOCK_M);
  });
});
