import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { eq } from "drizzle-orm";
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
  findContributorByCustomerId,
  getContributorDashboard,
  listPayoutsByContributor,
  createPayout,
  createTaxDocument,
  updateTaxDocumentStatus,
  recordMilestone,
  ROYALTY_ACTIVATION_THRESHOLD,
} from "./db/queries/contributor.js";

const DATABASE_URL = process.env["DATABASE_URL"];

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("contributor dashboard API (T071)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now();
  let productId = "";
  let variantId = "";
  let contributorId = "";
  let designId = "";
  let customerId = "";

  const createdOrderIds: string[] = [];
  const createdOrderLineIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

    // Create test customer
    const [cust] = await db
      .insert(customer)
      .values({
        email: `dashboard-test-${ts}@example.com`,
        firstName: `DashTest`,
        authSubject: `auth-dashboard-${ts}`,
      })
      .returning();
    customerId = cust.id;

    // Create test product
    const [prod] = await db
      .insert(product)
      .values({
        slug: `dashboard-prod-${ts}`,
        title: `Dashboard Product ${ts}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    // Create test variant
    const [variant] = await db
      .insert(productVariant)
      .values({
        productId,
        sku: `DASH-SKU-${ts}`,
        title: `Dashboard Variant ${ts}`,
        priceMinor: 2000, // $20.00
        status: "active",
      })
      .returning();
    variantId = variant.id;

    // Create contributor linked to customer
    const contrib = await createContributor(db, {
      githubUsername: `dashboard-user-${ts}`,
      githubUserId: `gh-dashboard-${ts}`,
      customerId,
      claAcceptedAt: new Date(),
    });
    contributorId = contrib.id;

    // Link contributor to product
    const design = await linkContributorDesign(db, {
      contributorId: contrib.id,
      productId,
    });
    designId = design.id;
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;

      // Clean up in dependency order
      await db.delete(contributorPayout).where(eq(contributorPayout.contributorId, contributorId));
      await db
        .delete(contributorTaxDocument)
        .where(eq(contributorTaxDocument.contributorId, contributorId));
      await db
        .delete(contributorMilestone)
        .where(eq(contributorMilestone.contributorId, contributorId));
      await db
        .delete(contributorRoyalty)
        .where(eq(contributorRoyalty.contributorId, contributorId));

      for (const id of createdOrderLineIds) {
        await db.delete(orderLine).where(eq(orderLine.id, id));
      }
      for (const id of createdOrderIds) {
        await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, id));
        await db.delete(order).where(eq(order.id, id));
      }

      await db.delete(contributorDesign).where(eq(contributorDesign.id, designId));
      await db.delete(contributor).where(eq(contributor.id, contributorId));
      await db.delete(productVariant).where(eq(productVariant.id, variantId));
      await db.delete(product).where(eq(product.id, productId));
      await db.delete(customer).where(eq(customer.id, customerId));

      await dbConn.close();
    }
  });

  async function createCompletedOrder(quantity: number) {
    const db = dbConn.db;
    const unitPrice = 2000;

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
        variantId,
        skuSnapshot: `DASH-SKU-${ts}`,
        titleSnapshot: `Dashboard Variant ${ts}`,
        quantity,
        unitPriceMinor: unitPrice,
        totalMinor: unitPrice * quantity,
      })
      .returning();
    createdOrderLineIds.push(line.id);

    return { orderId: ord.id, orderLineId: line.id };
  }

  // ---------------------------------------------------------------------------
  // findContributorByCustomerId
  // ---------------------------------------------------------------------------

  it("finds contributor by customer ID", async () => {
    const db = dbConn.db;
    const found = await findContributorByCustomerId(db, customerId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(contributorId);
    expect(found?.githubUsername).toBe(`dashboard-user-${ts}`);
  });

  it("returns null for unknown customer ID", async () => {
    const db = dbConn.db;
    const found = await findContributorByCustomerId(db, "00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // listPayoutsByContributor
  // ---------------------------------------------------------------------------

  it("lists payouts (initially empty)", async () => {
    const db = dbConn.db;
    const payouts = await listPayoutsByContributor(db, contributorId);
    expect(payouts).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Dashboard with 30 sales
  // ---------------------------------------------------------------------------

  it("dashboard shows correct totals for contributor with 30 sales", async () => {
    const db = dbConn.db;

    // Record accepted_pr milestone manually
    await recordMilestone(db, contributorId, "accepted_pr", "First PR");

    // Create 30 sales across multiple orders (25 to cross threshold + 5 more)
    const { orderId: order1Id } = await createCompletedOrder(ROYALTY_ACTIVATION_THRESHOLD);
    await processOrderCompletionSales(db, order1Id);

    const { orderId: order2Id } = await createCompletedOrder(5);
    await processOrderCompletionSales(db, order2Id);

    // Upload and approve tax document so we can create a payout
    const taxDoc = await createTaxDocument(db, {
      contributorId,
      documentType: "w9",
      storageKey: `tax-documents/${contributorId}/test-w9.pdf`,
    });
    await updateTaxDocumentStatus(db, taxDoc.id, "approved");

    // Create a completed payout for part of the royalties
    const payout = await createPayout(db, {
      contributorId,
      amountMinor: 1000, // $10 paid out
      payoutMethod: "paypal",
    });
    // Simulate payout completion
    await db
      .update(contributorPayout)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(contributorPayout.id, payout.id));

    // Now get the dashboard
    const dashboard = await getContributorDashboard(db, contributorId);
    expect(dashboard).not.toBeNull();

    // Contributor info
    expect(dashboard?.contributor.id).toBe(contributorId);
    expect(dashboard?.contributor.githubUsername).toBe(`dashboard-user-${ts}`);

    // Designs
    expect(dashboard?.designs).toHaveLength(1);
    expect(dashboard?.designs[0].productId).toBe(productId);
    expect(dashboard?.designs[0].productTitle).toBe(`Dashboard Product ${ts}`);
    expect(dashboard?.designs[0].salesCount).toBe(30);

    // Royalty summary
    // 30 orders at $20.00, 10% rate = $2.00 per unit = 200 minor per unit
    // Total: 30 * 200 = 6000
    const expectedRoyaltyPerUnit = Math.floor(2000 * 0.1); // 200
    const expectedTotal = expectedRoyaltyPerUnit * 30; // 6000
    expect(dashboard?.royaltySummary.totalMinor).toBe(expectedTotal);
    expect(dashboard?.royaltySummary.paidMinor).toBe(1000);
    expect(dashboard?.royaltySummary.pendingMinor).toBe(expectedTotal - 1000);
    expect(dashboard?.royaltySummary.clawedBackMinor).toBe(0);
    expect(dashboard?.royaltySummary.currency).toBe("USD");

    // Milestones — should have accepted_pr, royalty_activation (25+), and starter_kit (50+? no, only 30)
    expect(dashboard?.milestones.length).toBeGreaterThanOrEqual(2);
    const milestoneTypes = dashboard?.milestones.map((m) => m.milestoneType);
    expect(milestoneTypes).toContain("accepted_pr");
    expect(milestoneTypes).toContain("royalty_activation");

    // Payouts
    expect(dashboard?.payouts).toHaveLength(1);
    expect(dashboard?.payouts[0].amountMinor).toBe(1000);
    expect(dashboard?.payouts[0].status).toBe("completed");
  });

  it("dashboard returns null for non-existent contributor", async () => {
    const db = dbConn.db;
    const dashboard = await getContributorDashboard(db, "00000000-0000-0000-0000-000000000000");
    expect(dashboard).toBeNull();
  });
});
