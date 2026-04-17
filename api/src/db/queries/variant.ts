import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { productVariant } from "../schema/catalog.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NewProductVariant = typeof productVariant.$inferInsert;
export type ProductVariant = typeof productVariant.$inferSelect;

// ---------------------------------------------------------------------------
// Valid status transitions for product_variant
// ---------------------------------------------------------------------------

const VARIANT_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ["active", "archived"],
  active: ["inactive", "archived"],
  inactive: ["active", "archived"],
  archived: [], // terminal
};

export function isValidVariantTransition(from: string, to: string): boolean {
  return VARIANT_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function insertVariant(
  db: PostgresJsDatabase,
  data: NewProductVariant,
): Promise<ProductVariant> {
  const [inserted] = await db.insert(productVariant).values(data).returning();
  return inserted;
}

export async function findVariantById(
  db: PostgresJsDatabase,
  id: string,
): Promise<ProductVariant | undefined> {
  const [found] = await db.select().from(productVariant).where(eq(productVariant.id, id));
  return found;
}

export async function findVariantsByProductId(
  db: PostgresJsDatabase,
  productId: string,
): Promise<ProductVariant[]> {
  return db.select().from(productVariant).where(eq(productVariant.productId, productId));
}

export async function updateVariant(
  db: PostgresJsDatabase,
  id: string,
  data: Partial<
    Pick<
      NewProductVariant,
      | "sku"
      | "title"
      | "optionValuesJson"
      | "priceMinor"
      | "currency"
      | "weight"
      | "dimensionsJson"
      | "barcode"
      | "status"
    >
  >,
): Promise<ProductVariant | undefined> {
  const [updated] = await db
    .update(productVariant)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(productVariant.id, id))
    .returning();
  return updated;
}
