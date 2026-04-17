import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { productVariant, product } from "../db/schema/catalog.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LowStockAlert {
  variantId: string;
  variantSku: string;
  productTitle: string;
  available: number;
  safetyStock: number;
  timestamp: Date;
}

export interface LowStockAlertService {
  /** Check if available < safetyStock and queue an alert if so. */
  checkAndQueue(
    db: PostgresJsDatabase,
    variantId: string,
    available: number,
    safetyStock: number,
  ): Promise<void>;

  /** Return all queued alerts (useful for testing and future consumers). */
  getAlerts(): LowStockAlert[];

  /** Clear all queued alerts. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createLowStockAlertService(): LowStockAlertService {
  const alerts: LowStockAlert[] = [];

  return {
    async checkAndQueue(
      db: PostgresJsDatabase,
      variantId: string,
      available: number,
      safetyStock: number,
    ): Promise<void> {
      if (safetyStock <= 0 || available >= safetyStock) {
        return;
      }

      // Fetch variant SKU and product title
      const [variant] = await db
        .select({
          sku: productVariant.sku,
          productId: productVariant.productId,
        })
        .from(productVariant)
        .where(eq(productVariant.id, variantId));

      if (!variant) return;

      const [prod] = await db
        .select({ title: product.title })
        .from(product)
        .where(eq(product.id, variant.productId));

      const productTitle = prod?.title ?? "Unknown Product";

      alerts.push({
        variantId,
        variantSku: variant.sku,
        productTitle,
        available,
        safetyStock,
        timestamp: new Date(),
      });
    },

    getAlerts(): LowStockAlert[] {
      return [...alerts];
    },

    clear(): void {
      alerts.length = 0;
    },
  };
}
