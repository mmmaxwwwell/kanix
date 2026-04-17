import { eq, inArray, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  contributor,
  contributorDesign,
  contributorRoyalty,
  contributorDonation,
} from "../schema/contributor.js";
import { product, productVariant } from "../schema/catalog.js";
import { order, orderLine } from "../schema/order.js";

// ---------------------------------------------------------------------------
// Royalty constants
// ---------------------------------------------------------------------------

export const ROYALTY_ACTIVATION_THRESHOLD = 25;
export const ROYALTY_RATE = 0.1; // 10% of unit_price_minor
export const DONATION_RATE = 0.2; // 20% of unit_price_minor (2x for 501(c)(3) donation)

// ---------------------------------------------------------------------------
// Contributor statuses
// ---------------------------------------------------------------------------

export const CONTRIBUTOR_STATUSES = ["pending", "active", "suspended", "deactivated"] as const;
export type ContributorStatus = (typeof CONTRIBUTOR_STATUSES)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateContributorInput {
  githubUsername: string;
  githubUserId: string;
  customerId?: string | null;
  claAcceptedAt?: Date | null;
}

export interface ContributorRow {
  id: string;
  githubUsername: string;
  githubUserId: string;
  customerId: string | null;
  claAcceptedAt: Date | null;
  status: string;
  charityName: string | null;
  charityEin: string | null;
}

export interface ContributorDesignRow {
  id: string;
  contributorId: string;
  productId: string;
  createdAt: Date;
  productTitle: string | null;
  productSlug: string | null;
}

export interface LinkDesignInput {
  contributorId: string;
  productId: string;
}

// ---------------------------------------------------------------------------
// Column selections
// ---------------------------------------------------------------------------

const contributorColumns = {
  id: contributor.id,
  githubUsername: contributor.githubUsername,
  githubUserId: contributor.githubUserId,
  customerId: contributor.customerId,
  claAcceptedAt: contributor.claAcceptedAt,
  status: contributor.status,
  charityName: contributor.charityName,
  charityEin: contributor.charityEin,
};

// ---------------------------------------------------------------------------
// Create contributor
// ---------------------------------------------------------------------------

export async function createContributor(
  db: PostgresJsDatabase,
  input: CreateContributorInput,
): Promise<ContributorRow> {
  const [row] = await db
    .insert(contributor)
    .values({
      githubUsername: input.githubUsername,
      githubUserId: input.githubUserId,
      customerId: input.customerId ?? null,
      claAcceptedAt: input.claAcceptedAt ?? null,
      status: input.claAcceptedAt ? "active" : "pending",
    })
    .returning(contributorColumns);
  return row;
}

// ---------------------------------------------------------------------------
// Find contributor by ID
// ---------------------------------------------------------------------------

