import { eq, and, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  kitDefinition,
  kitClassRequirement,
  productClassMembership,
  productClass,
} from "../schema/product-class.js";
import { cartLine, cartKitSelection } from "../schema/cart.js";
import { cart } from "../schema/cart.js";
import { product, productVariant, productMedia } from "../schema/catalog.js";
import { inventoryBalance } from "../schema/inventory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KitDefinition = typeof kitDefinition.$inferSelect;
export type NewKitDefinition = typeof kitDefinition.$inferInsert;
export type KitClassRequirement = typeof kitClassRequirement.$inferSelect;
export type NewKitClassRequirement = typeof kitClassRequirement.$inferInsert;

export interface KitSelection {
  product_class_id: string;
  variant_id: string;
}

export interface KitValidationWarning {
  cartLineId: string;
  kitDefinitionId: string;
  type: "requirement_changed" | "selection_invalid" | "kit_unavailable" | "price_changed";
  message: string;
}

export interface AddKitToCartResult {
  cartLineId: string;
  kitDefinitionId: string;
  kitPriceMinor: number;
  individualTotalMinor: number;
  savingsMinor: number;
  selections: Array<{
    productClassId: string;
    variantId: string;
    variantTitle: string;
    individualPriceMinor: number;
  }>;
}

// ---------------------------------------------------------------------------
// Kit Definition CRUD
// ---------------------------------------------------------------------------

export async function insertKitDefinition(
  db: PostgresJsDatabase,
  data: NewKitDefinition,
): Promise<KitDefinition> {
  const [inserted] = await db.insert(kitDefinition).values(data).returning();
  return inserted;
}

export async function findKitDefinitionById(
  db: PostgresJsDatabase,
  id: string,
): Promise<KitDefinition | undefined> {
  const [found] = await db.select().from(kitDefinition).where(eq(kitDefinition.id, id));
  return found;
}

export async function findKitDefinitionBySlug(
  db: PostgresJsDatabase,
  slug: string,
): Promise<KitDefinition | undefined> {
  const [found] = await db.select().from(kitDefinition).where(eq(kitDefinition.slug, slug));
  return found;
}

export async function listKitDefinitions(db: PostgresJsDatabase): Promise<KitDefinition[]> {
  return db.select().from(kitDefinition);
}

export async function updateKitDefinition(
  db: PostgresJsDatabase,
  id: string,
  data: Partial<Pick<NewKitDefinition, "title" | "slug" | "description" | "priceMinor" | "status">>,
): Promise<KitDefinition | undefined> {
  const [updated] = await db
    .update(kitDefinition)
    .set(data)
    .where(eq(kitDefinition.id, id))
    .returning();
  return updated;
}

// ---------------------------------------------------------------------------
// Kit Class Requirements
// ---------------------------------------------------------------------------

export async function setKitClassRequirements(
  db: PostgresJsDatabase,
  kitDefinitionId: string,
  requirements: Array<{ productClassId: string; quantity: number }>,
): Promise<KitClassRequirement[]> {
  // Delete existing requirements
  await db
    .delete(kitClassRequirement)
    .where(eq(kitClassRequirement.kitDefinitionId, kitDefinitionId));

  if (requirements.length === 0) return [];

  const inserted = await db
    .insert(kitClassRequirement)
    .values(
      requirements.map((r) => ({
        kitDefinitionId,
        productClassId: r.productClassId,
        quantity: r.quantity,
      })),
    )
    .returning();

  return inserted;
}

export async function findKitClassRequirements(
  db: PostgresJsDatabase,
  kitDefinitionId: string,
): Promise<KitClassRequirement[]> {
  return db
    .select()
    .from(kitClassRequirement)
    .where(eq(kitClassRequirement.kitDefinitionId, kitDefinitionId));
}

// ---------------------------------------------------------------------------
// Add Kit to Cart
// ---------------------------------------------------------------------------

