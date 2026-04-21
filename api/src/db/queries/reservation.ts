import { eq, and, sql, lt, lte, gte, count, desc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { inventoryReservation, inventoryBalance, inventoryMovement } from "../schema/inventory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InventoryReservation = typeof inventoryReservation.$inferSelect;

export interface CleanupMetrics {
  released: number;
  kept: number;
}

export interface ReserveInput {
  variantId: string;
  locationId: string;
  quantity: number;
  ttlMs: number;
  reservationReason?: string;
  orderId?: string;
  cartId?: string;
}

export interface ReserveResult {
  reservation: InventoryReservation;
  movement: typeof inventoryMovement.$inferSelect;
}

export interface ConsumeResult {
  reservation: InventoryReservation;
  movement: typeof inventoryMovement.$inferSelect;
}

export interface ReleaseResult {
  reservation: InventoryReservation;
  movement: typeof inventoryMovement.$inferSelect;
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const RESERVATION_TRANSITIONS: Record<string, string[]> = {
  pending: ["active", "canceled"],
  active: ["consumed", "released", "expired"],
};

export function isValidReservationTransition(from: string, to: string): boolean {
  return RESERVATION_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Reserve
// ---------------------------------------------------------------------------

/**
 * Atomically reserve inventory for a variant at a location.
 *
 * 1. SELECT ... FOR UPDATE on the balance row to lock it
 * 2. Check available >= quantity
 * 3. Decrement available, increment reserved
 * 4. Create reservation record (pending→active)
 * 5. Create inventory_movement
 */
export async function reserveInventory(
  db: PostgresJsDatabase,
  input: ReserveInput,
): Promise<ReserveResult> {
  return db.transaction(async (tx) => {
    // Lock the balance row with SELECT ... FOR UPDATE
    const [balance] = await tx.execute(
      sql`SELECT id, variant_id, location_id, on_hand, reserved, available, safety_stock, updated_at
          FROM inventory_balance
          WHERE variant_id = ${input.variantId} AND location_id = ${input.locationId}
          FOR UPDATE`,
    );

    if (!balance) {
      throw Object.assign(new Error("No inventory balance found"), {
        code: "ERR_INVENTORY_NOT_FOUND",
      });
    }

    const available = balance.available as number;
    if (available < input.quantity) {
      throw Object.assign(new Error("Insufficient inventory"), {
        code: "ERR_INVENTORY_INSUFFICIENT",
      });
    }

    // Atomically update: decrement available, increment reserved
    await tx
      .update(inventoryBalance)
      .set({
        available: sql`${inventoryBalance.available} - ${input.quantity}`,
        reserved: sql`${inventoryBalance.reserved} + ${input.quantity}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventoryBalance.variantId, input.variantId),
          eq(inventoryBalance.locationId, input.locationId),
        ),
      );

    const expiresAt = new Date(Date.now() + input.ttlMs);

    // Create reservation in active state (pending→active in one step since
    // we're atomically reserving and confirming in the same transaction)
    const [reservation] = await tx
      .insert(inventoryReservation)
      .values({
        variantId: input.variantId,
        locationId: input.locationId,
        quantity: input.quantity,
        status: "active",
        reservationReason: input.reservationReason ?? "checkout",
        expiresAt,
        orderId: input.orderId ?? null,
        cartId: input.cartId ?? null,
      })
      .returning();

    // Create movement ledger entry
    const [movement] = await tx
      .insert(inventoryMovement)
      .values({
        variantId: input.variantId,
        locationId: input.locationId,
        movementType: "reservation",
        quantityDelta: -input.quantity,
        referenceType: "inventory_reservation",
        referenceId: reservation.id,
      })
      .returning();

    return { reservation, movement };
  });
}

// ---------------------------------------------------------------------------
// Consume
// ---------------------------------------------------------------------------

/**
 * Consume a reservation — decrements on_hand and reserved.
 * available stays unchanged since the stock was already reserved.
 */
export async function consumeReservation(
  db: PostgresJsDatabase,
  reservationId: string,
): Promise<ConsumeResult> {
  return db.transaction(async (tx) => {
    // Lock the reservation row
    const [reservation] = await tx.execute(
      sql`SELECT * FROM inventory_reservation WHERE id = ${reservationId} FOR UPDATE`,
    );

    if (!reservation) {
      throw Object.assign(new Error("Reservation not found"), {
        code: "ERR_RESERVATION_NOT_FOUND",
      });
    }

    if (reservation.status !== "active") {
      throw Object.assign(
        new Error(`Cannot consume reservation with status '${reservation.status}'`),
        { code: "ERR_INVALID_STATUS_TRANSITION" },
      );
    }

    const qty = reservation.quantity as number;
    const variantId = reservation.variant_id as string;
    const locationId = reservation.location_id as string;

    // Lock and update balance: decrement on_hand and reserved
    await tx.execute(
      sql`UPDATE inventory_balance
          SET on_hand = on_hand - ${qty},
              reserved = reserved - ${qty},
              updated_at = now()
          WHERE variant_id = ${variantId} AND location_id = ${locationId}`,
    );

    // Update reservation status
    const [updated] = await tx
      .update(inventoryReservation)
      .set({
        status: "consumed",
        releasedAt: new Date(),
      })
      .where(eq(inventoryReservation.id, reservationId))
      .returning();

    // Create movement ledger entry
    const [movement] = await tx
      .insert(inventoryMovement)
      .values({
        variantId,
        locationId,
        movementType: "consumption",
        quantityDelta: -qty,
        referenceType: "inventory_reservation",
        referenceId: reservationId,
      })
      .returning();

    return { reservation: updated, movement };
  });
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

/**
 * Release a reservation — decrements reserved, increments available.
 */
export async function releaseReservation(
  db: PostgresJsDatabase,
  reservationId: string,
): Promise<ReleaseResult> {
  return db.transaction(async (tx) => {
    // Lock the reservation row
    const [reservation] = await tx.execute(
      sql`SELECT * FROM inventory_reservation WHERE id = ${reservationId} FOR UPDATE`,
    );

    if (!reservation) {
      throw Object.assign(new Error("Reservation not found"), {
        code: "ERR_RESERVATION_NOT_FOUND",
      });
    }

    if (reservation.status !== "active") {
      throw Object.assign(
        new Error(`Cannot release reservation with status '${reservation.status}'`),
        { code: "ERR_INVALID_STATUS_TRANSITION" },
      );
    }

    const qty = reservation.quantity as number;
    const variantId = reservation.variant_id as string;
    const locationId = reservation.location_id as string;

    // Lock and update balance: decrement reserved, increment available
    await tx.execute(
      sql`UPDATE inventory_balance
          SET reserved = reserved - ${qty},
              available = available + ${qty},
              updated_at = now()
          WHERE variant_id = ${variantId} AND location_id = ${locationId}`,
    );

    // Update reservation status
    const [updated] = await tx
      .update(inventoryReservation)
      .set({
        status: "released",
        releasedAt: new Date(),
      })
      .where(eq(inventoryReservation.id, reservationId))
      .returning();

    // Create movement ledger entry
    const [movement] = await tx
      .insert(inventoryMovement)
      .values({
        variantId,
        locationId,
        movementType: "release",
        quantityDelta: qty,
        referenceType: "inventory_reservation",
        referenceId: reservationId,
      })
      .returning();

    return { reservation: updated, movement };
  });
}

// ---------------------------------------------------------------------------
// Expire (used by cron — T042)
// ---------------------------------------------------------------------------

/**
 * Release expired reservations. Returns cleanup metrics: count released and
 * count of active reservations kept (not yet expired).
 */
export async function releaseExpiredReservations(db: PostgresJsDatabase): Promise<CleanupMetrics> {
  const now = new Date();
  let released = 0;

  // Find active reservations past their expiry
  const expired = await db
    .select()
    .from(inventoryReservation)
    .where(and(eq(inventoryReservation.status, "active"), lt(inventoryReservation.expiresAt, now)));

  for (const res of expired) {
    await db.transaction(async (tx) => {
      // Lock the reservation
      const [locked] = await tx.execute(
        sql`SELECT * FROM inventory_reservation WHERE id = ${res.id} AND status = 'active' FOR UPDATE`,
      );
      if (!locked) return; // Already transitioned

      // Update balance
      await tx.execute(
        sql`UPDATE inventory_balance
            SET reserved = reserved - ${res.quantity},
                available = available + ${res.quantity},
                updated_at = now()
            WHERE variant_id = ${res.variantId} AND location_id = ${res.locationId}`,
      );

      // Mark expired
      await tx
        .update(inventoryReservation)
        .set({
          status: "expired",
          releasedAt: now,
        })
        .where(eq(inventoryReservation.id, res.id));

      // Movement entry
      await tx.insert(inventoryMovement).values({
        variantId: res.variantId,
        locationId: res.locationId,
        movementType: "release",
        quantityDelta: res.quantity,
        referenceType: "inventory_reservation",
        referenceId: res.id,
      });

      released++;
    });
  }

  // Count active reservations that are still valid (not yet expired)
  const [keptResult] = await db
    .select({ count: count() })
    .from(inventoryReservation)
    .where(and(eq(inventoryReservation.status, "active"), gte(inventoryReservation.expiresAt, now)));

  const kept = keptResult?.count ?? 0;

  return { released, kept };
}

/**
 * Find a reservation by ID.
 */
export async function findReservationById(
  db: PostgresJsDatabase,
  id: string,
): Promise<InventoryReservation | undefined> {
  const [found] = await db
    .select()
    .from(inventoryReservation)
    .where(eq(inventoryReservation.id, id));
  return found;
}

// ---------------------------------------------------------------------------
// List reservations with filters
// ---------------------------------------------------------------------------

export interface ListReservationsFilter {
  variantId?: string;
  status?: string;
  expiresBefore?: Date;
}

export async function listReservations(
  db: PostgresJsDatabase,
  filter: ListReservationsFilter,
): Promise<InventoryReservation[]> {
  const conditions = [];

  if (filter.variantId) {
    conditions.push(eq(inventoryReservation.variantId, filter.variantId));
  }
  if (filter.status) {
    conditions.push(eq(inventoryReservation.status, filter.status));
  }
  if (filter.expiresBefore) {
    conditions.push(lte(inventoryReservation.expiresAt, filter.expiresBefore));
  }

  const query = db
    .select()
    .from(inventoryReservation);

  if (conditions.length > 0) {
    return query.where(and(...conditions)).orderBy(desc(inventoryReservation.createdAt));
  }
  return query.orderBy(desc(inventoryReservation.createdAt));
}

// ---------------------------------------------------------------------------
// Reservation stats
// ---------------------------------------------------------------------------

export interface ReservationStats {
  active: number;
  consumed: number;
  released: number;
  expired: number;
}

export async function getReservationStats(
  db: PostgresJsDatabase,
  variantId?: string,
): Promise<ReservationStats> {
  const statuses = ["active", "consumed", "released", "expired"] as const;
  const result: ReservationStats = { active: 0, consumed: 0, released: 0, expired: 0 };

  for (const status of statuses) {
    const conditions = [eq(inventoryReservation.status, status)];
    if (variantId) {
      conditions.push(eq(inventoryReservation.variantId, variantId));
    }
    const [row] = await db
      .select({ count: count() })
      .from(inventoryReservation)
      .where(and(...conditions));
    result[status] = row?.count ?? 0;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Force-release (admin override — releases even expired/consumed if active)
// ---------------------------------------------------------------------------

export async function forceReleaseReservation(
  db: PostgresJsDatabase,
  reservationId: string,
): Promise<ReleaseResult> {
  return db.transaction(async (tx) => {
    const [reservation] = await tx.execute(
      sql`SELECT * FROM inventory_reservation WHERE id = ${reservationId} FOR UPDATE`,
    );

    if (!reservation) {
      throw Object.assign(new Error("Reservation not found"), {
        code: "ERR_RESERVATION_NOT_FOUND",
      });
    }

    if (reservation.status !== "active") {
      throw Object.assign(
        new Error(`Cannot force-release reservation with status '${reservation.status}'`),
        { code: "ERR_INVALID_STATUS_TRANSITION" },
      );
    }

    const qty = reservation.quantity as number;
    const variantId = reservation.variant_id as string;
    const locationId = reservation.location_id as string;

    // Update balance: decrement reserved, increment available
    await tx.execute(
      sql`UPDATE inventory_balance
          SET reserved = reserved - ${qty},
              available = available + ${qty},
              updated_at = now()
          WHERE variant_id = ${variantId} AND location_id = ${locationId}`,
    );

    // Mark as released
    const [updated] = await tx
      .update(inventoryReservation)
      .set({
        status: "released",
        releasedAt: new Date(),
      })
      .where(eq(inventoryReservation.id, reservationId))
      .returning();

    // Movement entry
    const [movement] = await tx
      .insert(inventoryMovement)
      .values({
        variantId,
        locationId,
        movementType: "release",
        quantityDelta: qty,
        referenceType: "inventory_reservation",
        referenceId: reservationId,
      })
      .returning();

    return { reservation: updated, movement };
  });
}
