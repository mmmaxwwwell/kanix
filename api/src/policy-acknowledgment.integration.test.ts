import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { policySnapshot, orderPolicyAcknowledgment } from "./db/schema/evidence.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";
import { findInventoryBalances } from "./db/queries/index.js";

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

describe("policy acknowledgment (T216)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now();

  let activeVariantId = "";

  function checkoutBody(cartToken: string) {
    return {
      cart_token: cartToken,
      email: `policy-t216-${Date.now()}@example.com`,
      shipping_address: {
        full_name: "Policy Test User",
        line1: "456 Oak Ave",
        city: "Austin",
        state: "TX",
        postal_code: "78702",
        country: "US",
      },
    };
  }

  async function createCartWithItem(): Promise<string> {
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
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 1 }),
    });

    return token;
  }

  beforeAll(async () => {
    ts_ = await createTestServer({
      skipListen: true,
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

    // Find the default location (same one checkout uses via findInventoryBalances)
    const balances = await findInventoryBalances(db, {});
    const defaultLocationId = balances[0]?.locationId;
    if (!defaultLocationId) {
      throw new Error("No inventory location found — seed data missing");
    }

    // Seed product + variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `pol-t216-prod-${ts}`,
        title: `Policy T216 Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `POL216-${ts}`,
        title: `Policy T216 Variant ${ts}`,
        priceMinor: 1500,
        status: "active",
        weight: "16",
      })
      .returning();
    activeVariantId = variant.id;

    // Insert inventory at the DEFAULT location (matches checkout behavior)
    await db.insert(inventoryBalance).values({
      variantId: activeVariantId,
      locationId: defaultLocationId,
      onHand: 200,
      reserved: 0,
      available: 200,
    });

    // Ensure all 4 policy types have an effective snapshot (use onConflictDoNothing
    // since the shared DB may already have them from prior runs)
    const policyTypes = [
      "terms_of_service",
      "refund_policy",
      "shipping_policy",
      "privacy_policy",
    ];
    for (const pt of policyTypes) {
      await db
        .insert(policySnapshot)
        .values({
          policyType: pt,
          version: 1,
          contentHtml: `<p>${pt} v1 content</p>`,
          contentText: `${pt} v1 content`,
          effectiveAt: new Date(Date.now() - 86400000),
        })
        .onConflictDoNothing();
    }
  }, 30000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  describe("happy path: checkout creates acknowledgments", () => {
    it("creates acknowledgment records for all 4 policy types with concrete timestamps and versions", async () => {
      const beforeCheckout = Date.now();

      const cartToken = await createCartWithItem();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(cartToken)),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      const orderId = body.order.id;
      expect(typeof orderId).toBe("string");
      expect(body.client_secret).toMatch(/^pi_policy_test_/);

      // Verify acknowledgment records in DB
      const db = dbConn.db;
      const acknowledgments = await db
        .select()
        .from(orderPolicyAcknowledgment)
        .where(eq(orderPolicyAcknowledgment.orderId, orderId));

      expect(acknowledgments).toHaveLength(4);

      // Collect policy types via their linked snapshots
      const coveredTypes: string[] = [];
      for (const ack of acknowledgments) {
        // orderId linkage
        expect(ack.orderId).toBe(orderId);

        // policySnapshotId is a valid UUID
        expect(ack.policySnapshotId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );

        // acknowledgedAt is a recent timestamp (within checkout window)
        const ackTime = new Date(ack.acknowledgedAt).getTime();
        expect(ackTime).toBeGreaterThanOrEqual(beforeCheckout);
        expect(ackTime).toBeLessThanOrEqual(Date.now());

        // Linked snapshot exists with a concrete version number
        const [snapshot] = await db
          .select()
          .from(policySnapshot)
          .where(eq(policySnapshot.id, ack.policySnapshotId));
        expect(typeof snapshot.version).toBe("number");
        expect(snapshot.version).toBeGreaterThanOrEqual(1);
        expect(snapshot.contentHtml.length).toBeGreaterThan(0);
        expect(snapshot.contentText.length).toBeGreaterThan(0);
        coveredTypes.push(snapshot.policyType);
      }

      // All 4 required policy types are represented
      expect(coveredTypes.sort()).toEqual([
        "privacy_policy",
        "refund_policy",
        "shipping_policy",
        "terms_of_service",
      ]);
    }, 30000);
  });

  describe("missing policies: checkout returns 400", () => {
    it("returns 400 ERR_MISSING_POLICY naming every missing policy type", async () => {
      const db = dbConn.db;

      // Make all policy snapshots "not yet effective" by shifting effective_at to far future.
      // This avoids FK constraint issues from deleting referenced rows.
      const farFuture = new Date("3000-01-01T00:00:00Z");
      await db
        .update(policySnapshot)
        .set({ effectiveAt: farFuture });

      try {
        const cartToken = await createCartWithItem();
        const res = await app.inject({
          method: "POST",
          url: "/api/checkout",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(checkoutBody(cartToken)),
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("ERR_MISSING_POLICY");
        expect(body.missing_policies).toEqual(
          expect.arrayContaining([
            "terms_of_service",
            "refund_policy",
            "shipping_policy",
            "privacy_policy",
          ]),
        );
        expect(body.missing_policies).toHaveLength(4);
        expect(body.message).toContain("terms_of_service");
        expect(body.message).toContain("privacy_policy");
      } finally {
        // Restore effective_at to the past so subsequent tests work
        const past = new Date(Date.now() - 86400000);
        await db
          .update(policySnapshot)
          .set({ effectiveAt: past });
      }
    }, 30000);

    it("returns 400 naming only the specific missing policy when one is absent", async () => {
      const db = dbConn.db;

      // Make only privacy_policy ineffective
      const farFuture = new Date("3000-01-01T00:00:00Z");
      await db
        .update(policySnapshot)
        .set({ effectiveAt: farFuture })
        .where(eq(policySnapshot.policyType, "privacy_policy"));

      try {
        const cartToken = await createCartWithItem();
        const res = await app.inject({
          method: "POST",
          url: "/api/checkout",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(checkoutBody(cartToken)),
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("ERR_MISSING_POLICY");
        expect(body.missing_policies).toEqual(["privacy_policy"]);
        expect(body.message).toContain("privacy_policy");
      } finally {
        // Restore
        const past = new Date(Date.now() - 86400000);
        await db
          .update(policySnapshot)
          .set({ effectiveAt: past })
          .where(eq(policySnapshot.policyType, "privacy_policy"));
      }
    }, 30000);
  });

  describe("re-acknowledgment on policy version bump", () => {
    it("new checkout links to updated policy version after version bump", async () => {
      const db = dbConn.db;

      // Insert a new version of terms_of_service with a unique high version number
      // and a more recent effective_at so it becomes the "current" policy
      const uniqueVersion = 900000 + Math.floor(Math.random() * 99999);
      const [v2Snapshot] = await db
        .insert(policySnapshot)
        .values({
          policyType: "terms_of_service",
          version: uniqueVersion,
          contentHtml: `<p>terms_of_service v${uniqueVersion} updated content</p>`,
          contentText: `terms_of_service v${uniqueVersion} updated content`,
          effectiveAt: new Date(Date.now() - 500), // just now
        })
        .returning();

      // Checkout should pick up the new version
      const cartToken = await createCartWithItem();
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkoutBody(cartToken)),
      });

      expect(res.statusCode).toBe(201);
      const orderId = JSON.parse(res.body).order.id;

      // Find acknowledgments for this order
      const acks = await db
        .select()
        .from(orderPolicyAcknowledgment)
        .where(eq(orderPolicyAcknowledgment.orderId, orderId));

      expect(acks).toHaveLength(4);

      // Find the terms_of_service acknowledgment
      let tosAck: { policySnapshotId: string; acknowledgedAt: Date } | null = null;
      let tosSnap: { id: string; version: number; policyType: string; contentText: string } | null = null;

      for (const ack of acks) {
        const [snap] = await db
          .select()
          .from(policySnapshot)
          .where(eq(policySnapshot.id, ack.policySnapshotId));
        if (snap.policyType === "terms_of_service") {
          tosAck = ack;
          tosSnap = snap;
          break;
        }
      }

      // Must link to the new version, not any older one
      expect(tosSnap).not.toBeNull();
      expect(tosSnap!.id).toBe(v2Snapshot.id);
      expect(tosSnap!.version).toBe(uniqueVersion);
      expect(tosSnap!.contentText).toContain(`v${uniqueVersion} updated content`);

      // Other policy types still have their own latest versions (not changed)
      for (const ack of acks) {
        const [snap] = await db
          .select()
          .from(policySnapshot)
          .where(eq(policySnapshot.id, ack.policySnapshotId));
        if (snap.policyType !== "terms_of_service") {
          // Each non-ToS policy links to a valid snapshot with a version >= 1
          expect(snap.version).toBeGreaterThanOrEqual(1);
        }
      }
    }, 30000);
  });
});
