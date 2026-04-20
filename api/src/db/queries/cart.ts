import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { cart, cartLine, cartKitSelection } from "../schema/cart.js";
import { productVariant } from "../schema/catalog.js";
import { inventoryBalance } from "../schema/inventory.js";
import type { KitValidationWarning } from "./kit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Cart = typeof cart.$inferSelect;
export type CartLine = typeof cartLine.$inferSelect;

export interface CartLineWithDetails {
  id: string;
  variantId: string;
  sku: string;
  variantTitle: string;
  productId: string;
  quantity: number;
  unitPriceMinor: number;
  currentPriceMinor: number;
  lineTotalMinor: number;
  available: number;
  inStock: boolean;
  priceChanged: boolean;
  insufficientStock: boolean;
  isKit: boolean;
  kitTitle: string | null;
  kitComponents: Array<{ variantId: string; variantTitle: string }> | null;
}

export interface CartWithItems {
  id: string;
  token: string;
  customerId: string | null;
  status: string;
  currency: string;
  items: CartLineWithDetails[];
  subtotalMinor: number;
  itemCount: number;
  kitWarnings: KitValidationWarning[];
}

// ---------------------------------------------------------------------------
// Create cart
// ---------------------------------------------------------------------------

export async function createCart(db: PostgresJsDatabase, customerId?: string): Promise<Cart> {
  const [created] = await db
    .insert(cart)
    .values({
      customerId: customerId ?? null,
      status: "active",
      currency: "USD",
    })
    .returning();
  return created;
}

// ---------------------------------------------------------------------------
// Find cart by token
// ---------------------------------------------------------------------------

export async function findCartByToken(
  db: PostgresJsDatabase,
  token: string,
): Promise<Cart | undefined> {
  const [found] = await db
    .select()
    .from(cart)
    .where(and(eq(cart.token, token), eq(cart.status, "active")));
  return found;
}

// ---------------------------------------------------------------------------
// Find active cart by customer
// ---------------------------------------------------------------------------

export async function findActiveCartByCustomerId(
  db: PostgresJsDatabase,
  customerId: string,
): Promise<Cart | undefined> {
  const [found] = await db
    .select()
    .from(cart)
    .where(and(eq(cart.customerId, customerId), eq(cart.status, "active")));
  return found;
}

// ---------------------------------------------------------------------------
// Add item to cart
// ---------------------------------------------------------------------------

export async function addCartItem(
  db: PostgresJsDatabase,
  cartId: string,
  variantId: string,
  quantity: number,
): Promise<CartLine> {
  // Look up variant to get current price and validate it exists + is active
  const [variant] = await db.select().from(productVariant).where(eq(productVariant.id, variantId));

  if (!variant) {
    throw Object.assign(new Error("Variant not found"), {
      code: "ERR_VARIANT_NOT_FOUND",
    });
  }

  if (variant.status !== "active") {
    throw Object.assign(new Error("Variant is not available"), {
      code: "ERR_VARIANT_NOT_AVAILABLE",
    });
  }

  // Check inventory availability across all locations
  const balances = await db
    .select()
    .from(inventoryBalance)
    .where(eq(inventoryBalance.variantId, variantId));
  const totalAvailable = balances.reduce((sum, b) => sum + b.available, 0);

  if (totalAvailable < quantity) {
    throw Object.assign(new Error("Insufficient inventory"), {
      code: "ERR_INVENTORY_INSUFFICIENT",
    });
  }

  // Check if item already exists in cart — if so, update quantity
  const [existing] = await db
    .select()
    .from(cartLine)
    .where(and(eq(cartLine.cartId, cartId), eq(cartLine.variantId, variantId)));

  if (existing) {
    const newQuantity = existing.quantity + quantity;
    if (totalAvailable < newQuantity) {
      throw Object.assign(new Error("Insufficient inventory for combined quantity"), {
        code: "ERR_INVENTORY_INSUFFICIENT",
      });
    }
    const [updated] = await db
      .update(cartLine)
      .set({ quantity: newQuantity })
      .where(eq(cartLine.id, existing.id))
      .returning();
    // Update cart's updatedAt
    await db.update(cart).set({ updatedAt: new Date() }).where(eq(cart.id, cartId));
    return updated;
  }

  const [inserted] = await db
    .insert(cartLine)
    .values({
      cartId,
      variantId,
      quantity,
      unitPriceMinor: variant.priceMinor,
    })
    .returning();

  // Update cart's updatedAt
  await db.update(cart).set({ updatedAt: new Date() }).where(eq(cart.id, cartId));

  return inserted;
}

