import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { product, productMedia, collection, collectionProduct } from "../schema/catalog.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NewProduct = typeof product.$inferInsert;
export type Product = typeof product.$inferSelect;
export type NewProductMedia = typeof productMedia.$inferInsert;
export type ProductMedia = typeof productMedia.$inferSelect;
export type NewCollection = typeof collection.$inferInsert;
export type Collection = typeof collection.$inferSelect;
export type NewCollectionProduct = typeof collectionProduct.$inferInsert;
export type CollectionProduct = typeof collectionProduct.$inferSelect;

// ---------------------------------------------------------------------------
// Product status transitions
// ---------------------------------------------------------------------------

const VALID_PRODUCT_TRANSITIONS: Record<string, string[]> = {
  draft: ["active", "archived"],
  active: ["draft", "archived"],
  archived: [], // terminal
};

export function isValidProductTransition(from: string, to: string): boolean {
  return VALID_PRODUCT_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Product queries
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

export async function findAllProducts(db: PostgresJsDatabase): Promise<Product[]> {
  return db.select().from(product).orderBy(product.createdAt);
}

export async function updateProduct(
  db: PostgresJsDatabase,
  id: string,
  data: Partial<Pick<Product, "slug" | "title" | "subtitle" | "description" | "status" | "brand">>,
): Promise<Product | undefined> {
  const [updated] = await db
    .update(product)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(product.id, id))
    .returning();
  return updated;
}

// ---------------------------------------------------------------------------
// Product media queries
// ---------------------------------------------------------------------------

export async function insertProductMedia(
  db: PostgresJsDatabase,
  data: NewProductMedia,
): Promise<ProductMedia> {
  const [inserted] = await db.insert(productMedia).values(data).returning();
  return inserted;
}

export async function findMediaByProductId(
  db: PostgresJsDatabase,
  productId: string,
): Promise<ProductMedia[]> {
  return db
    .select()
    .from(productMedia)
    .where(eq(productMedia.productId, productId))
    .orderBy(productMedia.sortOrder);
}

export async function findMediaById(
  db: PostgresJsDatabase,
  id: string,
): Promise<ProductMedia | undefined> {
  const [found] = await db.select().from(productMedia).where(eq(productMedia.id, id));
  return found;
}

export async function updateProductMedia(
  db: PostgresJsDatabase,
  id: string,
  data: Partial<Pick<ProductMedia, "url" | "altText" | "sortOrder" | "variantId">>,
): Promise<ProductMedia | undefined> {
  const [updated] = await db
    .update(productMedia)
    .set(data)
    .where(eq(productMedia.id, id))
    .returning();
  return updated;
}

export async function deleteProductMedia(db: PostgresJsDatabase, id: string): Promise<boolean> {
  const result = await db.delete(productMedia).where(eq(productMedia.id, id)).returning();
  return result.length > 0;
}

export async function reorderProductMedia(
  db: PostgresJsDatabase,
  productId: string,
  mediaIds: string[],
): Promise<ProductMedia[]> {
  const updated: ProductMedia[] = [];
  for (let i = 0; i < mediaIds.length; i++) {
    const [row] = await db
      .update(productMedia)
      .set({ sortOrder: i })
      .where(sql`${productMedia.id} = ${mediaIds[i]} AND ${productMedia.productId} = ${productId}`)
      .returning();
    if (row) updated.push(row);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Collection queries
// ---------------------------------------------------------------------------

export async function insertCollection(
  db: PostgresJsDatabase,
  data: NewCollection,
): Promise<Collection> {
  const [inserted] = await db.insert(collection).values(data).returning();
  return inserted;
}

export async function findCollectionById(
  db: PostgresJsDatabase,
  id: string,
): Promise<Collection | undefined> {
  const [found] = await db.select().from(collection).where(eq(collection.id, id));
  return found;
}

export async function findAllCollections(db: PostgresJsDatabase): Promise<Collection[]> {
  return db.select().from(collection);
}

export async function updateCollection(
  db: PostgresJsDatabase,
  id: string,
  data: Partial<Pick<Collection, "slug" | "title" | "description" | "status">>,
): Promise<Collection | undefined> {
  const [updated] = await db.update(collection).set(data).where(eq(collection.id, id)).returning();
  return updated;
}

// ---------------------------------------------------------------------------
// Collection-product association queries
// ---------------------------------------------------------------------------

export async function addProductToCollection(
  db: PostgresJsDatabase,
  data: NewCollectionProduct,
): Promise<CollectionProduct> {
  const [inserted] = await db
    .insert(collectionProduct)
    .values(data)
    .onConflictDoNothing()
    .returning();
  // If conflict (already exists), fetch it
  if (!inserted) {
    const [existing] = await db
      .select()
      .from(collectionProduct)
      .where(
        sql`${collectionProduct.collectionId} = ${data.collectionId} AND ${collectionProduct.productId} = ${data.productId}`,
      );
    return existing;
  }
  return inserted;
}

export async function removeProductFromCollection(
  db: PostgresJsDatabase,
  collectionId: string,
  productId: string,
): Promise<boolean> {
  const result = await db
    .delete(collectionProduct)
    .where(
      sql`${collectionProduct.collectionId} = ${collectionId} AND ${collectionProduct.productId} = ${productId}`,
    )
    .returning();
  return result.length > 0;
}

export async function findProductsByCollectionId(
  db: PostgresJsDatabase,
  collectionId: string,
): Promise<CollectionProduct[]> {
  return db
    .select()
    .from(collectionProduct)
    .where(eq(collectionProduct.collectionId, collectionId))
    .orderBy(collectionProduct.sortOrder);
}
