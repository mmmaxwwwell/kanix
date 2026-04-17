import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { product, productVariant, productMedia } from "../schema/catalog.js";
import { inventoryBalance } from "../schema/inventory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogVariant {
  id: string;
  sku: string;
  title: string;
  optionValuesJson: unknown;
  priceMinor: number;
  currency: string;
  weight: string | null;
  dimensionsJson: unknown;
  status: string;
  available: number;
  inStock: boolean;
}

export interface CatalogMedia {
  id: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  variantId: string | null;
}

export interface CatalogProduct {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  brand: string | null;
  media: CatalogMedia[];
  variants: CatalogVariant[];
}

// ---------------------------------------------------------------------------
// Public catalog queries
// ---------------------------------------------------------------------------

/**
 * Find all active products with their active variants, media, and availability.
 * Only products with status = "active" are returned.
 * Only variants with status = "active" are included.
 */
export async function findActiveProductsWithDetails(
  db: PostgresJsDatabase,
): Promise<CatalogProduct[]> {
  // Fetch active products
  const products = await db
    .select()
    .from(product)
    .where(eq(product.status, "active"))
    .orderBy(product.createdAt);

  if (products.length === 0) return [];

  // Fetch variants, media, and balances for all products in parallel
  const results = await Promise.all(
    products.map(async (p) => {
      const [variants, media] = await Promise.all([
        db
          .select()
          .from(productVariant)
          .where(and(eq(productVariant.productId, p.id), eq(productVariant.status, "active"))),
        db
          .select()
          .from(productMedia)
          .where(eq(productMedia.productId, p.id))
          .orderBy(productMedia.sortOrder),
      ]);

      // Fetch inventory balances for each active variant
      const balanceMap = new Map<string, number>();
      for (const vid of variants.map((v) => v.id)) {
        const vBalances = await db
          .select()
          .from(inventoryBalance)
          .where(eq(inventoryBalance.variantId, vid));
        const totalAvailable = vBalances.reduce((sum, b) => sum + b.available, 0);
        balanceMap.set(vid, totalAvailable);
      }

      const catalogVariants: CatalogVariant[] = variants.map((v) => {
        const available = balanceMap.get(v.id) ?? 0;
        return {
          id: v.id,
          sku: v.sku,
          title: v.title,
          optionValuesJson: v.optionValuesJson,
          priceMinor: v.priceMinor,
          currency: v.currency,
          weight: v.weight,
          dimensionsJson: v.dimensionsJson,
          status: v.status,
          available,
          inStock: available > 0,
        };
      });

      const catalogMedia: CatalogMedia[] = media.map((m) => ({
        id: m.id,
        url: m.url,
        altText: m.altText,
        sortOrder: m.sortOrder,
        variantId: m.variantId,
      }));

      return {
        id: p.id,
        slug: p.slug,
        title: p.title,
        subtitle: p.subtitle,
        description: p.description,
        brand: p.brand,
        media: catalogMedia,
        variants: catalogVariants,
      };
    }),
  );

  return results;
}

/**
 * Find a single active product by slug with full details.
 */
export async function findActiveProductBySlug(
  db: PostgresJsDatabase,
  slug: string,
): Promise<CatalogProduct | undefined> {
  const [found] = await db
    .select()
    .from(product)
    .where(and(eq(product.slug, slug), eq(product.status, "active")));

  if (!found) return undefined;

  const [variants, media] = await Promise.all([
    db
      .select()
      .from(productVariant)
      .where(and(eq(productVariant.productId, found.id), eq(productVariant.status, "active"))),
    db
      .select()
      .from(productMedia)
      .where(eq(productMedia.productId, found.id))
      .orderBy(productMedia.sortOrder),
  ]);

  // Fetch inventory balances for each active variant
  const balanceMap = new Map<string, number>();
  for (const v of variants) {
    const vBalances = await db
      .select()
      .from(inventoryBalance)
      .where(eq(inventoryBalance.variantId, v.id));
    const totalAvailable = vBalances.reduce((sum, b) => sum + b.available, 0);
    balanceMap.set(v.id, totalAvailable);
  }

  const catalogVariants: CatalogVariant[] = variants.map((v) => {
    const available = balanceMap.get(v.id) ?? 0;
    return {
      id: v.id,
      sku: v.sku,
      title: v.title,
      optionValuesJson: v.optionValuesJson,
      priceMinor: v.priceMinor,
      currency: v.currency,
      weight: v.weight,
      dimensionsJson: v.dimensionsJson,
      status: v.status,
      available,
      inStock: available > 0,
    };
  });

  const catalogMedia: CatalogMedia[] = media.map((m) => ({
    id: m.id,
    url: m.url,
    altText: m.altText,
    sortOrder: m.sortOrder,
    variantId: m.variantId,
  }));

  return {
    id: found.id,
    slug: found.slug,
    title: found.title,
    subtitle: found.subtitle,
    description: found.description,
    brand: found.brand,
    media: catalogMedia,
    variants: catalogVariants,
  };
}