export async function addKitToCart(
  db: PostgresJsDatabase,
  cartId: string,
  kitDefinitionId: string,
  selections: KitSelection[],
): Promise<AddKitToCartResult> {
  // 1. Validate kit exists and is active
  const kit = await findKitDefinitionById(db, kitDefinitionId);
  if (!kit) {
    throw Object.assign(new Error("Kit definition not found"), {
      code: "ERR_KIT_NOT_FOUND",
    });
  }
  if (kit.status !== "active") {
    throw Object.assign(new Error("Kit is not available"), {
      code: "ERR_KIT_NOT_AVAILABLE",
    });
  }

  // 2. Fetch class requirements
  const requirements = await findKitClassRequirements(db, kitDefinitionId);
  if (requirements.length === 0) {
    throw Object.assign(new Error("Kit has no class requirements defined"), {
      code: "ERR_KIT_NO_REQUIREMENTS",
    });
  }

  // 3. Build a map of required quantities per class
  const reqMap = new Map<string, { quantity: number; className?: string }>();
  for (const req of requirements) {
    reqMap.set(req.productClassId, { quantity: req.quantity });
  }

  // 4. Count selections per class
  const selectionsByClass = new Map<string, KitSelection[]>();
  for (const sel of selections) {
    const existing = selectionsByClass.get(sel.product_class_id) ?? [];
    existing.push(sel);
    selectionsByClass.set(sel.product_class_id, existing);
  }

  // 5. Validate all class requirements are satisfied
  for (const [classId, req] of reqMap) {
    const classSelections = selectionsByClass.get(classId) ?? [];
    if (classSelections.length < req.quantity) {
      const needed = req.quantity - classSelections.length;
      // Look up class name for error message
      const { productClass } = await import("../schema/product-class.js");
      const [cls] = await db.select().from(productClass).where(eq(productClass.id, classId));
      const className = cls?.name ?? "this class";
      throw Object.assign(new Error(`Select ${needed} more from ${className}`), {
        code: "ERR_KIT_INCOMPLETE",
        classId,
        needed,
      });
    }
    if (classSelections.length > req.quantity) {
      throw Object.assign(new Error(`Too many selections for class. Expected ${req.quantity}`), {
        code: "ERR_KIT_EXCESS_SELECTIONS",
        classId,
      });
    }
  }

  // Check for selections in classes not required by the kit
  for (const classId of selectionsByClass.keys()) {
    if (!reqMap.has(classId)) {
      throw Object.assign(new Error("Selection for a class not required by this kit"), {
        code: "ERR_KIT_INVALID_CLASS",
        classId,
      });
    }
  }

  // 6. Validate each variant: exists, active, in stock, belongs to class
  const selectionDetails: Array<{
    productClassId: string;
    variantId: string;
    variantTitle: string;
    individualPriceMinor: number;
  }> = [];

  for (const sel of selections) {
    // Fetch variant
    const [variant] = await db
      .select()
      .from(productVariant)
      .where(eq(productVariant.id, sel.variant_id));

    if (!variant) {
      throw Object.assign(new Error("Variant not found"), {
        code: "ERR_VARIANT_NOT_FOUND",
        variantId: sel.variant_id,
      });
    }

    if (variant.status !== "active") {
      throw Object.assign(new Error("Variant is not available"), {
        code: "ERR_VARIANT_NOT_AVAILABLE",
        variantId: sel.variant_id,
      });
    }

    // Check variant's product belongs to the specified class
    const [membership] = await db
      .select()
      .from(productClassMembership)
      .where(
        and(
          eq(productClassMembership.productId, variant.productId),
          eq(productClassMembership.productClassId, sel.product_class_id),
        ),
      );

    if (!membership) {
      throw Object.assign(new Error("Variant's product does not belong to the specified class"), {
        code: "ERR_KIT_CLASS_MISMATCH",
        variantId: sel.variant_id,
        classId: sel.product_class_id,
      });
    }

    // Check inventory
    const balances = await db
      .select()
      .from(inventoryBalance)
      .where(eq(inventoryBalance.variantId, sel.variant_id));
    const totalAvailable = balances.reduce((sum, b) => sum + b.available, 0);

    if (totalAvailable < 1) {
      // Find alternative in-stock variants from the same class for swap suggestion
      const classMemberships = await db
        .select()
        .from(productClassMembership)
        .where(eq(productClassMembership.productClassId, sel.product_class_id));

      const alternatives: string[] = [];
      for (const m of classMemberships) {
        if (m.productId === variant.productId) continue;
        const variants = await db
          .select()
          .from(productVariant)
          .where(
            and(eq(productVariant.productId, m.productId), eq(productVariant.status, "active")),
          );
        for (const v of variants) {
          const vBalances = await db
            .select()
            .from(inventoryBalance)
            .where(eq(inventoryBalance.variantId, v.id));
          const vAvailable = vBalances.reduce((s, b) => s + b.available, 0);
          if (vAvailable > 0) {
            alternatives.push(v.id);
          }
        }
      }

      throw Object.assign(new Error("Component out of stock"), {
        code: "ERR_KIT_COMPONENT_OUT_OF_STOCK",
        variantId: sel.variant_id,
        alternatives: alternatives.slice(0, 3),
      });
    }

    selectionDetails.push({
      productClassId: sel.product_class_id,
      variantId: sel.variant_id,
      variantTitle: variant.title,
      individualPriceMinor: variant.priceMinor,
    });
  }

  // 7. Calculate individual total for savings display
  const individualTotalMinor = selectionDetails.reduce((sum, s) => sum + s.individualPriceMinor, 0);
  const savingsMinor = Math.max(0, individualTotalMinor - kit.priceMinor);

  // 8. Create cart_line with kit price
  const [newCartLine] = await db
    .insert(cartLine)
    .values({
      cartId,
      variantId: selections[0].variant_id, // Primary variant reference
      quantity: 1,
      unitPriceMinor: kit.priceMinor,
    })
    .returning();

  // 9. Create cart_kit_selection records
  for (const sel of selections) {
    await db.insert(cartKitSelection).values({
      cartLineId: newCartLine.id,
      kitDefinitionId,
      variantId: sel.variant_id,
      productClassId: sel.product_class_id,
    });
  }

  // 10. Update cart's updatedAt
  await db.update(cart).set({ updatedAt: new Date() }).where(eq(cart.id, cartId));

  return {
    cartLineId: newCartLine.id,
    kitDefinitionId,
    kitPriceMinor: kit.priceMinor,
    individualTotalMinor,
    savingsMinor,
    selections: selectionDetails,
  };
}

