import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { product } from "../schema/catalog.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NewProduct = typeof product.$inferInsert;
export type Product = typeof product.$inferSelect;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function insertProduct(db: PostgresJsDatabase, data: NewProduct): Promise<Product> {
  const [inserted] = await db.insert(product).values(data).returning();
  return inserted;
}

export async function findProductById(
  db: PostgresJsDatabase,
  id: string,
): Promise<Product | undefined> {
  const [found] = await db.select().from(product).where(eq(product.id, id));
  return found;
}

export async function findProductBySlug(
  db: PostgresJsDatabase,
  slug: string,
): Promise<Product | undefined> {
  const [found] = await db.select().from(product).where(eq(product.slug, slug));
  return found;
}
