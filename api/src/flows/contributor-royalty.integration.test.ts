/**
 * Flow test: contributor royalty [mirrors T101, SC-011]
 *
 * Walks the complete contributor royalty lifecycle via HTTP calls + DB queries
 * against the real stack:
 *   contributor signup → product created and attributed → N units sold crossing
 *   each milestone → royalty ledger entries verified at each threshold
 *   (retroactive 10%, 20% rate change, starter kit) → contributor dashboard
 *   totals match ledger sum.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, sql, inArray, and } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import { productClass, productClassMembership } from "../db/schema/product-class.js";
import { inventoryBalance, inventoryLocation } from "../db/schema/inventory.js";
import { order, orderLine, orderStatusHistory } from "../db/schema/order.js";
import { payment } from "../db/schema/payment.js";
import {
  contributor,
  contributorDesign,
  contributorRoyalty,
  contributorMilestone,
  contributorDonation,
} from "../db/schema/contributor.js";
import { customer } from "../db/schema/customer.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";
import { createHmac } from "node:crypto";
import {
  createContributor,
  linkContributorDesign,
  processOrderCompletionSales,
  getContributorDashboard,
  listMilestonesByContributor,
  ROYALTY_ACTIVATION_THRESHOLD,
  STARTER_KIT_THRESHOLD,
  VETERAN_THRESHOLD,
  ROYALTY_RATE,
  VETERAN_RATE,
} from "../db/queries/contributor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_contributor_royalty_flow_test";
const run = Date.now();
const CONTRIBUTOR_EMAIL = `contrib-flow-${run}@example.com`;
const CONTRIBUTOR_PASSWORD = "ContribFlowPass123!";
const BUYER_EMAIL_PREFIX = `buyer-flow-${run}`;
const BUYER_PASSWORD = "BuyerFlowPass123!";

const UNIT_PRICE_MINOR = 3000; // $30.00

const VALID_ADDRESS = {
  full_name: "Royalty Flow Buyer",
  line1: "100 Royalty Ln",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
};

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createStubTaxAdapter(taxMinor = 150): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: taxMinor, calculationId: `txcalc_contrib_${Date.now()}` };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_contrib_flow_${piCounter}_${Date.now()}`,
        clientSecret: `pi_contrib_flow_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_contrib_flow_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence(input) {
      return { id: input.providerDisputeId, status: "under_review" };
    },
  };
}

// ---------------------------------------------------------------------------
// Stripe webhook helper
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
// Auth helpers
// ---------------------------------------------------------------------------

async function signUpUser(
  address: string,
  email: string,
  password: string,
): Promise<{ userId: string }> {
  const res = await fetch(`${address}/auth/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    status: string;
    user: { id: string };
  };
  expect(body.status).toBe("OK");
  return { userId: body.user.id };
}

async function verifyEmail(userId: string): Promise<void> {
  const { default: supertokens } = await import("supertokens-node");
  const { default: EmailVerification } =
    await import("supertokens-node/recipe/emailverification/index.js");
  const tokenRes = await EmailVerification.createEmailVerificationToken(
    "public",
    supertokens.convertToRecipeUserId(userId),
  );
  if (tokenRes.status === "OK") {
    await EmailVerification.verifyEmailUsingToken("public", tokenRes.token);
  }
}

async function signIn(
  address: string,
  email: string,
  password: string,
): Promise<{ headers: Record<string, string> }> {
  const res = await fetch(`${address}/auth/signin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie();
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const accessToken = res.headers.get("st-access-token") ?? "";
  const antiCsrf = res.headers.get("anti-csrf");

  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    cookie: cookieHeader,
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  if (antiCsrf) headers["anti-csrf"] = antiCsrf;

  return { headers };
}

// ---------------------------------------------------------------------------
// Order creation helper — creates a buyer, checks out, confirms via webhook
// ---------------------------------------------------------------------------

async function createCompletedOrder(
  app: FastifyInstance,
  address: string,
  db: import("drizzle-orm/postgres-js").PostgresJsDatabase,
  variantId: string,
  quantity: number,
  buyerIndex: number,
): Promise<{
  orderId: string;
  orderLineIds: string[];
  paymentIntentId: string;
}> {
  const email = `${BUYER_EMAIL_PREFIX}-${buyerIndex}@example.com`;
  const { userId } = await signUpUser(address, email, BUYER_PASSWORD);
  await verifyEmail(userId);
  const { headers } = await signIn(address, email, BUYER_PASSWORD);

  // Create cart
  const cartRes = await fetch(`${address}/api/cart`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(cartRes.status).toBe(201);
  const cartData = (await cartRes.json()) as { cart: { token: string } };
  const cartToken = cartData.cart.token;

  // Add items
  const addRes = await fetch(`${address}/api/cart/items`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "x-cart-token": cartToken,
    },
    body: JSON.stringify({ variant_id: variantId, quantity }),
  });
  expect(addRes.status).toBeLessThan(300);

  // Checkout
  const checkoutRes = await fetch(`${address}/api/checkout`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      cart_token: cartToken,
      email,
      shipping_address: { ...VALID_ADDRESS },
    }),
  });
  expect(checkoutRes.status).toBe(201);

  const checkoutBody = (await checkoutRes.json()) as {
    order: { id: string; status: string };
    client_secret: string;
  };
  const orderId = checkoutBody.order.id;
  expect(checkoutBody.order.status).toBe("pending_payment");

  // Get payment intent ID
  const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
  const paymentIntentId = paymentRow.providerPaymentIntentId;

  // Get order line IDs
  const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, orderId));
  const orderLineIds = lines.map((l) => l.id);

  // Simulate payment_intent.succeeded webhook
  const { body: whBody, signature } = generateStripeWebhookPayload(
    `evt_contrib_pay_${buyerIndex}_${run}`,
    "payment_intent.succeeded",
    {
      id: paymentIntentId,
      object: "payment_intent",
      amount: UNIT_PRICE_MINOR * quantity + 150 + 599,
      currency: "usd",
      status: "succeeded",
      latest_charge: `ch_contrib_flow_${buyerIndex}_${run}`,
    },
    WEBHOOK_SECRET,
  );

  const webhookRes = await app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    body: whBody,
  });
  expect(webhookRes.statusCode).toBe(200);

  // Verify order confirmed
  const [confirmedOrder] = await db.select().from(order).where(eq(order.id, orderId));
  expect(confirmedOrder.status).toBe("confirmed");
  expect(confirmedOrder.paymentStatus).toBe("paid");

  // Transition to completed (simulating fulfillment)
  await db.update(order).set({ status: "completed" }).where(eq(order.id, orderId));

  return { orderId, orderLineIds, paymentIntentId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contributor royalty flow (T265, mirrors T101/SC-011)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  // Seed IDs
  let productId = "";
  let variantId = "";
  let locationId = "";
  let classId = "";
  let contributorId = "";
  let designId = "";

  // Contributor auth
  let contributorAuthUserId = "";
  let contributorHeaders: Record<string, string> = {};
  let contributorCustomerId = "";

  // Track created orders for cleanup
  const createdOrderIds: string[] = [];
  let buyerCounter = 0;

  beforeAll(async () => {
    ts_ = await createTestServer({
      configOverrides: {
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        EASYPOST_WEBHOOK_SECRET: "",
      },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(150),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // 1. Product with one variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `crflow-prod-${run}`,
        title: `Contributor Royalty Flow Product ${run}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    const [v] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `CRFLOW-V-${run}`,
        title: `CR Flow Variant ${run}`,
        priceMinor: UNIT_PRICE_MINOR,
        status: "active",
        weight: "8",
      })
      .returning();
    variantId = v.id;

    // 2. Product class + membership
    const [cls] = await db
      .insert(productClass)
      .values({ name: `CRFlow Class ${run}`, slug: `crflow-class-${run}` })
      .returning();
    classId = cls.id;

    await db.insert(productClassMembership).values({
      productId: prod.id,
      productClassId: cls.id,
    });

    // 3. Inventory — generous stock for many orders
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
            name: `CRFlow Warehouse ${run}`,
            code: `CRFLOW-WH-${run}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values({
      variantId,
      locationId,
      onHand: 1000,
      reserved: 0,
      available: 1000,
    });
  }, 30_000);

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      try {
        // Clean royalties
        if (contributorId) {
          await db
            .delete(contributorRoyalty)
            .where(eq(contributorRoyalty.contributorId, contributorId));
          await db
            .delete(contributorMilestone)
            .where(eq(contributorMilestone.contributorId, contributorId));
          await db
            .delete(contributorDonation)
            .where(eq(contributorDonation.contributorId, contributorId));
        }

        // Clean order-related data
        for (const oid of createdOrderIds) {
          await db.execute(
            sql`DELETE FROM payment_event WHERE payment_id IN (SELECT id FROM payment WHERE order_id = ${oid})`,
          );
          await db.delete(payment).where(eq(payment.orderId, oid));
          await db.execute(sql`DELETE FROM inventory_reservation WHERE order_id = ${oid}`);
          await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, oid));
          await db.delete(orderLine).where(eq(orderLine.orderId, oid));
          await db.delete(order).where(eq(order.id, oid));
        }

        // Clean contributor design
        if (designId) {
          await db.delete(contributorDesign).where(eq(contributorDesign.id, designId));
        }

        // Clean contributor
        if (contributorId) {
          await db.delete(contributor).where(eq(contributor.id, contributorId));
        }

        // Clean inventory + product
        await db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, variantId));
        await db
          .delete(productClassMembership)
          .where(eq(productClassMembership.productId, productId));
        await db.delete(productClass).where(eq(productClass.id, classId));
        await db.delete(productVariant).where(eq(productVariant.productId, productId));
        await db.delete(product).where(eq(product.id, productId));
      } catch {
        // Best-effort cleanup
      }
    }

    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Step 1: Contributor signup via GitHub-linked account
  // -------------------------------------------------------------------------

  it("step 1: contributor signs up, verifies email, and creates contributor profile", async () => {
    const { userId } = await signUpUser(address, CONTRIBUTOR_EMAIL, CONTRIBUTOR_PASSWORD);
    contributorAuthUserId = userId;
    await verifyEmail(contributorAuthUserId);

    const { headers } = await signIn(address, CONTRIBUTOR_EMAIL, CONTRIBUTOR_PASSWORD);
    contributorHeaders = headers;

    // Get customer ID
    const meRes = await fetch(`${address}/api/customer/me`, { headers: contributorHeaders });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      customer: { id: string; email: string };
    };
    expect(meBody.customer.email).toBe(CONTRIBUTOR_EMAIL);
    contributorCustomerId = meBody.customer.id;

    // Create contributor profile via DB (simulating GitHub OAuth linkage)
    const db = dbConn.db;
    const contribRow = await createContributor(db, {
      githubUsername: `crflow-user-${run}`,
      githubUserId: `gh-${run}`,
      customerId: contributorCustomerId,
      claAcceptedAt: new Date(),
      claVersion: "1.0",
      profileVisibility: "public",
    });

    contributorId = contribRow.id;
    expect(contribRow.status).toBe("active");
    expect(contribRow.claAcceptedAt).not.toBeNull();
    expect(contribRow.claVersion).toBe("1.0");
    expect(contribRow.githubUsername).toBe(`crflow-user-${run}`);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 2: Product attributed to contributor
  // -------------------------------------------------------------------------

  it("step 2: link product to contributor as a design", async () => {
    const db = dbConn.db;

    const design = await linkContributorDesign(db, {
      contributorId,
      productId,
    });

    designId = design.id;
    expect(design.contributorId).toBe(contributorId);
    expect(design.productId).toBe(productId);
    expect(design.createdAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // Step 3: Sell 20 units (below 25-unit threshold — no royalties yet)
  // -------------------------------------------------------------------------

  it("step 3: sell 20 units — below activation threshold, no royalties created", async () => {
    const db = dbConn.db;

    // Create 4 orders of 5 units each = 20 total
    for (let i = 0; i < 4; i++) {
      buyerCounter++;
      const result = await createCompletedOrder(app, address, db, variantId, 5, buyerCounter);
      createdOrderIds.push(result.orderId);

      // Process sales for each order
      const salesResult = await processOrderCompletionSales(db, result.orderId);
      expect(salesResult.sales.length).toBe(1);
      expect(salesResult.sales[0].royaltyCreated).toBe(false); // Below threshold
    }

    // Verify no royalties exist yet
    const royalties = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.contributorId, contributorId));
    expect(royalties.length).toBe(0);

    // Verify sales count is 20
    const [design] = await db
      .select({ salesCount: contributorDesign.salesCount })
      .from(contributorDesign)
      .where(eq(contributorDesign.id, designId));
    expect(design.salesCount).toBe(20);

    // No milestones yet
    const milestones = await listMilestonesByContributor(db, contributorId);
    expect(milestones.length).toBe(0);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Step 4: Sell 5 more units — crosses 25-unit threshold, retroactive royalties
  // -------------------------------------------------------------------------

  it("step 4: sell 5 more units — crosses 25-unit threshold, retroactive 10% royalties created for all 25 units", async () => {
    const db = dbConn.db;

    buyerCounter++;
    const result = await createCompletedOrder(app, address, db, variantId, 5, buyerCounter);
    createdOrderIds.push(result.orderId);

    // Process sales — this crosses the 25-unit threshold
    const salesResult = await processOrderCompletionSales(db, result.orderId);
    expect(salesResult.sales.length).toBe(1);
    expect(salesResult.sales[0].previousSalesCount).toBe(20);
    expect(salesResult.sales[0].newSalesCount).toBe(25);
    expect(salesResult.sales[0].royaltyCreated).toBe(true);

    // Verify royalty_activation milestone was auto-detected
    expect(salesResult.newMilestones.length).toBeGreaterThanOrEqual(1);
    const activationMilestone = salesResult.newMilestones.find(
      (m) => m.milestoneType === "royalty_activation",
    );
    expect(activationMilestone).toBeDefined();

    // Verify retroactive royalties: should have royalty entries for all 25 units
    // across all 5 orders (4 × 5 units + 1 × 5 units)
    const royalties = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.contributorId, contributorId));
    expect(royalties.length).toBe(5); // One per order line (5 orders)

    // Each royalty = floor(3000 * 0.10) * quantity = 300 * 5 = 1500
    const expectedPerLine = Math.floor(UNIT_PRICE_MINOR * ROYALTY_RATE) * 5;
    expect(expectedPerLine).toBe(1500);
    for (const r of royalties) {
      expect(r.amountMinor).toBe(expectedPerLine);
      expect(r.status).toBe("accrued");
    }

    // Total royalties = 5 × 1500 = 7500
    const totalRoyalties = royalties.reduce((sum, r) => sum + r.amountMinor, 0);
    expect(totalRoyalties).toBe(7500);

    // Verify sales count is now 25
    const [design] = await db
      .select({ salesCount: contributorDesign.salesCount })
      .from(contributorDesign)
      .where(eq(contributorDesign.id, designId));
    expect(design.salesCount).toBe(25);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Step 5: Sell 25 more units — crosses 50-unit starter kit milestone
  // -------------------------------------------------------------------------

  it("step 5: sell 25 more units — crosses 50-unit starter kit milestone, royalties at 10%", async () => {
    const db = dbConn.db;

    // Create 5 orders of 5 units each = 25 more (total now 50)
    for (let i = 0; i < 5; i++) {
      buyerCounter++;
      const result = await createCompletedOrder(app, address, db, variantId, 5, buyerCounter);
      createdOrderIds.push(result.orderId);

      const salesResult = await processOrderCompletionSales(db, result.orderId);
      expect(salesResult.sales.length).toBe(1);
      // Already above threshold, royalty created for each order
      expect(salesResult.sales[0].royaltyCreated).toBe(true);
    }

    // Verify starter_kit milestone
    const milestones = await listMilestonesByContributor(db, contributorId);
    const milestoneTypes = milestones.map((m) => m.milestoneType);
    expect(milestoneTypes).toContain("royalty_activation");
    expect(milestoneTypes).toContain("starter_kit");

    // Verify design sales count = 50
    const [design] = await db
      .select({ salesCount: contributorDesign.salesCount })
      .from(contributorDesign)
      .where(eq(contributorDesign.id, designId));
    expect(design.salesCount).toBe(50);

    // Total royalties: 5 (from step 4) + 5 (from step 5) = 10 order lines
    // All at 10% rate: 300 * 5 = 1500 per order line
    const royalties = await db
      .select()
      .from(contributorRoyalty)
      .where(
        and(
          eq(contributorRoyalty.contributorId, contributorId),
          eq(contributorRoyalty.status, "accrued"),
        ),
      );
    expect(royalties.length).toBe(10);
    const totalRoyalties = royalties.reduce((sum, r) => sum + r.amountMinor, 0);
    expect(totalRoyalties).toBe(15000); // 10 × 1500
  }, 120_000);

  // -------------------------------------------------------------------------
  // Step 6: Sell 450 more units — crosses 500-unit veteran milestone (20% rate)
  // -------------------------------------------------------------------------

  it("step 6: sell 450 more units — crosses 500-unit veteran milestone, rate switches to 20%", async () => {
    const db = dbConn.db;

    // Use larger batch sizes to reduce order count: 9 orders of 50 units each = 450
    for (let i = 0; i < 9; i++) {
      buyerCounter++;
      const result = await createCompletedOrder(app, address, db, variantId, 50, buyerCounter);
      createdOrderIds.push(result.orderId);

      const salesResult = await processOrderCompletionSales(db, result.orderId);
      expect(salesResult.sales.length).toBe(1);
      expect(salesResult.sales[0].royaltyCreated).toBe(true);
    }

    // Verify veteran milestone
    const milestones = await listMilestonesByContributor(db, contributorId);
    const milestoneTypes = milestones.map((m) => m.milestoneType);
    expect(milestoneTypes).toContain("royalty_activation");
    expect(milestoneTypes).toContain("starter_kit");
    expect(milestoneTypes).toContain("veteran");

    // Verify design sales count = 500
    const [design] = await db
      .select({ salesCount: contributorDesign.salesCount })
      .from(contributorDesign)
      .where(eq(contributorDesign.id, designId));
    expect(design.salesCount).toBe(500);

    // The veteran orders (once past 500 units) should use 20% rate
    // But the rate switch depends on when getRoyaltyRate detects totalSales >= 500
    // which happens per-order via processOrderCompletionSales
    // The 9th order (at cumulative 500) triggers the veteran rate
    const allRoyalties = await db
      .select()
      .from(contributorRoyalty)
      .where(
        and(
          eq(contributorRoyalty.contributorId, contributorId),
          eq(contributorRoyalty.status, "accrued"),
        ),
      );
    // 10 (from steps 3-5) + 9 (step 6) = 19 total order lines with royalties
    expect(allRoyalties.length).toBe(19);
  }, 300_000);

  // -------------------------------------------------------------------------
  // Step 7: Sell 1 more order AFTER veteran threshold — verify 20% rate
  // -------------------------------------------------------------------------

  it("step 7: post-veteran order earns royalty at 20% rate", async () => {
    const db = dbConn.db;

    buyerCounter++;
    const result = await createCompletedOrder(app, address, db, variantId, 1, buyerCounter);
    createdOrderIds.push(result.orderId);

    const salesResult = await processOrderCompletionSales(db, result.orderId);
    expect(salesResult.sales.length).toBe(1);
    expect(salesResult.sales[0].royaltyCreated).toBe(true);
    expect(salesResult.sales[0].newSalesCount).toBe(501);

    // The royalty for this order line should be at 20% rate
    // floor(3000 * 0.20) * 1 = 600
    const [latestOrderLine] = await db
      .select()
      .from(orderLine)
      .where(eq(orderLine.orderId, result.orderId));

    const [latestRoyalty] = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.orderLineId, latestOrderLine.id));

    expect(latestRoyalty).toBeDefined();
    expect(latestRoyalty.amountMinor).toBe(Math.floor(UNIT_PRICE_MINOR * VETERAN_RATE) * 1); // 600
    expect(latestRoyalty.status).toBe("accrued");
  }, 60_000);

  // -------------------------------------------------------------------------
  // Step 8: Verify contributor dashboard totals match ledger sum
  // -------------------------------------------------------------------------

  it("step 8: contributor dashboard totals match royalty ledger sum", async () => {
    const db = dbConn.db;

    const dashboard = await getContributorDashboard(db, contributorId);
    expect(dashboard).not.toBeNull();

    // Verify contributor identity
    expect(dashboard!.contributor.id).toBe(contributorId);
    expect(dashboard!.contributor.githubUsername).toBe(`crflow-user-${run}`);

    // Verify design data
    expect(dashboard!.designs.length).toBe(1);
    expect(dashboard!.designs[0].productId).toBe(productId);
    expect(dashboard!.designs[0].salesCount).toBe(501);

    // Cross-check royalty summary against raw ledger
    const allRoyalties = await db
      .select()
      .from(contributorRoyalty)
      .where(
        and(
          eq(contributorRoyalty.contributorId, contributorId),
          eq(contributorRoyalty.status, "accrued"),
        ),
      );
    const ledgerTotal = allRoyalties.reduce((sum, r) => sum + r.amountMinor, 0);

    expect(dashboard!.royaltySummary.totalMinor).toBe(ledgerTotal);
    expect(dashboard!.royaltySummary.currency).toBe("USD");
    expect(dashboard!.royaltySummary.clawedBackMinor).toBe(0);

    // Verify milestones in dashboard
    expect(dashboard!.milestones.length).toBe(3);
    const milestoneTypes = dashboard!.milestones.map((m) => m.milestoneType);
    expect(milestoneTypes).toContain("royalty_activation");
    expect(milestoneTypes).toContain("starter_kit");
    expect(milestoneTypes).toContain("veteran");
  });

  // -------------------------------------------------------------------------
  // Step 9: Verify public contributor profile is visible
  // -------------------------------------------------------------------------

  it("step 9: public contributor profile is accessible", async () => {
    const res = await fetch(`${address}/api/contributors/public/crflow-user-${run}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      contributor: {
        githubUsername: string;
        profileVisibility: string;
        status: string;
      };
      designs: Array<{ productId: string; salesCount: number }>;
      milestones: Array<{ milestoneType: string }>;
    };
    expect(body.contributor.githubUsername).toBe(`crflow-user-${run}`);
    expect(body.contributor.profileVisibility).toBe("public");
    expect(body.contributor.status).toBe("active");

    // Designs and milestones returned with profile
    expect(body.designs.length).toBe(1);
    expect(body.designs[0].productId).toBe(productId);
    expect(body.milestones.length).toBe(3);
  });
});
