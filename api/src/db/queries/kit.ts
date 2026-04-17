import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  kitDefinition,
  kitClassRequirement,
  productClassMembership,
} from "../schema/product-class.js";
import { cartLine, cartKitSelection } from "../schema/cart.js";
import { cart } from "../schema/cart.js";
import { productVariant } from "../schema/catalog.js";
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