// ---------------------------------------------------------------------------
// Flag active carts containing a kit for re-validation
// ---------------------------------------------------------------------------

export async function flagCartsForKitRevalidation(
  db: PostgresJsDatabase,
  kitDefinitionId: string,
): Promise<number> {
  // Find all active carts that have cart_kit_selection rows for this kit
  const result = await db.execute(sql`
    UPDATE cart
    SET updated_at = NOW()
    WHERE id IN (
      SELECT DISTINCT c.id
      FROM cart c
      JOIN cart_line cl ON cl.cart_id = c.id
      JOIN cart_kit_selection cks ON cks.cart_line_id = cl.id
      WHERE cks.kit_definition_id = ${kitDefinitionId}
        AND c.status = 'active'
    )
  `);
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Validate kit selections in a cart against current definitions
// ---------------------------------------------------------------------------

export async function validateCartKitSelections(
  db: PostgresJsDatabase,
  cartId: string,
): Promise<KitValidationWarning[]> {
  const warnings: KitValidationWarning[] = [];

  // Find all kit selections in this cart
  const lines = await db.select().from(cartLine).where(eq(cartLine.cartId, cartId));

  for (const line of lines) {
    // Check if this line has kit selections
    const selections = await db
      .select()
      .from(cartKitSelection)
      .where(eq(cartKitSelection.cartLineId, line.id));

    if (selections.length === 0) continue;

    const kitDefId = selections[0].kitDefinitionId;

    // Fetch current kit definition
    const kit = await findKitDefinitionById(db, kitDefId);
    if (!kit) {
      warnings.push({
        cartLineId: line.id,
        kitDefinitionId: kitDefId,
        type: "kit_unavailable",
        message: "Kit definition no longer exists",
      });
      continue;
    }

    if (kit.status !== "active") {
      warnings.push({
        cartLineId: line.id,
        kitDefinitionId: kitDefId,
        type: "kit_unavailable",
        message: "Kit is no longer available",
      });
      continue;
    }

    // Check price change
    if (kit.priceMinor !== line.unitPriceMinor) {
      warnings.push({
        cartLineId: line.id,
        kitDefinitionId: kitDefId,
        type: "price_changed",
        message: `Kit price changed from ${line.unitPriceMinor} to ${kit.priceMinor}`,
      });
    }

    // Fetch current requirements
    const requirements = await findKitClassRequirements(db, kitDefId);
    const reqMap = new Map<string, number>();
    for (const req of requirements) {
      reqMap.set(req.productClassId, req.quantity);
    }

    // Group selections by class
    const selectionsByClass = new Map<string, typeof selections>();
    for (const sel of selections) {
      const existing = selectionsByClass.get(sel.productClassId) ?? [];
      existing.push(sel);
      selectionsByClass.set(sel.productClassId, existing);
    }

    // Check: selections for classes no longer required
    for (const [classId, classSelections] of selectionsByClass) {
      if (!reqMap.has(classId)) {
        warnings.push({
          cartLineId: line.id,
          kitDefinitionId: kitDefId,
          type: "requirement_changed",
          message: `Class ${classId} is no longer required by this kit`,
        });
        continue;
      }

      const required = reqMap.get(classId) ?? 0;
      if (classSelections.length !== required) {
        warnings.push({
          cartLineId: line.id,
          kitDefinitionId: kitDefId,
          type: "requirement_changed",
          message: `Class requires ${required} selections but cart has ${classSelections.length}`,
        });
      }
    }

    // Check: required classes with no selections
    for (const [classId, quantity] of reqMap) {
      if (!selectionsByClass.has(classId)) {
        warnings.push({
          cartLineId: line.id,
          kitDefinitionId: kitDefId,
          type: "requirement_changed",
          message: `Class ${classId} now requires ${quantity} selections but has none`,
        });
      }
    }

    // Validate each variant is still valid (active, in class)
    for (const sel of selections) {
      const [variant] = await db
        .select()
        .from(productVariant)
        .where(eq(productVariant.id, sel.variantId));

      if (!variant || variant.status !== "active") {
        warnings.push({
          cartLineId: line.id,
          kitDefinitionId: kitDefId,
          type: "selection_invalid",
          message: `Variant ${sel.variantId} is no longer available`,
        });
        continue;
      }

      // Check class membership still holds
      const [membership] = await db
        .select()
        .from(productClassMembership)
        .where(
          and(
            eq(productClassMembership.productId, variant.productId),
            eq(productClassMembership.productClassId, sel.productClassId),
          ),
        );

      if (!membership) {
        warnings.push({
          cartLineId: line.id,
          kitDefinitionId: kitDefId,
          type: "selection_invalid",
          message: `Variant ${sel.variantId} no longer belongs to required class`,
        });
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Get current kit price for a cart line (for checkout recalculation)
// ---------------------------------------------------------------------------

export async function getCurrentKitPriceForCartLine(
  db: PostgresJsDatabase,
  cartLineId: string,
): Promise<{ kitDefinitionId: string; currentPriceMinor: number } | null> {
  const [selection] = await db
    .select()
    .from(cartKitSelection)
    .where(eq(cartKitSelection.cartLineId, cartLineId));

  if (!selection) return null;

  const kit = await findKitDefinitionById(db, selection.kitDefinitionId);
  if (!kit) return null;

  return {
    kitDefinitionId: kit.id,
    currentPriceMinor: kit.priceMinor,
  };
}

// ---------------------------------------------------------------------------
// Public Kit Catalog — returns active kits with requirements and products
// ---------------------------------------------------------------------------

export interface CatalogKitProduct {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  variants: Array<{
    id: string;
    title: string;
    material: string;
    priceCents: number;
    inStock: boolean;
    quantityOnHand: number;
  }>;
}

export interface CatalogKitRequirement {
  productClassId: string;
  productClassName: string;
  quantity: number;
  products: CatalogKitProduct[];
}

export interface CatalogKit {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  requirements: CatalogKitRequirement[];
}

export async function findActiveKitsWithDetails(db: PostgresJsDatabase): Promise<CatalogKit[]> {
  // 1. Fetch active kit definitions
  const kits = await db.select().from(kitDefinition).where(eq(kitDefinition.status, "active"));

  if (kits.length === 0) return [];

  // 2. For each kit, fetch requirements with class info and products
  const results = await Promise.all(
    kits.map(async (kit) => {
      const reqs = await db
        .select()
        .from(kitClassRequirement)
        .where(eq(kitClassRequirement.kitDefinitionId, kit.id));

      const requirements: CatalogKitRequirement[] = await Promise.all(
        reqs.map(async (req) => {
          // Get class info
          const [cls] = await db
            .select()
            .from(productClass)
            .where(eq(productClass.id, req.productClassId));

          // Get products in this class
          const memberships = await db
            .select()
            .from(productClassMembership)
            .where(eq(productClassMembership.productClassId, req.productClassId));

          const products: CatalogKitProduct[] = [];
          for (const mem of memberships) {
            const [prod] = await db
              .select()
              .from(product)
              .where(and(eq(product.id, mem.productId), eq(product.status, "active")));
            if (!prod) continue;

            // Get active variants with inventory
            const variants = await db
              .select()
              .from(productVariant)
              .where(
                and(eq(productVariant.productId, prod.id), eq(productVariant.status, "active")),
              );

            const variantResults = await Promise.all(
              variants.map(async (v) => {
                const balances = await db
                  .select()
                  .from(inventoryBalance)
                  .where(eq(inventoryBalance.variantId, v.id));
                const totalAvailable = balances.reduce((sum, b) => sum + b.available, 0);
                const optionValues = (v.optionValuesJson as Record<string, string>) ?? {};
                return {
                  id: v.id,
                  title: v.title,
                  material: optionValues.material ?? "Unknown",
                  priceCents: v.priceMinor,
                  inStock: totalAvailable > 0,
                  quantityOnHand: totalAvailable,
                };
              }),
            );

            // Get primary image
            const media = await db
              .select()
              .from(productMedia)
              .where(eq(productMedia.productId, prod.id))
              .orderBy(productMedia.sortOrder)
              .limit(1);

            products.push({
              id: prod.id,
              slug: prod.slug,
              title: prod.title,
              subtitle: prod.subtitle,
              imageUrl: media.length > 0 ? media[0].url : null,
              variants: variantResults,
            });
          }

          return {
            productClassId: req.productClassId,
            productClassName: cls?.name ?? "Unknown",
            quantity: req.quantity,
            products,
          };
        }),
      );

      return {
        id: kit.id,
        slug: kit.slug,
        title: kit.title,
        description: kit.description,
        priceMinor: kit.priceMinor,
        currency: kit.currency,
        requirements,
      } satisfies CatalogKit;
    }),
  );

  return results;
}
