import { eq, and, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  inventoryBalance,
  inventoryAdjustment,
  inventoryMovement,
  inventoryLocation,
} from "../schema/inventory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InventoryBalance = typeof inventoryBalance.$inferSelect;
export type InventoryAdjustment = typeof inventoryAdjustment.$inferSelect;
export type InventoryMovement = typeof inventoryMovement.$inferSelect;

export interface BalanceFilters {
  variantId?: string;
  locationId?: string;
  lowStockOnly?: boolean;
}

export interface CreateAdjustmentInput {
  variantId: string;
  locationId: string;
  adjustmentType: "restock" | "shrinkage" | "correction" | "damage" | "return";
  quantityDelta: number;
  reason: string;
  notes?: string;
  actorAdminUserId: string;
  idempotencyKey?: string;
  relatedOrderId?: string;
}

export interface AdjustmentResult {
  adjustment: InventoryAdjustment;
  movement: InventoryMovement;
  balance: InventoryBalance;
  lowStock: boolean;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Fetch inventory balances with optional filters.
 */
export async function findInventoryBalances(
  db: PostgresJsDatabase,
  filters: BalanceFilters = {},
): Promise<InventoryBalance[]> {
  const conditions = [];

  if (filters.variantId) {
    conditions.push(eq(inventoryBalance.variantId, filters.variantId));
  }
  if (filters.locationId) {
    conditions.push(eq(inventoryBalance.locationId, filters.locationId));
  }
  if (filters.lowStockOnly) {
    conditions.push(sql`${inventoryBalance.available} <= ${inventoryBalance.safetyStock}`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  return db.select().from(inventoryBalance).where(where);
}

/**
 * Find a single balance by variant + location.
 */
export async function findBalanceByVariantAndLocation(
  db: PostgresJsDatabase,
  variantId: string,
  locationId: string,
): Promise<InventoryBalance | undefined> {
  const [found] = await db
    .select()
    .from(inventoryBalance)
    .where(
      and(eq(inventoryBalance.variantId, variantId), eq(inventoryBalance.locationId, locationId)),
    );
  return found;
}

/**
 * Create an inventory adjustment that atomically updates the balance
 * and records a movement ledger entry.
 *
 * Uses a transaction to ensure consistency. The DB CHECK constraint
 * on `available >= 0` prevents negative available.
 */
export async function createInventoryAdjustment(
  db: PostgresJsDatabase,
  input: CreateAdjustmentInput,
): Promise<AdjustmentResult> {
  return db.transaction(async (tx) => {
    // Upsert balance row — create if it doesn't exist
    const [balance] = await tx
      .insert(inventoryBalance)
      .values({
        variantId: input.variantId,
        locationId: input.locationId,
        onHand: 0,
        reserved: 0,
        available: 0,
        safetyStock: 0,
      })
      .onConflictDoNothing()
      .returning();

    // If conflict (already exists), select the existing row
    const existingBalance =
      balance ??
      (
        await tx
          .select()
          .from(inventoryBalance)
          .where(
            and(
              eq(inventoryBalance.variantId, input.variantId),
              eq(inventoryBalance.locationId, input.locationId),
            ),
          )
      )[0];

    // Pre-check: reject if negative delta would drive balance below zero
    if (input.quantityDelta < 0) {
      if (existingBalance.available + input.quantityDelta < 0 || existingBalance.onHand + input.quantityDelta < 0) {
        throw { code: "ERR_INVENTORY_INSUFFICIENT", message: "Adjustment would result in negative inventory balance" };
      }
    }

    // Atomically update on_hand and available
    // The CHECK constraint is a safety net; the pre-check above catches it first
    const [updatedBalance] = await tx
      .update(inventoryBalance)
      .set({
        onHand: sql`${inventoryBalance.onHand} + ${input.quantityDelta}`,
        available: sql`${inventoryBalance.available} + ${input.quantityDelta}`,
        updatedAt: new Date(),
      })
      .where(eq(inventoryBalance.id, existingBalance.id))
      .returning();

    // Insert adjustment record
    const [adjustment] = await tx
      .insert(inventoryAdjustment)
      .values({
        variantId: input.variantId,
        locationId: input.locationId,
        adjustmentType: input.adjustmentType,
        quantityDelta: input.quantityDelta,
        reason: input.reason,
        notes: input.notes ?? null,
        actorAdminUserId: input.actorAdminUserId,
        idempotencyKey: input.idempotencyKey ?? null,
        relatedOrderId: input.relatedOrderId ?? null,
      })
      .returning();

    // Insert movement ledger entry
    const [movement] = await tx
      .insert(inventoryMovement)
      .values({
        variantId: input.variantId,
        locationId: input.locationId,
        movementType: "adjustment",
        quantityDelta: input.quantityDelta,
        referenceType: "adjustment",
        referenceId: adjustment.id,
      })
      .returning();

    // Check low-stock condition
    const lowStock = updatedBalance.available <= updatedBalance.safetyStock;

    return { adjustment, movement, balance: updatedBalance, lowStock };
  });
}

/**
 * Find an existing adjustment by idempotency key and return the full result
 * (adjustment + movement + balance) so the caller can return a cached response.
 */
export async function findAdjustmentByIdempotencyKey(
  db: PostgresJsDatabase,
  idempotencyKey: string,
): Promise<AdjustmentResult | null> {
  const [adjustment] = await db
    .select()
    .from(inventoryAdjustment)
    .where(eq(inventoryAdjustment.idempotencyKey, idempotencyKey));

  if (!adjustment) return null;

  // Fetch the corresponding movement
  const [movement] = await db
    .select()
    .from(inventoryMovement)
    .where(
      and(
        eq(inventoryMovement.referenceType, "adjustment"),
        eq(inventoryMovement.referenceId, adjustment.id),
      ),
    );

  // Fetch the current balance
  const [balance] = await db
    .select()
    .from(inventoryBalance)
    .where(
      and(
        eq(inventoryBalance.variantId, adjustment.variantId),
        eq(inventoryBalance.locationId, adjustment.locationId),
      ),
    );

  if (!movement || !balance) return null;

  const lowStock = balance.available <= balance.safetyStock;

  return { adjustment, movement, balance, lowStock };
}

/**
 * Find adjustment records for a variant, ordered by creation time descending.
 */
export async function findAdjustmentsByVariant(
  db: PostgresJsDatabase,
  variantId: string,
): Promise<InventoryAdjustment[]> {
  return db
    .select()
    .from(inventoryAdjustment)
    .where(eq(inventoryAdjustment.variantId, variantId))
    .orderBy(sql`${inventoryAdjustment.createdAt} DESC`);
}

/**
 * Ensure an inventory location exists, returning it.
 */
export async function findLocationByCode(
  db: PostgresJsDatabase,
  code: string,
): Promise<typeof inventoryLocation.$inferSelect | undefined> {
  const [found] = await db.select().from(inventoryLocation).where(eq(inventoryLocation.code, code));
  return found;
}

/**
 * Insert an inventory location.
 */
export async function insertInventoryLocation(
  db: PostgresJsDatabase,
  data: typeof inventoryLocation.$inferInsert,
): Promise<typeof inventoryLocation.$inferSelect> {
  const [inserted] = await db.insert(inventoryLocation).values(data).returning();
  return inserted;
}