// ---------------------------------------------------------------------------
// Remove item from cart
// ---------------------------------------------------------------------------

export async function removeCartItem(
  db: PostgresJsDatabase,
  cartLineId: string,
  cartId: string,
): Promise<boolean> {
  // Delete any kit selections referencing this cart line first (FK constraint)
  await db.delete(cartKitSelection).where(eq(cartKitSelection.cartLineId, cartLineId));

  const [deleted] = await db
    .delete(cartLine)
    .where(and(eq(cartLine.id, cartLineId), eq(cartLine.cartId, cartId)))
    .returning();

  if (deleted) {
    await db.update(cart).set({ updatedAt: new Date() }).where(eq(cart.id, cartId));
  }

  return !!deleted;
}

// ---------------------------------------------------------------------------
// Get cart with items + current prices + availability
// ---------------------------------------------------------------------------

export async function getCartWithItems(
  db: PostgresJsDatabase,
  cartId: string,
): Promise<CartWithItems | undefined> {
  const [cartRow] = await db.select().from(cart).where(eq(cart.id, cartId));
  if (!cartRow) return undefined;

  const lines = await db.select().from(cartLine).where(eq(cartLine.cartId, cartId));

  const items: CartLineWithDetails[] = [];

  for (const line of lines) {
    // Check if this line is a kit — if so, use current kit price
    const { getCurrentKitPriceForCartLine } = await import("./kit.js");
    const kitInfo = await getCurrentKitPriceForCartLine(db, line.id);

    // Fetch current variant data
    const [variant] = await db
      .select()
      .from(productVariant)
      .where(eq(productVariant.id, line.variantId));

    // Fetch inventory availability
    const balances = await db
      .select()
      .from(inventoryBalance)
      .where(eq(inventoryBalance.variantId, line.variantId));
    const totalAvailable = balances.reduce((sum, b) => sum + b.available, 0);

    // For kit lines, use current kit price; for regular items, use variant price
    const currentPriceMinor = kitInfo
      ? kitInfo.currentPriceMinor
      : (variant?.priceMinor ?? line.unitPriceMinor);
    const priceChanged = currentPriceMinor !== line.unitPriceMinor;
    const insufficientStock = totalAvailable < line.quantity;

    // Populate kit display info if this is a kit line
    let isKit = false;
    let kitTitle: string | null = null;
    let kitComponents: Array<{ variantId: string; variantTitle: string }> | null = null;

    if (kitInfo) {
      isKit = true;
      const { findKitDefinitionById } = await import("./kit.js");
      const kitDef = await findKitDefinitionById(db, kitInfo.kitDefinitionId);
      kitTitle = kitDef?.title ?? "Kit";

      const kitSelections = await db
        .select()
        .from(cartKitSelection)
        .where(eq(cartKitSelection.cartLineId, line.id));

      kitComponents = [];
      for (const sel of kitSelections) {
        const [selVariant] = await db
          .select()
          .from(productVariant)
          .where(eq(productVariant.id, sel.variantId));
        kitComponents.push({
          variantId: sel.variantId,
          variantTitle: selVariant?.title ?? "Unknown",
        });
      }
    }

    items.push({
      id: line.id,
      variantId: line.variantId,
      sku: variant?.sku ?? "UNKNOWN",
      variantTitle: isKit ? (kitTitle ?? "Kit") : (variant?.title ?? "Unknown variant"),
      productId: variant?.productId ?? "",
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      currentPriceMinor,
      lineTotalMinor: currentPriceMinor * line.quantity,
      available: totalAvailable,
      inStock: totalAvailable > 0,
      priceChanged,
      insufficientStock,
      isKit,
      kitTitle,
      kitComponents,
    });
  }

  const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);

  // Validate kit selections against current definitions
  const { validateCartKitSelections } = await import("./kit.js");
  const kitWarnings = await validateCartKitSelections(db, cartId);

  return {
    id: cartRow.id,
    token: cartRow.token,
    customerId: cartRow.customerId,
    status: cartRow.status,
    currency: cartRow.currency,
    items,
    subtotalMinor,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    kitWarnings,
  };
}
