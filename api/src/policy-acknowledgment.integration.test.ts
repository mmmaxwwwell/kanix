import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { policySnapshot, orderPolicyAcknowledgment } from "./db/schema/evidence.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { assertSuperTokensUp, getSuperTokensUri, requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();
const SUPERTOKENS_URI = getSuperTokensUri();

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: DATABASE_URL,
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "whsec_xxx",
    PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_xxx",
    STRIPE_TAX_ENABLED: false,
    SUPERTOKENS_API_KEY: "test-key",
    SUPERTOKENS_CONNECTION_URI: SUPERTOKENS_URI,
    EASYPOST_API_KEY: "test-key",
    EASYPOST_WEBHOOK_SECRET: "",
    GITHUB_OAUTH_CLIENT_ID: "test-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW_MS: 60000,
    ...overrides,
  };
}

function createFakeProcess(): EventEmitter {
  return new EventEmitter();
}

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
        id: `pi_policy_test_${paymentAdapterCallCount}_${Date.now()}`,
        clientSecret: `pi_policy_test_${paymentAdapterCallCount}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_test_${Date.now()}`, status: "succeeded" };
    },
  };
}

describe("policy acknowledgment (T054)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now();

  let activeVariantId = "";
  let locationId = "";
  let cartToken = "";

  beforeAll(async () => {
    await assertSuperTokensUp();
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      reservationCleanupIntervalMs: 0,
      taxAdapter: createStubTaxAdapter(),
      shippingAdapter: createStubShippingAdapter(),
      paymentAdapter: createStubPaymentAdapter(),
    });
    app = server.app;

    await server.start();
    markReady();

    // Seed test data
    // 1. Product + variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `policy-test-prod-${ts}`,
        title: `Policy Test Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `POL-VAR1-${ts}`,
        title: `Policy Variant ${ts}`,
        priceMinor: 1500,
        status: "active",
        weight: "16",
      })
      .returning();
    activeVariantId = variant.id;

    // 2. Inventory location + balance
    const [loc] = await db
      .insert(inventoryLocation)
      .values({
        name: `Policy Warehouse ${ts}`,
        code: `POL-WH-${ts}`,
        type: "warehouse",
      })
      .returning();
    locationId = loc.id;

    await db.insert(inventoryBalance).values({
      variantId: activeVariantId,
      locationId,
      onHand: 50,
      reserved: 0,
      available: 50,
    });

    // 3. Seed policy snapshots for testing
    const now = new Date();
    const policyTypes = ["terms_of_service", "refund_policy", "shipping_policy", "privacy_policy"];
    for (const pType of policyTypes) {
      await db
        .insert(policySnapshot)
        .values({
          policyType: pType,
          version: 1,
          contentHtml: `<p>${pType} v1 content</p>`,
          contentText: `${pType} v1 content`,
          effectiveAt: new Date(now.getTime() - 86400000), // yesterday
        })
        .onConflictDoNothing();
    }

    // 4. Create a cart with an item
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartData = JSON.parse(cartRes.body);
    cartToken = cartData.cart.token;

    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 1 }),
    });
  }, 30000);

  afterAll(async () => {
    markNotReady();
    try {
      await app?.close();
    } catch {
      // ignore
    }
    try {
      await dbConn?.close();
    } catch {
      // ignore
    }
  });

  it("should create policy acknowledgment records during checkout", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: "policy-test@example.com",
        shipping_address: {
          full_name: "Policy Test User",
          line1: "456 Oak Ave",
          city: "Austin",
          state: "TX",
          postal_code: "78702",
          country: "US",
        },
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const orderId = body.order.id;

    // Verify acknowledgment records exist with correct policy versions
    const db = dbConn.db;
    const acknowledgments = await db
      .select()
      .from(orderPolicyAcknowledgment)
      .where(eq(orderPolicyAcknowledgment.orderId, orderId));

    // Should have acknowledgments for all 4 policy types
    expect(acknowledgments.length).toBe(4);

    // Verify each acknowledgment links to a valid policy snapshot
    for (const ack of acknowledgments) {
      expect(ack.policySnapshotId).toBeDefined();
      expect(ack.acknowledgedAt).toBeDefined();

      // Look up the linked snapshot
      const [snapshot] = await db
        .select()
        .from(policySnapshot)
        .where(eq(policySnapshot.id, ack.policySnapshotId));
      expect(snapshot).toBeDefined();
      expect(snapshot.version).toBe(1);
    }

    // Verify the policy types are all represented
    const snapshotIds = acknowledgments.map((a) => a.policySnapshotId);

    // Get all snapshots for all acknowledgments
    const allSnapshots = [];
    for (const sid of snapshotIds) {
      const [s] = await db.select().from(policySnapshot).where(eq(policySnapshot.id, sid));
      allSnapshots.push(s);
    }

    const policyTypes = allSnapshots.map((s) => s.policyType).sort();
    expect(policyTypes).toEqual([
      "privacy_policy",
      "refund_policy",
      "shipping_policy",
      "terms_of_service",
    ]);
  }, 30000);
});