export async function findContributorById(
  db: PostgresJsDatabase,
  id: string,
): Promise<ContributorRow | null> {
  const [row] = await db.select(contributorColumns).from(contributor).where(eq(contributor.id, id));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// List all contributors
// ---------------------------------------------------------------------------

export async function listContributors(db: PostgresJsDatabase): Promise<ContributorRow[]> {
  return db.select(contributorColumns).from(contributor);
}

// ---------------------------------------------------------------------------
// Link contributor to product (contributor_design)
// ---------------------------------------------------------------------------

export async function linkContributorDesign(
  db: PostgresJsDatabase,
  input: LinkDesignInput,
): Promise<{ id: string; contributorId: string; productId: string; createdAt: Date }> {
  const [row] = await db
    .insert(contributorDesign)
    .values({
      contributorId: input.contributorId,
      productId: input.productId,
    })
    .returning({
      id: contributorDesign.id,
      contributorId: contributorDesign.contributorId,
      productId: contributorDesign.productId,
      createdAt: contributorDesign.createdAt,
    });
  return row;
}

// ---------------------------------------------------------------------------
// List designs by contributor (with product info)
// ---------------------------------------------------------------------------

export async function listDesignsByContributor(
  db: PostgresJsDatabase,
  contributorId: string,
): Promise<ContributorDesignRow[]> {
  return db
    .select({
      id: contributorDesign.id,
      contributorId: contributorDesign.contributorId,
      productId: contributorDesign.productId,
      createdAt: contributorDesign.createdAt,
      productTitle: product.title,
      productSlug: product.slug,
    })
    .from(contributorDesign)
    .leftJoin(product, eq(contributorDesign.productId, product.id))
    .where(eq(contributorDesign.contributorId, contributorId));
}

// ---------------------------------------------------------------------------
// Per-design sales tracking types
// ---------------------------------------------------------------------------

export interface SalesTrackingResult {
  designId: string;
  contributorId: string;
  productId: string;
  previousSalesCount: number;
  newSalesCount: number;
  royaltyCreated: boolean;
}

// ---------------------------------------------------------------------------
// Get sales count for a contributor design
// ---------------------------------------------------------------------------

export async function getDesignSalesCount(
  db: PostgresJsDatabase,
  designId: string,
): Promise<number> {
  const [row] = await db
    .select({ salesCount: contributorDesign.salesCount })
    .from(contributorDesign)
    .where(eq(contributorDesign.id, designId));
  return row?.salesCount ?? 0;
}

// ---------------------------------------------------------------------------
// Process order completion sales — called when order.status → completed
// ---------------------------------------------------------------------------

/**
 * Determine the royalty rate for a contributor.
 * If the contributor has both charity_name and charity_ein set (501(c)(3) donation),
 * the rate is 20%. Otherwise, it's 10%.
 */
function getRoyaltyRate(contrib: {
  charityName: string | null;
  charityEin: string | null;
}): number {
  return contrib.charityName && contrib.charityEin ? DONATION_RATE : ROYALTY_RATE;
}

/**
 * On order completion, for each order_line:
 *   1. Resolve product_id via variant → product
 *   2. Find contributor_design by product_id
 *   3. Increment sales_count by quantity
 *   4. If sales_count just crossed the 25-unit threshold, create retroactive
 *      royalty entries for all previous order lines (units 1-25) and the current line
 *   5. If already above threshold, create royalty for current line only
 *   6. If contributor has 501(c)(3) donation configured, use 20% rate and
 *      create contributor_donation entries
 */
export async function processOrderCompletionSales(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<SalesTrackingResult[]> {
  const results: SalesTrackingResult[] = [];

  // 1. Get all order lines for this order
  const lines = await db
    .select({
      id: orderLine.id,
      variantId: orderLine.variantId,
      quantity: orderLine.quantity,
      unitPriceMinor: orderLine.unitPriceMinor,
    })
    .from(orderLine)
    .where(eq(orderLine.orderId, orderId));

  if (lines.length === 0) return results;

  // 2. Get product IDs for all variants in one query
  const variantIds = lines.map((l) => l.variantId);
  const variants = await db
    .select({
      id: productVariant.id,
      productId: productVariant.productId,
    })
    .from(productVariant)
    .where(inArray(productVariant.id, variantIds));

  const variantToProduct = new Map(variants.map((v) => [v.id, v.productId]));

  // 3. Get all unique product IDs and find contributor designs
  const productIds = [...new Set(variants.map((v) => v.productId))];
  if (productIds.length === 0) return results;

  const designs = await db
    .select({
      id: contributorDesign.id,
      contributorId: contributorDesign.contributorId,
      productId: contributorDesign.productId,
      salesCount: contributorDesign.salesCount,
    })
    .from(contributorDesign)
    .where(inArray(contributorDesign.productId, productIds));

  if (designs.length === 0) return results;

  const productToDesign = new Map(designs.map((d) => [d.productId, d]));

  // Pre-fetch contributor donation settings for all relevant contributors
  const contributorIds = [...new Set(designs.map((d) => d.contributorId))];
  const contributors = await db
    .select({
      id: contributor.id,
      charityName: contributor.charityName,
      charityEin: contributor.charityEin,
    })
    .from(contributor)
    .where(inArray(contributor.id, contributorIds));
  const contributorMap = new Map(contributors.map((c) => [c.id, c]));

  // 4. Process each order line
  for (const line of lines) {
    const productId = variantToProduct.get(line.variantId);
    if (!productId) continue;

    const design = productToDesign.get(productId);
    if (!design) continue;

    const previousSalesCount = design.salesCount;
    const newSalesCount = previousSalesCount + line.quantity;

    // Increment sales_count
    await db
      .update(contributorDesign)
      .set({ salesCount: newSalesCount })
      .where(eq(contributorDesign.id, design.id));

    // Update in-memory for subsequent lines referencing the same design
    design.salesCount = newSalesCount;

    const contrib = contributorMap.get(design.contributorId);
    const rate = contrib ? getRoyaltyRate(contrib) : ROYALTY_RATE;

    let royaltyCreated = false;

    // Check if we just crossed the threshold (retroactive royalties needed)
    if (
      previousSalesCount < ROYALTY_ACTIVATION_THRESHOLD &&
      newSalesCount >= ROYALTY_ACTIVATION_THRESHOLD
    ) {
      // Create retroactive royalty entries for ALL order lines (including the
      // current one, since the order is already "completed") that contributed
      // to this design's sales.
      const created = await createRetroactiveRoyalties(
        db,
        design.productId,
        design.contributorId,
        rate,
      );
      royaltyCreated = created > 0;

      // Create donation entry if contributor has 501(c)(3) configured
      if (contrib?.charityName && contrib?.charityEin) {
        await createDonationFromRoyalties(
          db,
          design.contributorId,
          contrib.charityName,
          contrib.charityEin,
        );
      }
    } else if (newSalesCount >= ROYALTY_ACTIVATION_THRESHOLD) {
      // Already above threshold — create royalty for current line only
      const royaltyAmount = Math.floor(line.unitPriceMinor * rate) * line.quantity;
      try {
        await db.insert(contributorRoyalty).values({
          contributorId: design.contributorId,
          orderLineId: line.id,
          amountMinor: royaltyAmount,
          status: "accrued",
        });
        royaltyCreated = true;
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error.code !== "23505") throw err;
      }
    }

    results.push({
      designId: design.id,
      contributorId: design.contributorId,
      productId,
      previousSalesCount,
      newSalesCount,
      royaltyCreated,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Retroactive royalty creation — called when threshold is first crossed
// ---------------------------------------------------------------------------

/**
 * Create royalty entries for all previous order lines that contributed
 * to sales of a contributor-designed product but didn't get royalties
 * because the design was below the 25-unit threshold at the time.
 */
async function createRetroactiveRoyalties(
  db: PostgresJsDatabase,
  productId: string,
  contributorId: string,
  rate: number,
): Promise<number> {
  // Find all variants for this product
  const variantRows = await db
    .select({ id: productVariant.id })
    .from(productVariant)
    .where(eq(productVariant.productId, productId));

  if (variantRows.length === 0) return 0;

  const variantIds = variantRows.map((v) => v.id);

  // Find all order lines for these variants from completed orders
  // that don't already have royalty entries
  const historicalLines = await db
    .select({
      id: orderLine.id,
      unitPriceMinor: orderLine.unitPriceMinor,
      quantity: orderLine.quantity,
    })
    .from(orderLine)
    .innerJoin(order, eq(orderLine.orderId, order.id))
    .where(and(inArray(orderLine.variantId, variantIds), eq(order.status, "completed")));

  let created = 0;

  for (const line of historicalLines) {
    // Check if a royalty already exists for this order line
    const existing = await db
      .select({ id: contributorRoyalty.id })
      .from(contributorRoyalty)
      .where(eq(contributorRoyalty.orderLineId, line.id));

    if (existing.length > 0) continue;

    const royaltyAmount = Math.floor(line.unitPriceMinor * rate) * line.quantity;
    try {
      await db.insert(contributorRoyalty).values({
        contributorId,
        orderLineId: line.id,
        amountMinor: royaltyAmount,
        status: "accrued",
      });
      created++;
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error.code !== "23505") throw err;
    }
  }

  return created;
}

// ---------------------------------------------------------------------------
// Donation entry creation
// ---------------------------------------------------------------------------

/**
 * Create a contributor_donation entry summarizing the total accrued royalties
 * for a contributor after threshold activation.
 */
async function createDonationFromRoyalties(
  db: PostgresJsDatabase,
  contributorId: string,
  charityName: string,
  charityEin: string,
): Promise<void> {
  // Sum all accrued royalties for this contributor
  const royalties = await db
    .select({ amountMinor: contributorRoyalty.amountMinor })
    .from(contributorRoyalty)
    .where(
      and(
        eq(contributorRoyalty.contributorId, contributorId),
        eq(contributorRoyalty.status, "accrued"),
      ),
    );

  const totalAmount = royalties.reduce((sum, r) => sum + r.amountMinor, 0);
  if (totalAmount <= 0) return;

  await db.insert(contributorDonation).values({
    contributorId,
    charityName,
    charityEin,
    amountMinor: totalAmount,
    status: "pending",
  });
}

// ---------------------------------------------------------------------------
// Refund clawback — mark royalty as clawed_back when order is refunded
// ---------------------------------------------------------------------------

/**
 * Clawback a royalty entry for a specific order line.
 * Sets contributor_royalty.status to 'clawed_back'.
 * Returns the clawed-back royalty record, or null if no royalty existed.
 */
export async function clawbackRoyaltyByOrderLine(
  db: PostgresJsDatabase,
  orderLineId: string,
): Promise<{ id: string; amountMinor: number; status: string } | null> {
  const [existing] = await db
    .select({
      id: contributorRoyalty.id,
      amountMinor: contributorRoyalty.amountMinor,
      status: contributorRoyalty.status,
    })
    .from(contributorRoyalty)
    .where(eq(contributorRoyalty.orderLineId, orderLineId));

  if (!existing) return null;

  if (existing.status === "clawed_back") return existing;

  const [updated] = await db
    .update(contributorRoyalty)
    .set({ status: "clawed_back" })
    .where(eq(contributorRoyalty.id, existing.id))
    .returning({
      id: contributorRoyalty.id,
      amountMinor: contributorRoyalty.amountMinor,
      status: contributorRoyalty.status,
    });

  return updated;
}

/**
 * Clawback all royalties for all order lines in an order.
 * Used when an entire order is refunded.
 */
export async function clawbackRoyaltiesByOrderId(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<{ clawedBack: number }> {
  // Get all order lines for this order
  const lines = await db
    .select({ id: orderLine.id })
    .from(orderLine)
    .where(eq(orderLine.orderId, orderId));

  let clawedBack = 0;
  for (const line of lines) {
    const result = await clawbackRoyaltyByOrderLine(db, line.id);
    if (result && result.status === "clawed_back") clawedBack++;
  }

  return { clawedBack };
}

// ---------------------------------------------------------------------------
// Configure contributor donation preference
// ---------------------------------------------------------------------------

/**
 * Set or clear the 501(c)(3) donation configuration for a contributor.
 * When both charityName and charityEin are set, future royalties use 20% rate.
 * Pass null for both to clear the donation preference.
 */
export async function setContributorDonation(
  db: PostgresJsDatabase,
  contributorId: string,
  charityName: string | null,
  charityEin: string | null,
): Promise<ContributorRow> {
  const [updated] = await db
    .update(contributor)
    .set({ charityName, charityEin })
    .where(eq(contributor.id, contributorId))
    .returning(contributorColumns);
  return updated;
}
