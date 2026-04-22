import { eq, inArray, and, sql, gte, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  contributor,
  contributorDesign,
  contributorRoyalty,
  contributorDonation,
  contributorMilestone,
  contributorTaxDocument,
  contributorPayout,
} from "../schema/contributor.js";
import { product, productVariant } from "../schema/catalog.js";
import { order, orderLine } from "../schema/order.js";

// ---------------------------------------------------------------------------
// Royalty constants
// ---------------------------------------------------------------------------

export const ROYALTY_ACTIVATION_THRESHOLD = 25;
export const STARTER_KIT_THRESHOLD = 50;
export const VETERAN_THRESHOLD = 500;
export const ROYALTY_RATE = 0.1; // 10% of unit_price_minor
export const VETERAN_RATE = 0.2; // 20% of unit_price_minor (500+ units)
export const DONATION_RATE = 0.2; // 20% of unit_price_minor (2x for 501(c)(3) donation)

export const MILESTONE_TYPES = ["accepted_pr", "royalty_activation", "starter_kit", "veteran"] as const;
export type MilestoneType = (typeof MILESTONE_TYPES)[number];

export const TAX_DOCUMENT_TYPES = ["w9", "w8ben"] as const;
export type TaxDocumentType = (typeof TAX_DOCUMENT_TYPES)[number];

export const TAX_DOCUMENT_STATUSES = ["pending_review", "approved", "rejected"] as const;
export type TaxDocumentStatus = (typeof TAX_DOCUMENT_STATUSES)[number];

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
  claVersion?: string | null;
  profileVisibility?: string;
}

