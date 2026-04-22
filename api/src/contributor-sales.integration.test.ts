import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { eq } from "drizzle-orm";
import { contributor, contributorDesign, contributorRoyalty, contributorMilestone } from "./db/schema/contributor.js";
import { product, productVariant } from "./db/schema/catalog.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { requireDatabaseUrl } from "./test-helpers.js";
import {
  createContributor,
  linkContributorDesign,
  getDesignSalesCount,
  processOrderCompletionSales,
} from "./db/queries/contributor.js";

const DATABASE_URL = requireDatabaseUrl();

describe("per-design sales tracking (T068)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now();
  let productId = "";
  let variantId = "";
  let contributorId = "";
  let designId = "";

  // Track IDs for cleanup
  const createdOrderIds: string[] = [];
  const createdOrderLineIds: string[] = [];
  const createdRoyaltyIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create test product
    const [prod] = await db
      .insert(product)
      .values({
        slug: `sales-track-prod-${ts}`,
        title: `Sales Track Product ${ts}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    // Create test variant
    const [variant] = await db
      .insert(productVariant)
      .values({
        productId,
        sku: `SALES-TRACK-SKU-${ts}`,
        title: `Sales Track Variant ${ts}`,
        priceMinor: 2500, // $25.00
        status: "active",
      })
      .returning();
    variantId = variant.id;

    // Create contributor
    const contrib = await createContributor(db, {
      githubUsername: `sales-tracker-${ts}`,
      githubUserId: `gh-sales-${ts}`,
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
      for (const id of createdRoyaltyIds) {
        await db.delete(contributorRoyalty).where(eq(contributorRoyalty.id, id));
      }
      // Delete royalties by contributor (catch any we missed)
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

      // Delete milestones, design, contributor, variant, product
      await db.delete(contributorMilestone).where(eq(contributorMilestone.contributorId, contributorId));
      await db.delete(contributorDesign).where(eq(contributorDesign.id, designId));
      await db.delete(contributor).where(eq(contributor.id, contributorId));
      await db.delete(productVariant).where(eq(productVariant.id, variantId));
      await db.delete(product).where(eq(product.id, productId));

      await dbConn.close();
    }
  });

  /**
   * Helper to create a completed order with a given quantity of the test variant.
   */
  async function createCompletedOrder(quantity: number) {
    const db = dbConn.db;
    const unitPrice = 2500;

    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `SALES-TEST-${ts}-${createdOrderIds.length + 1}`,
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
        skuSnapshot: `SALES-TRACK-SKU-${ts}`,
        titleSnapshot: `Sales Track Variant ${ts}`,
        quantity,
        unitPriceMinor: unitPrice,
        totalMinor: unitPrice * quantity,
      })
      .returning();
    createdOrderLineIds.push(line.id);

    return { orderId: ord.id, orderLineId: line.id };
  }

  it("increments sales count on order completion", async () => {
    const db = dbConn.db;

    // Initial sales count should be 0
    const initialCount = await getDesignSalesCount(db, designId);
    expect(initialCount).toBe(0);

    // Complete an order with quantity 3
    const { orderId } = await createCompletedOrder(3);

    // Process sales tracking
    const { sales: results } = await processOrderCompletionSales(db, orderId);

    expect(results.length).toBe(1);
    expect(results[0].designId).toBe(designId);
    expect(results[0].contributorId).toBe(contributorId);
    expect(results[0].previousSalesCount).toBe(0);
    expect(results[0].newSalesCount).toBe(3);
    expect(results[0].royaltyCreated).toBe(false); // Below 25 threshold

    // Verify sales count persisted
    const updatedCount = await getDesignSalesCount(db, designId);
    expect(updatedCount).toBe(3);
  });

  it("accumulates sales count across multiple orders", async () => {
    const db = dbConn.db;

    // Create another order with quantity 5
    const { orderId } = await createCompletedOrder(5);
    const { sales: results } = await processOrderCompletionSales(db, orderId);

    expect(results.length).toBe(1);
    expect(results[0].previousSalesCount).toBe(3);
    expect(results[0].newSalesCount).toBe(8);
    expect(results[0].royaltyCreated).toBe(false);

    const count = await getDesignSalesCount(db, designId);
    expect(count).toBe(8);
  });

  it("creates royalty entry when crossing 25-unit threshold", async () => {
    const db = dbConn.db;

    // Current count is 8, add 20 to cross threshold (8 + 20 = 28)
    const { orderId, orderLineId } = await createCompletedOrder(20);
    const { sales: results } = await processOrderCompletionSales(db, orderId);

    expect(results.length).toBe(1);
    expect(results[0].previousSalesCount).toBe(8);
    expect(results[0].newSalesCount).toBe(28);
    expect(results[0].royaltyCreated).toBe(true);

    // Verify royalty entry was created
    const royalties = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.orderLineId, orderLineId));

    expect(royalties.length).toBe(1);
    expect(royalties[0].contributorId).toBe(contributorId);
    expect(royalties[0].status).toBe("accrued");
    // 10% of $25.00 (2500 minor) * 20 quantity = 5000
    expect(royalties[0].amountMinor).toBe(5000);

    createdRoyaltyIds.push(royalties[0].id);
  });

  it("creates royalty for subsequent orders after threshold", async () => {
    const db = dbConn.db;

    // Already at 28 (above threshold), next order should also create royalty
    const { orderId, orderLineId } = await createCompletedOrder(2);
    const { sales: results } = await processOrderCompletionSales(db, orderId);

    expect(results.length).toBe(1);
    expect(results[0].newSalesCount).toBe(30);
    expect(results[0].royaltyCreated).toBe(true);

    const royalties = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.orderLineId, orderLineId));

    expect(royalties.length).toBe(1);
    // 10% of $25.00 * 2 = 500
    expect(royalties[0].amountMinor).toBe(500);

    createdRoyaltyIds.push(royalties[0].id);
  });

  it("skips products without contributor designs", async () => {
    const db = dbConn.db;

    // Create a separate product with no contributor design
    const [unlinkedProd] = await db
      .insert(product)
      .values({
        slug: `unlinked-prod-${ts}`,
        title: `Unlinked Product ${ts}`,
        status: "active",
      })
      .returning();

    const [unlinkedVariant] = await db
      .insert(productVariant)
      .values({
        productId: unlinkedProd.id,
        sku: `UNLINKED-SKU-${ts}`,
        title: `Unlinked Variant ${ts}`,
        priceMinor: 1000,
        status: "active",
      })
      .returning();

    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `UNLINKED-TEST-${ts}`,
        email: `test-${ts}@example.com`,
        status: "completed",
        paymentStatus: "paid",
        fulfillmentStatus: "fulfilled",
        shippingStatus: "delivered",
        subtotalMinor: 1000,
        totalMinor: 1000,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(ord.id);

    const [line] = await db
      .insert(orderLine)
      .values({
        orderId: ord.id,
        variantId: unlinkedVariant.id,
        skuSnapshot: `UNLINKED-SKU-${ts}`,
        titleSnapshot: `Unlinked Variant ${ts}`,
        quantity: 5,
        unitPriceMinor: 1000,
        totalMinor: 5000,
      })
      .returning();
    createdOrderLineIds.push(line.id);

    const { sales: results } = await processOrderCompletionSales(db, ord.id);
    expect(results.length).toBe(0);

    // Cleanup extra order line, variant, and product (order line references variant)
    await db.delete(orderLine).where(eq(orderLine.id, line.id));
    await db.delete(productVariant).where(eq(productVariant.id, unlinkedVariant.id));
    await db.delete(product).where(eq(product.id, unlinkedProd.id));
  });

  it("handles order with no order lines", async () => {
    const db = dbConn.db;

    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `EMPTY-ORDER-${ts}`,
        email: `test-${ts}@example.com`,
        status: "completed",
        paymentStatus: "paid",
        fulfillmentStatus: "fulfilled",
        shippingStatus: "delivered",
        subtotalMinor: 0,
        totalMinor: 0,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(ord.id);

    const { sales: results } = await processOrderCompletionSales(db, ord.id);
    expect(results.length).toBe(0);
  });
});
