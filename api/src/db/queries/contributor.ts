import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { contributor, contributorDesign, contributorRoyalty } from "../schema/contributor.js";
import { product, productVariant } from "../schema/catalog.js";
import { orderLine } from "../schema/order.js";

// ---------------------------------------------------------------------------
// Royalty constants
// ---------------------------------------------------------------------------

export const ROYALTY_ACTIVATION_THRESHOLD = 25;
export const ROYALTY_RATE = 0.1; // 10% of unit_price_minor

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
 * On order completion, for each order_line:
 *   1. Resolve product_id via variant → product
 *   2. Find contributor_design by product_id
 *   3. Increment sales_count by quantity
 *   4. If sales_count crossed the 25-unit threshold, create contributor_royalty
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

    // Create royalty entry if threshold crossed (sales >= 25)
    let royaltyCreated = false;
    if (newSalesCount >= ROYALTY_ACTIVATION_THRESHOLD) {
      const royaltyAmount = Math.floor(line.unitPriceMinor * ROYALTY_RATE) * line.quantity;
      try {
        await db.insert(contributorRoyalty).values({
          contributorId: design.contributorId,
          orderLineId: line.id,
          amountMinor: royaltyAmount,
          status: "accrued",
        });
        royaltyCreated = true;
      } catch (err: unknown) {
        // UNIQUE constraint on order_line_id — skip if royalty already exists
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