export interface ContributorRow {
  id: string;
  githubUsername: string;
  githubUserId: string;
  customerId: string | null;
  claAcceptedAt: Date | null;
  claVersion: string | null;
  status: string;
  profileVisibility: string;
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
  claVersion: contributor.claVersion,
  status: contributor.status,
  profileVisibility: contributor.profileVisibility,
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
      claVersion: input.claVersion ?? null,
      status: input.claAcceptedAt ? "active" : "pending",
      profileVisibility: input.profileVisibility ?? "public",
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
// List public contributors (profile_visibility = 'public')
// ---------------------------------------------------------------------------

export async function listPublicContributors(db: PostgresJsDatabase): Promise<ContributorRow[]> {
  return db
    .select(contributorColumns)
    .from(contributor)
    .where(eq(contributor.profileVisibility, "public"));
}

// ---------------------------------------------------------------------------
// Find contributor by GitHub username
// ---------------------------------------------------------------------------

export async function findContributorByGithubUsername(
  db: PostgresJsDatabase,
  githubUsername: string,
): Promise<ContributorRow | null> {
  const [row] = await db
    .select(contributorColumns)
    .from(contributor)
    .where(eq(contributor.githubUsername, githubUsername));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Update contributor profile visibility
// ---------------------------------------------------------------------------

export async function updateContributorProfileVisibility(
  db: PostgresJsDatabase,
  id: string,
  visibility: "public" | "private",
): Promise<ContributorRow | null> {
  const [row] = await db
    .update(contributor)
    .set({ profileVisibility: visibility })
    .where(eq(contributor.id, id))
    .returning(contributorColumns);
  return row ?? null;
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

export interface OrderCompletionResult {
  sales: SalesTrackingResult[];
  newMilestones: MilestoneRow[];
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
 * - 501(c)(3) donation path always uses DONATION_RATE (20%).
 * - 500+ total units sold uses VETERAN_RATE (20%).
 * - Otherwise uses ROYALTY_RATE (10%).
 */
function getRoyaltyRate(
  contrib: { charityName: string | null; charityEin: string | null },
  totalSales?: number,
): number {
  if (contrib.charityName && contrib.charityEin) return DONATION_RATE;
  if (totalSales !== undefined && totalSales >= VETERAN_THRESHOLD) return VETERAN_RATE;
  return ROYALTY_RATE;
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
): Promise<OrderCompletionResult> {
  const results: SalesTrackingResult[] = [];
  const allNewMilestones: MilestoneRow[] = [];

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

  if (lines.length === 0) return { sales: results, newMilestones: allNewMilestones };

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
  if (productIds.length === 0) return { sales: results, newMilestones: allNewMilestones };

  const designs = await db
    .select({
      id: contributorDesign.id,
      contributorId: contributorDesign.contributorId,
      productId: contributorDesign.productId,
      salesCount: contributorDesign.salesCount,
    })
    .from(contributorDesign)
    .where(inArray(contributorDesign.productId, productIds));

  if (designs.length === 0) return { sales: results, newMilestones: allNewMilestones };

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
    const rate = contrib ? getRoyaltyRate(contrib, newSalesCount) : ROYALTY_RATE;

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

  // Auto-detect milestones for all contributors involved in this order
  const processedContributors = new Set<string>();
  for (const result of results) {
    if (!processedContributors.has(result.contributorId)) {
      processedContributors.add(result.contributorId);
      try {
        const newMilestones = await detectMilestones(db, result.contributorId);
        allNewMilestones.push(...newMilestones);
      } catch {
        // Non-fatal: milestone detection should not block order processing
      }
    }
  }

  return { sales: results, newMilestones: allNewMilestones };
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

// ---------------------------------------------------------------------------
// Milestone tracking
// ---------------------------------------------------------------------------

export interface MilestoneRow {
  id: string;
  contributorId: string;
  milestoneType: string;
  reachedAt: Date;
  fulfilledAt: Date | null;
  notes: string | null;
}

const milestoneColumns = {
  id: contributorMilestone.id,
  contributorId: contributorMilestone.contributorId,
  milestoneType: contributorMilestone.milestoneType,
  reachedAt: contributorMilestone.reachedAt,
  fulfilledAt: contributorMilestone.fulfilledAt,
  notes: contributorMilestone.notes,
};

/**
 * Record a milestone for a contributor. Idempotent — if the milestone
 * already exists for this contributor, returns the existing record.
 */
export async function recordMilestone(
  db: PostgresJsDatabase,
  contributorId: string,
  milestoneType: MilestoneType,
  notes?: string,
): Promise<MilestoneRow> {
  // Check if milestone already exists
  const [existing] = await db
    .select(milestoneColumns)
    .from(contributorMilestone)
    .where(
      and(
        eq(contributorMilestone.contributorId, contributorId),
        eq(contributorMilestone.milestoneType, milestoneType),
      ),
    );

  if (existing) return existing;

  const [row] = await db
    .insert(contributorMilestone)
    .values({
      contributorId,
      milestoneType,
      reachedAt: new Date(),
      notes: notes ?? null,
    })
    .returning(milestoneColumns);

  return row;
}

/**
 * List milestones for a contributor.
 */
export async function listMilestonesByContributor(
  db: PostgresJsDatabase,
  contributorId: string,
): Promise<MilestoneRow[]> {
  return db
    .select(milestoneColumns)
    .from(contributorMilestone)
    .where(eq(contributorMilestone.contributorId, contributorId));
}

/**
 * Auto-detect milestones based on total sales count for a contributor.
 * Called after processOrderCompletionSales updates sales counts.
 * Returns only *newly created* milestones (not pre-existing ones).
 */
export async function detectMilestones(
  db: PostgresJsDatabase,
  contributorId: string,
): Promise<MilestoneRow[]> {
  // Get total sales across all designs for this contributor
  const designs = await db
    .select({ salesCount: contributorDesign.salesCount })
    .from(contributorDesign)
    .where(eq(contributorDesign.contributorId, contributorId));

  const totalSales = designs.reduce((sum, d) => sum + d.salesCount, 0);

  // Get existing milestones to know which are new
  const existing = await listMilestonesByContributor(db, contributorId);
  const existingTypes = new Set(existing.map((m) => m.milestoneType));

  const newlyCreated: MilestoneRow[] = [];

  if (totalSales >= ROYALTY_ACTIVATION_THRESHOLD) {
    const isNew = !existingTypes.has("royalty_activation");
    const milestone = await recordMilestone(
      db,
      contributorId,
      "royalty_activation",
      `Reached ${ROYALTY_ACTIVATION_THRESHOLD} units sold`,
    );
    if (isNew) newlyCreated.push(milestone);
  }

  if (totalSales >= STARTER_KIT_THRESHOLD) {
    const isNew = !existingTypes.has("starter_kit");
    const milestone = await recordMilestone(
      db,
      contributorId,
      "starter_kit",
      `Reached ${STARTER_KIT_THRESHOLD} units sold`,
    );
    if (isNew) newlyCreated.push(milestone);
  }

  if (totalSales >= VETERAN_THRESHOLD) {
    const isNew = !existingTypes.has("veteran");
    const milestone = await recordMilestone(
      db,
      contributorId,
      "veteran",
      `Reached ${VETERAN_THRESHOLD} units sold — royalty rate upgraded to ${VETERAN_RATE * 100}%`,
    );
    if (isNew) newlyCreated.push(milestone);
  }

  return newlyCreated;
}

// ---------------------------------------------------------------------------
// Tax document management
// ---------------------------------------------------------------------------

export interface TaxDocumentRow {
  id: string;
  contributorId: string;
  documentType: string;
  storageKey: string;
  uploadedAt: Date;
  status: string;
}

const taxDocColumns = {
  id: contributorTaxDocument.id,
  contributorId: contributorTaxDocument.contributorId,
  documentType: contributorTaxDocument.documentType,
  storageKey: contributorTaxDocument.storageKey,
  uploadedAt: contributorTaxDocument.uploadedAt,
  status: contributorTaxDocument.status,
};

export interface UploadTaxDocumentInput {
  contributorId: string;
  documentType: TaxDocumentType;
  storageKey: string;
}

/**
 * Create a tax document record (status = pending_review).
 */
export async function createTaxDocument(
  db: PostgresJsDatabase,
  input: UploadTaxDocumentInput,
): Promise<TaxDocumentRow> {
  const [row] = await db
    .insert(contributorTaxDocument)
    .values({
      contributorId: input.contributorId,
      documentType: input.documentType,
      storageKey: input.storageKey,
      uploadedAt: new Date(),
      status: "pending_review",
    })
    .returning(taxDocColumns);

  return row;
}

/**
 * Find a tax document by ID.
 */
export async function findTaxDocumentById(
  db: PostgresJsDatabase,
  id: string,
): Promise<TaxDocumentRow | null> {
  const [row] = await db
    .select(taxDocColumns)
    .from(contributorTaxDocument)
    .where(eq(contributorTaxDocument.id, id));
  return row ?? null;
}

/**
 * List tax documents for a contributor.
 */
export async function listTaxDocumentsByContributor(
  db: PostgresJsDatabase,
  contributorId: string,
): Promise<TaxDocumentRow[]> {
  return db
    .select(taxDocColumns)
    .from(contributorTaxDocument)
    .where(eq(contributorTaxDocument.contributorId, contributorId));
}

/**
 * Update the status of a tax document (admin review).
 */
export async function updateTaxDocumentStatus(
  db: PostgresJsDatabase,
  id: string,
  status: "approved" | "rejected",
): Promise<TaxDocumentRow | null> {
  const [row] = await db
    .update(contributorTaxDocument)
    .set({ status })
    .where(eq(contributorTaxDocument.id, id))
    .returning(taxDocColumns);
  return row ?? null;
}

/**
 * Check if a contributor has an approved tax document.
 */
export async function hasApprovedTaxDocument(
  db: PostgresJsDatabase,
  contributorId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: contributorTaxDocument.id })
    .from(contributorTaxDocument)
    .where(
      and(
        eq(contributorTaxDocument.contributorId, contributorId),
        eq(contributorTaxDocument.status, "approved"),
      ),
    );
  return !!row;
}

// ---------------------------------------------------------------------------
// Payout management (with tax document guard)
// ---------------------------------------------------------------------------

export interface PayoutRow {
  id: string;
  contributorId: string;
  amountMinor: number;
  currency: string;
  payoutMethod: string;
  status: string;
  initiatedAt: Date;
  completedAt: Date | null;
}

const payoutColumns = {
  id: contributorPayout.id,
  contributorId: contributorPayout.contributorId,
  amountMinor: contributorPayout.amountMinor,
  currency: contributorPayout.currency,
  payoutMethod: contributorPayout.payoutMethod,
  status: contributorPayout.status,
  initiatedAt: contributorPayout.initiatedAt,
  completedAt: contributorPayout.completedAt,
};

export interface CreatePayoutInput {
  contributorId: string;
  amountMinor: number;
  payoutMethod: string;
}

/**
 * Create a payout for a contributor.
 * Enforces CTR-3: payout blocked until contributor has an approved tax document.
 */
export async function createPayout(
  db: PostgresJsDatabase,
  input: CreatePayoutInput,
): Promise<PayoutRow> {
  const hasTaxDoc = await hasApprovedTaxDocument(db, input.contributorId);
  if (!hasTaxDoc) {
    throw Object.assign(new Error("Payout blocked: contributor has no approved tax document"), {
      code: "ERR_TAX_DOC_REQUIRED",
    });
  }

  const [row] = await db
    .insert(contributorPayout)
    .values({
      contributorId: input.contributorId,
      amountMinor: input.amountMinor,
      payoutMethod: input.payoutMethod,
      status: "pending",
      initiatedAt: new Date(),
    })
    .returning(payoutColumns);

  return row;
}

// ---------------------------------------------------------------------------
// Find contributor by customer ID (for dashboard lookup)
// ---------------------------------------------------------------------------

export async function findContributorByCustomerId(
  db: PostgresJsDatabase,
  customerId: string,
): Promise<ContributorRow | null> {
  const [row] = await db
    .select(contributorColumns)
    .from(contributor)
    .where(eq(contributor.customerId, customerId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// List payouts by contributor
// ---------------------------------------------------------------------------

export async function listPayoutsByContributor(
  db: PostgresJsDatabase,
  contributorId: string,
): Promise<PayoutRow[]> {
  return db
    .select(payoutColumns)
    .from(contributorPayout)
    .where(eq(contributorPayout.contributorId, contributorId));
}

// ---------------------------------------------------------------------------
// Contributor dashboard — aggregated view [FR-075]
// ---------------------------------------------------------------------------

export interface DashboardDesign {
  id: string;
  productId: string;
  productTitle: string | null;
  productSlug: string | null;
  salesCount: number;
}

export interface DashboardRoyaltySummary {
  totalMinor: number;
  paidMinor: number;
  pendingMinor: number;
  clawedBackMinor: number;
  currency: string;
}

export interface DashboardResult {
  contributor: ContributorRow;
  designs: DashboardDesign[];
  royaltySummary: DashboardRoyaltySummary;
  milestones: MilestoneRow[];
  payouts: PayoutRow[];
}

export interface DashboardFilterOptions {
  /** Include only royalties created on or after this date */
  from?: Date;
  /** Include only royalties created on or before this date */
  to?: Date;
}

/**
 * Get a full dashboard view for a contributor.
 * Aggregates designs with sales counts, royalty totals, milestones, and payouts.
 * Optional date range filter scopes royalty aggregation to a time window.
 */
export async function getContributorDashboard(
  db: PostgresJsDatabase,
  contributorId: string,
  filter?: DashboardFilterOptions,
): Promise<DashboardResult | null> {
  const contrib = await findContributorById(db, contributorId);
  if (!contrib) return null;

  // Designs with product info and sales counts
  const designs = await db
    .select({
      id: contributorDesign.id,
      productId: contributorDesign.productId,
      productTitle: product.title,
      productSlug: product.slug,
      salesCount: contributorDesign.salesCount,
    })
    .from(contributorDesign)
    .leftJoin(product, eq(contributorDesign.productId, product.id))
    .where(eq(contributorDesign.contributorId, contributorId));

  // Build royalty filter conditions
  const royaltyConditions = [eq(contributorRoyalty.contributorId, contributorId)];
  if (filter?.from) {
    royaltyConditions.push(gte(contributorRoyalty.createdAt, filter.from));
  }
  if (filter?.to) {
    royaltyConditions.push(lte(contributorRoyalty.createdAt, filter.to));
  }

  // Royalty aggregation by status
  const royaltyRows = await db
    .select({
      status: contributorRoyalty.status,
      total: sql<number>`coalesce(sum(${contributorRoyalty.amountMinor}), 0)`.as("total"),
    })
    .from(contributorRoyalty)
    .where(and(...royaltyConditions))
    .groupBy(contributorRoyalty.status);

  let accruedMinor = 0;
  let clawedBackMinor = 0;
  for (const row of royaltyRows) {
    if (row.status === "accrued") accruedMinor = Number(row.total);
    if (row.status === "clawed_back") clawedBackMinor = Number(row.total);
  }

  // Sum completed payouts to determine paid amount
  const payouts = await listPayoutsByContributor(db, contributorId);
  const paidMinor = payouts
    .filter((p) => p.status === "completed")
    .reduce((sum, p) => sum + p.amountMinor, 0);

  const pendingMinor = accruedMinor - paidMinor;

  const milestones = await listMilestonesByContributor(db, contributorId);

  return {
    contributor: contrib,
    designs,
    royaltySummary: {
      totalMinor: accruedMinor,
      paidMinor,
      pendingMinor,
      clawedBackMinor,
      currency: "USD",
    },
    milestones,
    payouts,
  };
}
