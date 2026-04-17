import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { productClass, productClassMembership } from "../schema/product-class.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NewProductClass = typeof productClass.$inferInsert;
export type ProductClass = typeof productClass.$inferSelect;

export type NewProductClassMembership = typeof productClassMembership.$inferInsert;
export type ProductClassMembership = typeof productClassMembership.$inferSelect;

// ---------------------------------------------------------------------------
// Product Class CRUD
// ---------------------------------------------------------------------------

export async function insertProductClass(
  db: PostgresJsDatabase,
  data: NewProductClass,
): Promise<ProductClass> {
  const [inserted] = await db.insert(productClass).values(data).returning();
  return inserted;
}

export async function findProductClassById(
  db: PostgresJsDatabase,
  id: string,
): Promise<ProductClass | undefined> {
  const [found] = await db.select().from(productClass).where(eq(productClass.id, id));
  return found;
}

export async function findProductClassBySlug(
  db: PostgresJsDatabase,
  slug: string,
): Promise<ProductClass | undefined> {
  const [found] = await db.select().from(productClass).where(eq(productClass.slug, slug));
  return found;
}

export async function listProductClasses(db: PostgresJsDatabase): Promise<ProductClass[]> {
  return db.select().from(productClass);
}

export async function updateProductClass(
  db: PostgresJsDatabase,
  id: string,
  data: Partial<Pick<NewProductClass, "name" | "slug" | "description" | "sortOrder">>,
): Promise<ProductClass | undefined> {
  const [updated] = await db
    .update(productClass)
    .set(data)
    .where(eq(productClass.id, id))
    .returning();
  return updated;
}

export async function deleteProductClass(db: PostgresJsDatabase, id: string): Promise<boolean> {
  const result = await db.delete(productClass).where(eq(productClass.id, id)).returning();
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Product Class Membership
// ---------------------------------------------------------------------------

export async function assignProductToClass(
  db: PostgresJsDatabase,
  productId: string,
  productClassId: string,
): Promise<ProductClassMembership> {
  const [inserted] = await db
    .insert(productClassMembership)
    .values({ productId, productClassId })
    .onConflictDoNothing()
    .returning();
  // If conflict (already assigned), fetch existing
  if (!inserted) {
    const [existing] = await db
      .select()
      .from(productClassMembership)
      .where(
        and(
          eq(productClassMembership.productId, productId),
          eq(productClassMembership.productClassId, productClassId),
        ),
      );
    return existing;
  }
  return inserted;
}

export async function removeProductFromClass(
  db: PostgresJsDatabase,
  productId: string,
  productClassId: string,
): Promise<boolean> {
  const result = await db
    .delete(productClassMembership)
    .where(
      and(
        eq(productClassMembership.productId, productId),
        eq(productClassMembership.productClassId, productClassId),
      ),
    )
    .returning();
  return result.length > 0;
}

export async function findMembershipsByProductId(
  db: PostgresJsDatabase,
  productId: string,
): Promise<ProductClassMembership[]> {
  return db
    .select()
    .from(productClassMembership)
    .where(eq(productClassMembership.productId, productId));
}
