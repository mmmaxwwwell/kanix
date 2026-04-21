import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { eq } from "drizzle-orm";
import {
  contributor,
  contributorDesign,
  contributorRoyalty,
  contributorDonation,
} from "./db/schema/contributor.js";
import { product, productVariant } from "./db/schema/catalog.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { requireDatabaseUrl } from "./test-helpers.js";
import {
  createContributor,
  linkContributorDesign,
  processOrderCompletionSales,
  clawbackRoyaltyByOrderLine,
  clawbackRoyaltiesByOrderId,
  setContributorDonation,
  ROYALTY_RATE,
  DONATION_RATE,
} from "./db/queries/contributor.js";

const DATABASE_URL = requireDatabaseUrl();

describe("royalty calculation engine (T069)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now();
  const unitPrice = 2500; // $25.00

  // Shared test data IDs
  let productId = "";
  let variantId = "";
  let contributorId = "";
  let designId = "";

  // Track IDs for cleanup
  const createdOrderIds: string[] = [];
  const createdOrderLineIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create test product
    const [prod] = await db
      .insert(product)
      .values({
        slug: `royalty-engine-prod-${ts}`,
        title: `Royalty Engine Product ${ts}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    // Create test variant
    const [variant] = await db
      .insert(productVariant)
      .values({
        productId,
        sku: `ROYALTY-ENGINE-SKU-${ts}`,
        title: `Royalty Engine Variant ${ts}`,
        priceMinor: unitPrice,
        status: "active",
      })
      .returning();
    variantId = variant.id;

    // Create contributor
    const contrib = await createContributor(db, {
      githubUsername: `royalty-engine-${ts}`,
      githubUserId: `gh-royalty-${ts}`,
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
      await db
        .delete(contributorDonation)
        .where(eq(contributorDonation.contributorId, contributorId));
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

  /**
   * Helper to create a completed order with a given quantity.
   */
  async function createCompletedOrder(quantity: number) {
    const db = dbConn.db;
    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `ROYALTY-TEST-${ts}-${createdOrderIds.length + 1}`,
        email: `test-royalty-${ts}@example.com`,
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
        skuSnapshot: `ROYALTY-ENGINE-SKU-${ts}`,
        titleSnapshot: `Royalty Engine Variant ${ts}`,
        quantity,
        unitPriceMinor: unitPrice,
        totalMinor: unitPrice * quantity,
      })
      .returning();
    createdOrderLineIds.push(line.id);

    return { orderId: ord.id, orderLineId: line.id };
  }

  it("25th sale triggers retroactive royalty for units 1-25", async () => {
    const db = dbConn.db;
    const expectedRate = ROYALTY_RATE;
    const royaltyPerUnit = Math.floor(unitPrice * expectedRate); // 250

    // Create 5 orders of 5 units each (total 25) — threshold crossed on last one
    // Orders 1-4: 20 units below threshold (no royalties yet)
    for (let i = 0; i < 4; i++) {
      const { orderId } = await createCompletedOrder(5);
      const results = await processOrderCompletionSales(db, orderId);
      expect(results.length).toBe(1);
      expect(results[0].royaltyCreated).toBe(false);
    }

    // Verify no royalties exist yet
    const royaltiesBefore = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.contributorId, contributorId));
    expect(royaltiesBefore.length).toBe(0);

    // Order 5: 5 more units — crosses 25-unit threshold
    const { orderId: crossingOrderId, orderLineId: crossingLineId } = await createCompletedOrder(5);
    const results = await processOrderCompletionSales(db, crossingOrderId);

    expect(results.length).toBe(1);
    expect(results[0].previousSalesCount).toBe(20);
    expect(results[0].newSalesCount).toBe(25);
    expect(results[0].royaltyCreated).toBe(true);

    // Verify retroactive royalties were created for ALL order lines (1-5)
    const royaltiesAfter = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.contributorId, contributorId));

    // 5 orders × 1 order line each = 5 royalty entries (4 retroactive + 1 current)
    expect(royaltiesAfter.length).toBe(5);

    // All should be accrued and at 10% rate
    for (const r of royaltiesAfter) {
      expect(r.status).toBe("accrued");
      // Each order line has quantity 5, so royalty = 250 * 5 = 1250
      expect(r.amountMinor).toBe(royaltyPerUnit * 5);
    }

    // Verify the crossing order line has a royalty
    const crossingRoyalty = royaltiesAfter.find((r) => r.orderLineId === crossingLineId);
    expect(crossingRoyalty).toBeDefined();
  });

  it("26th sale creates single royalty entry", async () => {
    const db = dbConn.db;
    const expectedRate = ROYALTY_RATE;

    // Already at 25 units. Add 1 more unit.
    const { orderId, orderLineId } = await createCompletedOrder(1);
    const results = await processOrderCompletionSales(db, orderId);

    expect(results.length).toBe(1);
    expect(results[0].previousSalesCount).toBe(25);
    expect(results[0].newSalesCount).toBe(26);
    expect(results[0].royaltyCreated).toBe(true);

    // Verify only ONE new royalty was created (not retroactive batch)
    const royalty = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.orderLineId, orderLineId));

    expect(royalty.length).toBe(1);
    expect(royalty[0].amountMinor).toBe(Math.floor(unitPrice * expectedRate) * 1);
    expect(royalty[0].status).toBe("accrued");

    // Total royalties should now be 6 (5 from retroactive + 1 new)
    const allRoyalties = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.contributorId, contributorId));
    expect(allRoyalties.length).toBe(6);
  });

  it("refund clawback sets royalty status to clawed_back", async () => {
    const db = dbConn.db;

    // Get the latest order line that has a royalty
    const lastOrderLineId = createdOrderLineIds[createdOrderLineIds.length - 1];

    // Clawback by order line
    const result = await clawbackRoyaltyByOrderLine(db, lastOrderLineId);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("clawed_back");

    // Verify the royalty is now clawed_back in the DB
    const [royalty] = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.orderLineId, lastOrderLineId));
    expect(royalty.status).toBe("clawed_back");
  });

  it("clawback by order ID marks all royalties for that order", async () => {
    const db = dbConn.db;

    // Use the first order (which has a retroactive royalty)
    const firstOrderId = createdOrderIds[0];
    const result = await clawbackRoyaltiesByOrderId(db, firstOrderId);
    expect(result.clawedBack).toBe(1);

    // Verify the royalty for the first order line is clawed_back
    const firstLineId = createdOrderLineIds[0];
    const [royalty] = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.orderLineId, firstLineId));
    expect(royalty.status).toBe("clawed_back");
  });

  it("clawback returns null for order line with no royalty", async () => {
    const db = dbConn.db;
    const result = await clawbackRoyaltyByOrderLine(db, "00000000-0000-0000-0000-000000000099");
    expect(result).toBeNull();
  });
});

describe("royalty calculation engine — donation at 20% (T069)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now() + 1; // offset to avoid collisions
  const unitPrice = 3000; // $30.00

  let productId = "";
  let variantId = "";
  let contributorId = "";
  let designId = "";

  const createdOrderIds: string[] = [];
  const createdOrderLineIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    const [prod] = await db
      .insert(product)
      .values({
        slug: `donation-prod-${ts}`,
        title: `Donation Product ${ts}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId,
        sku: `DONATION-SKU-${ts}`,
        title: `Donation Variant ${ts}`,
        priceMinor: unitPrice,
        status: "active",
      })
      .returning();
    variantId = variant.id;

    // Create contributor with donation configured
    const contrib = await createContributor(db, {
      githubUsername: `donation-contrib-${ts}`,
      githubUserId: `gh-donation-${ts}`,
      claAcceptedAt: new Date(),
    });
    contributorId = contrib.id;

    // Set 501(c)(3) donation preference
    await setContributorDonation(db, contributorId, "Test Charity Foundation", "12-3456789");

    const design = await linkContributorDesign(db, {
      contributorId: contrib.id,
      productId,
    });
    designId = design.id;
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      await db
        .delete(contributorDonation)
        .where(eq(contributorDonation.contributorId, contributorId));
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
    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `DONATION-TEST-${ts}-${createdOrderIds.length + 1}`,
        email: `test-donation-${ts}@example.com`,
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
        skuSnapshot: `DONATION-SKU-${ts}`,
        titleSnapshot: `Donation Variant ${ts}`,
        quantity,
        unitPriceMinor: unitPrice,
        totalMinor: unitPrice * quantity,
      })
      .returning();
    createdOrderLineIds.push(line.id);

    return { orderId: ord.id, orderLineId: line.id };
  }

  it("uses 20% donation rate when contributor has 501(c)(3) configured", async () => {
    const db = dbConn.db;
    const donationRoyaltyPerUnit = Math.floor(unitPrice * DONATION_RATE); // 600

    // Create enough orders to cross threshold (25 units in one go)
    const { orderId } = await createCompletedOrder(25);
    const results = await processOrderCompletionSales(db, orderId);

    expect(results.length).toBe(1);
    expect(results[0].newSalesCount).toBe(25);
    expect(results[0].royaltyCreated).toBe(true);

    // Verify royalty amount uses 20% rate (not 10%)
    const royalties = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.contributorId, contributorId));

    // Should have 1 royalty entry (single order line crosses threshold, no prior lines)
    expect(royalties.length).toBe(1);
    // 20% of $30.00 (3000 minor) * 25 = 600 * 25 = 15000
    expect(royalties[0].amountMinor).toBe(donationRoyaltyPerUnit * 25);

    // Verify a donation entry was created
    const donations = await db
      .select()
      .from(contributorDonation)
      .where(eq(contributorDonation.contributorId, contributorId));

    expect(donations.length).toBe(1);
    expect(donations[0].charityName).toBe("Test Charity Foundation");
    expect(donations[0].charityEin).toBe("12-3456789");
    expect(donations[0].status).toBe("pending");
    expect(donations[0].amountMinor).toBe(donationRoyaltyPerUnit * 25);
  });

  it("subsequent sale at 20% rate creates single royalty", async () => {
    const db = dbConn.db;
    const donationRoyaltyPerUnit = Math.floor(unitPrice * DONATION_RATE); // 600

    const { orderId, orderLineId } = await createCompletedOrder(3);
    const results = await processOrderCompletionSales(db, orderId);

    expect(results.length).toBe(1);
    expect(results[0].newSalesCount).toBe(28);
    expect(results[0].royaltyCreated).toBe(true);

    // Verify the new royalty uses 20% rate
    const [royalty] = await db
      .select()
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.orderLineId, orderLineId));

    expect(royalty.amountMinor).toBe(donationRoyaltyPerUnit * 3); // 600 * 3 = 1800
  });
});
