import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import {
  contributor,
  contributorDesign,
  contributorRoyalty,
  contributorMilestone,
  contributorTaxDocument,
  contributorPayout,
} from "./db/schema/contributor.js";
import { product, productVariant } from "./db/schema/catalog.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { customer } from "./db/schema/customer.js";
import {
  createContributor,
  linkContributorDesign,
  processOrderCompletionSales,
  getContributorDashboard,
  createPayout,
  createTaxDocument,
  updateTaxDocumentStatus,
  recordMilestone,
  ROYALTY_ACTIVATION_THRESHOLD,
  ROYALTY_RATE,
} from "./db/queries/contributor.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

// ---------------------------------------------------------------------------
// Auth helpers — sign up, verify email, sign in
// ---------------------------------------------------------------------------

async function signUpUser(address: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${address}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  const body = (await res.json()) as { status: string; user?: { id: string } };
  if (body.status !== "OK" || !body.user) {
    throw new Error(`Signup failed: ${JSON.stringify(body)}`);
  }
  return body.user.id;
}

async function verifyEmail(userId: string): Promise<void> {
  const supertokens = await import("supertokens-node");
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

async function signInAndGetHeaders(
  address: string,
  email: string,
  password: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${address}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  if (res.status !== 200) {
    throw new Error(`Sign-in failed with status ${res.status}`);
  }
  const cookies = res.headers.getSetCookie();
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const accessToken = res.headers.get("st-access-token");
  const antiCsrf = res.headers.get("anti-csrf");
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    cookie: cookieHeader,
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  if (antiCsrf) headers["anti-csrf"] = antiCsrf;
  return headers;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contributor dashboard data (T248)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  const ts = Date.now();
  const unitPrice = 2000; // $20.00

  // Contributor A — the "owner" who will access their dashboard
  const ownerEmail = `dash-owner-${ts}@kanix.dev`;
  const ownerPassword = "OwnerPassword123!";
  let ownerAuthSubject = "";
  let ownerHeaders: Record<string, string>;
  let ownerCustomerId = "";
  let ownerContributorId = "";
  let ownerDesignId = "";
  let ownerProductId = "";
  let ownerVariantId = "";

  // Contributor B — a different contributor for non-owner tests
  const otherEmail = `dash-other-${ts}@kanix.dev`;
  const otherPassword = "OtherPassword123!";
  let otherAuthSubject = "";
  let otherHeaders: Record<string, string>;
  let otherCustomerId = "";
  let otherContributorId = "";
  let otherDesignId = "";
  let otherProductId = "";
  let otherVariantId = "";

  // Non-contributor user
  const nonContribEmail = `dash-noncontrib-${ts}@kanix.dev`;
  const nonContribPassword = "NonContrib123!";
  let nonContribHeaders: Record<string, string>;

  const createdOrderIds: string[] = [];
  const createdOrderLineIds: string[] = [];

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // --- Owner user (Contributor A) ---
    ownerAuthSubject = await signUpUser(address, ownerEmail, ownerPassword);
    await verifyEmail(ownerAuthSubject);
    ownerHeaders = await signInAndGetHeaders(address, ownerEmail, ownerPassword);

    // The signup creates a customer row linked to ownerAuthSubject
    const [ownerCust] = await db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, ownerAuthSubject));
    ownerCustomerId = ownerCust.id;

    // Create product + variant for owner
    const [prod] = await db
      .insert(product)
      .values({
        slug: `dash-owner-prod-${ts}`,
        title: `Dashboard Owner Product ${ts}`,
        status: "active",
      })
      .returning();
    ownerProductId = prod.id;

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: ownerProductId,
        sku: `DASH-OWNER-SKU-${ts}`,
        title: `Dashboard Owner Variant ${ts}`,
        priceMinor: unitPrice,
        status: "active",
      })
      .returning();
    ownerVariantId = variant.id;

    // Create contributor linked to owner customer
    const contrib = await createContributor(db, {
      githubUsername: `dash-owner-${ts}`,
      githubUserId: `gh-dash-owner-${ts}`,
      customerId: ownerCustomerId,
      claAcceptedAt: new Date(),
    });
    ownerContributorId = contrib.id;

    const design = await linkContributorDesign(db, {
      contributorId: ownerContributorId,
      productId: ownerProductId,
    });
    ownerDesignId = design.id;

    // Record accepted_pr milestone
    await recordMilestone(db, ownerContributorId, "accepted_pr", "First PR");

    // Create 30 sales (25 to cross threshold + 5 more) to generate royalties
    const { orderId: order1Id } = await createCompletedOrder(ROYALTY_ACTIVATION_THRESHOLD);
    await processOrderCompletionSales(db, order1Id);

    const { orderId: order2Id } = await createCompletedOrder(5);
    await processOrderCompletionSales(db, order2Id);

    // Upload and approve tax document, create completed payout
    const taxDoc = await createTaxDocument(db, {
      contributorId: ownerContributorId,
      documentType: "w9",
      storageKey: `tax-documents/${ownerContributorId}/test-w9.pdf`,
    });
    await updateTaxDocumentStatus(db, taxDoc.id, "approved");

    const payout = await createPayout(db, {
      contributorId: ownerContributorId,
      amountMinor: 1000,
      payoutMethod: "paypal",
    });
    await db
      .update(contributorPayout)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(contributorPayout.id, payout.id));

    // --- Other user (Contributor B) ---
    otherAuthSubject = await signUpUser(address, otherEmail, otherPassword);
    await verifyEmail(otherAuthSubject);
    otherHeaders = await signInAndGetHeaders(address, otherEmail, otherPassword);

    const [otherCust] = await db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, otherAuthSubject));
    otherCustomerId = otherCust.id;

    const [prod2] = await db
      .insert(product)
      .values({
        slug: `dash-other-prod-${ts}`,
        title: `Dashboard Other Product ${ts}`,
        status: "active",
      })
      .returning();
    otherProductId = prod2.id;

    const [variant2] = await db
      .insert(productVariant)
      .values({
        productId: otherProductId,
        sku: `DASH-OTHER-SKU-${ts}`,
        title: `Dashboard Other Variant ${ts}`,
        priceMinor: unitPrice,
        status: "active",
      })
      .returning();
    otherVariantId = variant2.id;

    const contrib2 = await createContributor(db, {
      githubUsername: `dash-other-${ts}`,
      githubUserId: `gh-dash-other-${ts}`,
      customerId: otherCustomerId,
      claAcceptedAt: new Date(),
    });
    otherContributorId = contrib2.id;

    const design2 = await linkContributorDesign(db, {
      contributorId: otherContributorId,
      productId: otherProductId,
    });
    otherDesignId = design2.id;

    // --- Non-contributor user ---
    const nonContribAuth = await signUpUser(address, nonContribEmail, nonContribPassword);
    await verifyEmail(nonContribAuth);
    nonContribHeaders = await signInAndGetHeaders(address, nonContribEmail, nonContribPassword);
  });

  afterAll(async () => {
    try {
      const db = dbConn.db;

      // Clean contributor B
      await db
        .delete(contributorPayout)
        .where(eq(contributorPayout.contributorId, otherContributorId));
      await db
        .delete(contributorTaxDocument)
        .where(eq(contributorTaxDocument.contributorId, otherContributorId));
      await db
        .delete(contributorMilestone)
        .where(eq(contributorMilestone.contributorId, otherContributorId));
      await db
        .delete(contributorRoyalty)
        .where(eq(contributorRoyalty.contributorId, otherContributorId));
      if (otherDesignId)
        await db.delete(contributorDesign).where(eq(contributorDesign.id, otherDesignId));
      if (otherContributorId)
        await db.delete(contributor).where(eq(contributor.id, otherContributorId));
      if (otherVariantId)
        await db.delete(productVariant).where(eq(productVariant.id, otherVariantId));
      if (otherProductId) await db.delete(product).where(eq(product.id, otherProductId));

      // Clean contributor A
      await db
        .delete(contributorPayout)
        .where(eq(contributorPayout.contributorId, ownerContributorId));
      await db
        .delete(contributorTaxDocument)
        .where(eq(contributorTaxDocument.contributorId, ownerContributorId));
      await db
        .delete(contributorMilestone)
        .where(eq(contributorMilestone.contributorId, ownerContributorId));
      await db
        .delete(contributorRoyalty)
        .where(eq(contributorRoyalty.contributorId, ownerContributorId));

      for (const id of createdOrderLineIds) {
        await db.delete(orderLine).where(eq(orderLine.id, id));
      }
      for (const id of createdOrderIds) {
        await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, id));
        await db.delete(order).where(eq(order.id, id));
      }

      if (ownerDesignId)
        await db.delete(contributorDesign).where(eq(contributorDesign.id, ownerDesignId));
      if (ownerContributorId)
        await db.delete(contributor).where(eq(contributor.id, ownerContributorId));
      if (ownerVariantId)
        await db.delete(productVariant).where(eq(productVariant.id, ownerVariantId));
      if (ownerProductId) await db.delete(product).where(eq(product.id, ownerProductId));
    } catch {
      // Cleanup best-effort
    }
    await stopTestServer(ts_);
  });

  async function createCompletedOrder(quantity: number) {
    const db = dbConn.db;

    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `DASH-TEST-${ts}-${createdOrderIds.length + 1}`,
        email: `test-${ts}@example.com`,
        status: "completed",
        paymentStatus: "paid",
        fulfillmentStatus: "fulfilled",
        shippingStatus: "delivered",
        subtotalMinor: unitPrice * quantity,
        totalMinor: unitPrice * quantity,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(ord.id);

    const [line] = await db
      .insert(orderLine)
      .values({
        orderId: ord.id,
        variantId: ownerVariantId,
        skuSnapshot: `DASH-OWNER-SKU-${ts}`,
        titleSnapshot: `Dashboard Owner Variant ${ts}`,
        quantity,
        unitPriceMinor: unitPrice,
        totalMinor: unitPrice * quantity,
      })
      .returning();
    createdOrderLineIds.push(line.id);

    return { orderId: ord.id, orderLineId: line.id };
  }

  // ---------------------------------------------------------------------------
  // Happy path: owner sees their own dashboard via HTTP
  // ---------------------------------------------------------------------------

  it("GET /api/contributors/dashboard returns correct units-sold, royalties, and milestones", async () => {
    const res = await fetch(`${address}/api/contributors/dashboard`, {
      headers: ownerHeaders,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { dashboard: Record<string, unknown> };
    const dashboard = body.dashboard;

    // Contributor info
    const contribInfo = dashboard.contributor as Record<string, unknown>;
    expect(contribInfo.id).toBe(ownerContributorId);
    expect(contribInfo.githubUsername).toBe(`dash-owner-${ts}`);
    expect(contribInfo.status).toBe("active");

    // Designs — units sold
    const designs = dashboard.designs as Array<Record<string, unknown>>;
    expect(designs).toHaveLength(1);
    expect(designs[0].productId).toBe(ownerProductId);
    expect(designs[0].productTitle).toBe(`Dashboard Owner Product ${ts}`);
    expect(designs[0].salesCount).toBe(30);

    // Royalty summary — exact number assertions
    // 30 units at $20.00, 10% rate = $2.00/unit = 200 minor/unit, total = 6000
    const expectedRoyaltyPerUnit = Math.floor(unitPrice * ROYALTY_RATE); // 200
    const expectedTotal = expectedRoyaltyPerUnit * 30; // 6000
    const royalty = dashboard.royaltySummary as Record<string, unknown>;
    expect(royalty.totalMinor).toBe(expectedTotal);
    expect(royalty.paidMinor).toBe(1000);
    expect(royalty.pendingMinor).toBe(expectedTotal - 1000);
    expect(royalty.clawedBackMinor).toBe(0);
    expect(royalty.currency).toBe("USD");

    // Milestones — accepted_pr (manual) + royalty_activation (auto at 25+)
    const milestones = dashboard.milestones as Array<Record<string, unknown>>;
    expect(milestones.length).toBe(2);
    const milestoneTypes = milestones.map((m) => m.milestoneType);
    expect(milestoneTypes).toContain("accepted_pr");
    expect(milestoneTypes).toContain("royalty_activation");
    // Each milestone has a reachedAt timestamp
    for (const m of milestones) {
      expect(typeof m.reachedAt).toBe("string");
      expect(new Date(m.reachedAt as string).getTime()).not.toBeNaN();
    }

    // Payouts
    const payouts = dashboard.payouts as Array<Record<string, unknown>>;
    expect(payouts).toHaveLength(1);
    expect(payouts[0].amountMinor).toBe(1000);
    expect(payouts[0].status).toBe("completed");
    expect(payouts[0].currency).toBe("USD");
    expect(payouts[0].payoutMethod).toBe("paypal");
  });

  // ---------------------------------------------------------------------------
  // Non-owner cannot see another contributor's dashboard
  // ---------------------------------------------------------------------------

  it("Contributor B sees only their own (empty) dashboard, not Contributor A's", async () => {
    const res = await fetch(`${address}/api/contributors/dashboard`, {
      headers: otherHeaders,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { dashboard: Record<string, unknown> };
    const dashboard = body.dashboard;

    const contribInfo = dashboard.contributor as Record<string, unknown>;
    expect(contribInfo.id).toBe(otherContributorId);
    expect(contribInfo.id).not.toBe(ownerContributorId);
    expect(contribInfo.githubUsername).toBe(`dash-other-${ts}`);

    // Other contributor has 0 sales, 0 royalties
    const designs = dashboard.designs as Array<Record<string, unknown>>;
    expect(designs).toHaveLength(1);
    expect(designs[0].salesCount).toBe(0);

    const royalty = dashboard.royaltySummary as Record<string, unknown>;
    expect(royalty.totalMinor).toBe(0);
    expect(royalty.paidMinor).toBe(0);
    expect(royalty.pendingMinor).toBe(0);
    expect(royalty.clawedBackMinor).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Non-contributor user gets 404
  // ---------------------------------------------------------------------------

  it("non-contributor user gets 404 on dashboard", async () => {
    const res = await fetch(`${address}/api/contributors/dashboard`, {
      headers: nonContribHeaders,
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_NOT_FOUND");
    expect(body.message).toMatch(/contributor/i);
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated request gets 401
  // ---------------------------------------------------------------------------

  it("unauthenticated request returns 401", async () => {
    const res = await fetch(`${address}/api/contributors/dashboard`, {
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Date range filter
  // ---------------------------------------------------------------------------

  it("date range filter scopes royalty aggregation", async () => {
    // All royalties were created "now". A far-future range should include everything.
    const farPast = "2020-01-01T00:00:00Z";
    const farFuture = "2099-12-31T23:59:59Z";

    const resAll = await fetch(
      `${address}/api/contributors/dashboard?from=${farPast}&to=${farFuture}`,
      { headers: ownerHeaders },
    );
    expect(resAll.status).toBe(200);
    const bodyAll = (await resAll.json()) as { dashboard: Record<string, unknown> };
    const royaltyAll = bodyAll.dashboard.royaltySummary as Record<string, unknown>;
    const expectedTotal = Math.floor(unitPrice * ROYALTY_RATE) * 30; // 6000
    expect(royaltyAll.totalMinor).toBe(expectedTotal);

    // A range in the past (before any data was created) should yield 0 royalties
    const resPast = await fetch(
      `${address}/api/contributors/dashboard?from=2020-01-01T00:00:00Z&to=2020-12-31T23:59:59Z`,
      { headers: ownerHeaders },
    );
    expect(resPast.status).toBe(200);
    const bodyPast = (await resPast.json()) as { dashboard: Record<string, unknown> };
    const royaltyPast = bodyPast.dashboard.royaltySummary as Record<string, unknown>;
    expect(royaltyPast.totalMinor).toBe(0);

    // Designs / milestones / payouts are unaffected by date range
    const designsPast = bodyPast.dashboard.designs as Array<Record<string, unknown>>;
    expect(designsPast).toHaveLength(1);
    expect(designsPast[0].salesCount).toBe(30); // salesCount is lifetime, not date-filtered
    const milestonesPast = bodyPast.dashboard.milestones as Array<Record<string, unknown>>;
    expect(milestonesPast.length).toBe(2);
  });

  it("invalid date in query param returns 400", async () => {
    const res = await fetch(`${address}/api/contributors/dashboard?from=not-a-date`, {
      headers: ownerHeaders,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_INVALID_DATE");
  });

  // ---------------------------------------------------------------------------
  // Timezone handling — ISO 8601 with timezone offset
  // ---------------------------------------------------------------------------

  it("accepts ISO 8601 dates with timezone offsets", async () => {
    // Use a timezone offset that still includes "now" — e.g. far past to far future
    const res = await fetch(
      `${address}/api/contributors/dashboard?from=2020-01-01T00:00:00%2B05:00&to=2099-12-31T23:59:59-08:00`,
      { headers: ownerHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dashboard: Record<string, unknown> };
    const royalty = body.dashboard.royaltySummary as Record<string, unknown>;
    const expectedTotal = Math.floor(unitPrice * ROYALTY_RATE) * 30;
    expect(royalty.totalMinor).toBe(expectedTotal);
  });

  it("timestamps in response are ISO 8601 with timezone info", async () => {
    const res = await fetch(`${address}/api/contributors/dashboard`, {
      headers: ownerHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dashboard: Record<string, unknown> };
    const milestones = body.dashboard.milestones as Array<Record<string, unknown>>;
    expect(milestones.length).toBeGreaterThan(0);
    // Verify timestamps are valid ISO date strings
    for (const m of milestones) {
      const dateStr = m.reachedAt as string;
      expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      const parsed = new Date(dateStr);
      expect(parsed.getTime()).not.toBeNaN();
      // Ensure the timestamp preserves timezone awareness (not stripped to local)
      expect(dateStr).toMatch(/Z$|[+-]\d{2}:\d{2}$/);
    }

    const payouts = body.dashboard.payouts as Array<Record<string, unknown>>;
    expect(payouts.length).toBeGreaterThan(0);
    for (const p of payouts) {
      const dateStr = p.initiatedAt as string;
      expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(dateStr).getTime()).not.toBeNaN();
    }
  });

  // ---------------------------------------------------------------------------
  // DB-level dashboard query (direct, no HTTP)
  // ---------------------------------------------------------------------------

  it("getContributorDashboard returns null for non-existent contributor", async () => {
    const db = dbConn.db;
    const dashboard = await getContributorDashboard(db, "00000000-0000-0000-0000-000000000000");
    expect(dashboard).toBeNull();
  });

  it("getContributorDashboard with date filter returns filtered royalties", async () => {
    const db = dbConn.db;

    // All royalties are recent — future-only range should include them
    const dashboard = await getContributorDashboard(db, ownerContributorId, {
      from: new Date("2020-01-01"),
      to: new Date("2099-12-31"),
    });
    expect(dashboard).not.toBeNull();
    const expectedTotal = Math.floor(unitPrice * ROYALTY_RATE) * 30;
    expect(dashboard!.royaltySummary.totalMinor).toBe(expectedTotal);

    // Past-only range should yield 0
    const dashboardPast = await getContributorDashboard(db, ownerContributorId, {
      from: new Date("2020-01-01"),
      to: new Date("2020-12-31"),
    });
    expect(dashboardPast).not.toBeNull();
    expect(dashboardPast!.royaltySummary.totalMinor).toBe(0);
    // But contributor info / designs / milestones still present
    expect(dashboardPast!.contributor.id).toBe(ownerContributorId);
    expect(dashboardPast!.designs).toHaveLength(1);
    expect(dashboardPast!.milestones.length).toBe(2);
  });
});
