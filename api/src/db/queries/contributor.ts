import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { contributor, contributorDesign } from "../schema/contributor.js";
import { product } from "../schema/catalog.js";

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
