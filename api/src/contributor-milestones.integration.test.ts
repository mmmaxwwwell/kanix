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
import {
  createContributor,
  linkContributorDesign,
  processOrderCompletionSales,
  recordMilestone,
  listMilestonesByContributor,
  createTaxDocument,
  findTaxDocumentById,
  listTaxDocumentsByContributor,
  updateTaxDocumentStatus,
  hasApprovedTaxDocument,
  createPayout,
  ROYALTY_ACTIVATION_THRESHOLD,
  STARTER_KIT_THRESHOLD,
} from "./db/queries/contributor.js";

const DATABASE_URL = process.env["DATABASE_URL"];

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("milestone tracking + tax documents (T070)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now();
  let productId = "";
  let variantId = "";
  let contributorId = "";
  let designId = "";

  // Track IDs for cleanup
  const createdOrderIds: string[] = [];
  const createdOrderLineIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

    // Create test product
    const [prod] = await db
      .insert(product)
      .values({
        slug: `milestone-prod-${ts}`,
        title: `Milestone Product ${ts}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    // Create test variant
    const [variant] = await db
      .insert(productVariant)
      .values({
        productId,
        sku: `MILESTONE-SKU-${ts}`,
        title: `Milestone Variant ${ts}`,
        priceMinor: 2000, // $20.00
        status: "active",
      })
      .returning();
    variantId = variant.id;

    // Create contributor
    const contrib = await createContributor(db, {
      githubUsername: `milestone-user-${ts}`,
      githubUserId: `gh-milestone-${ts}`,
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

      await dbConn.close();
    }
  });

  async function createCompletedOrder(quantity: number) {
    const db = dbConn.db;
    const unitPrice = 2000;

    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `MILE-TEST-${ts}-${createdOrderIds.length + 1}`,
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
        skuSnapshot: `MILESTONE-SKU-${ts}`,
        titleSnapshot: `Milestone Variant ${ts}`,
        quantity,
        unitPriceMinor: unitPrice,
        totalMinor: unitPrice * quantity,
      })
      .returning();
    createdOrderLineIds.push(line.id);

    return { orderId: ord.id, orderLineId: line.id };
  }

  // ---------------------------------------------------------------------------
  // Milestone progression tests
  // ---------------------------------------------------------------------------

  it("manually records accepted_pr milestone", async () => {
    const db = dbConn.db;
    const milestone = await recordMilestone(db, contributorId, "accepted_pr", "First merged PR");
    expect(milestone.milestoneType).toBe("accepted_pr");
    expect(milestone.notes).toBe("First merged PR");
    expect(milestone.reachedAt).toBeInstanceOf(Date);
  });

  it("recordMilestone is idempotent", async () => {
    const db = dbConn.db;
    const first = await recordMilestone(db, contributorId, "accepted_pr");
    const second = await recordMilestone(db, contributorId, "accepted_pr");
    expect(first.id).toBe(second.id);
  });

  it("lists milestones by contributor", async () => {
    const db = dbConn.db;
    const milestones = await listMilestonesByContributor(db, contributorId);
    expect(milestones.length).toBeGreaterThanOrEqual(1);
    expect(milestones.some((m) => m.milestoneType === "accepted_pr")).toBe(true);
  });

  it("auto-detects royalty_activation milestone at 25 units", async () => {
    const db = dbConn.db;

    // Create order with 25 units to cross the threshold
    const { orderId } = await createCompletedOrder(ROYALTY_ACTIVATION_THRESHOLD);
    await processOrderCompletionSales(db, orderId);

    // Check milestones
    const milestones = await listMilestonesByContributor(db, contributorId);
    expect(milestones.some((m) => m.milestoneType === "royalty_activation")).toBe(true);
  });

  it("auto-detects starter_kit milestone at 50 units", async () => {
    const db = dbConn.db;

    // Add 25 more units to reach 50 total
    const { orderId } = await createCompletedOrder(
      STARTER_KIT_THRESHOLD - ROYALTY_ACTIVATION_THRESHOLD,
    );
    await processOrderCompletionSales(db, orderId);

    const milestones = await listMilestonesByContributor(db, contributorId);
    expect(milestones.some((m) => m.milestoneType === "starter_kit")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Tax document tests
  // ---------------------------------------------------------------------------

  it("creates a tax document with pending_review status", async () => {
    const db = dbConn.db;
    const doc = await createTaxDocument(db, {
      contributorId,
      documentType: "w9",
      storageKey: `tax-documents/${contributorId}/test-w9.pdf`,
    });

    expect(doc.status).toBe("pending_review");
    expect(doc.documentType).toBe("w9");
    expect(doc.contributorId).toBe(contributorId);
  });

  it("lists tax documents by contributor", async () => {
    const db = dbConn.db;
    const docs = await listTaxDocumentsByContributor(db, contributorId);
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs[0].documentType).toBe("w9");
  });

  it("finds tax document by ID", async () => {
    const db = dbConn.db;
    const docs = await listTaxDocumentsByContributor(db, contributorId);
    const found = await findTaxDocumentById(db, docs[0].id);
    expect(found).toBeTruthy();
    expect(found?.id).toBe(docs[0].id);
  });

  it("hasApprovedTaxDocument returns false before approval", async () => {
    const db = dbConn.db;
    const result = await hasApprovedTaxDocument(db, contributorId);
    expect(result).toBe(false);
  });

  it("approves a tax document via admin review", async () => {
    const db = dbConn.db;
    const docs = await listTaxDocumentsByContributor(db, contributorId);
    const updated = await updateTaxDocumentStatus(db, docs[0].id, "approved");
    expect(updated).toBeTruthy();
    expect(updated?.status).toBe("approved");
  });

  it("hasApprovedTaxDocument returns true after approval", async () => {
    const db = dbConn.db;
    const result = await hasApprovedTaxDocument(db, contributorId);
    expect(result).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Payout blocking tests
  // ---------------------------------------------------------------------------

  it("blocks payout without approved tax document", async () => {
    const db = dbConn.db;

    // Create a second contributor without a tax document
    const contrib2 = await createContributor(db, {
      githubUsername: `no-tax-${ts}`,
      githubUserId: `gh-no-tax-${ts}`,
      claAcceptedAt: new Date(),
    });

    try {
      await expect(
        createPayout(db, {
          contributorId: contrib2.id,
          amountMinor: 5000,
          payoutMethod: "stripe_transfer",
        }),
      ).rejects.toThrow("Payout blocked: contributor has no approved tax document");
    } finally {
      // Cleanup this contributor
      await db.delete(contributor).where(eq(contributor.id, contrib2.id));
    }
  });

  it("allows payout with approved tax document", async () => {
    const db = dbConn.db;

    const payout = await createPayout(db, {
      contributorId,
      amountMinor: 5000,
      payoutMethod: "stripe_transfer",
    });

    expect(payout.status).toBe("pending");
    expect(payout.amountMinor).toBe(5000);
    expect(payout.payoutMethod).toBe("stripe_transfer");
  });
});
