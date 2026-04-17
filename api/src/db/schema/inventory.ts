import { pgTable, uuid, text, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { productVariant } from "./catalog.js";
import { adminUser } from "./admin.js";

// ---------------------------------------------------------------------------
// inventory_location
// ---------------------------------------------------------------------------

export const inventoryLocation = pgTable("inventory_location", {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull(),
  code: text().notNull(),
  type: text().notNull(),
  addressJson: jsonb("address_json"),
  isActive: boolean("is_active").notNull().default(true),
});

// ---------------------------------------------------------------------------
// inventory_balance
// ---------------------------------------------------------------------------

export const inventoryBalance = pgTable("inventory_balance", {
  id: uuid().defaultRandom().primaryKey(),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => productVariant.id),
  locationId: uuid("location_id")
    .notNull()
    .references(() => inventoryLocation.id),
  onHand: integer("on_hand").notNull().default(0),
  reserved: integer().notNull().default(0),
  available: integer().notNull().default(0),
  safetyStock: integer("safety_stock").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// inventory_reservation
// ---------------------------------------------------------------------------

export const inventoryReservation = pgTable("inventory_reservation", {
  id: uuid().defaultRandom().primaryKey(),
  orderId: uuid("order_id"),
  cartId: uuid("cart_id"),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => productVariant.id),
  locationId: uuid("location_id")
    .notNull()
    .references(() => inventoryLocation.id),
  quantity: integer().notNull(),
  status: text().notNull().default("pending"),
  reservationReason: text("reservation_reason").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// inventory_adjustment
// ---------------------------------------------------------------------------

export const inventoryAdjustment = pgTable("inventory_adjustment", {
  id: uuid().defaultRandom().primaryKey(),
  idempotencyKey: text("idempotency_key"),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => productVariant.id),
  locationId: uuid("location_id")
    .notNull()
    .references(() => inventoryLocation.id),
  adjustmentType: text("adjustment_type").notNull(),
  quantityDelta: integer("quantity_delta").notNull(),
  reason: text().notNull(),
  notes: text(),
  actorAdminUserId: uuid("actor_admin_user_id").references(() => adminUser.id),
  relatedOrderId: uuid("related_order_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// inventory_movement
// ---------------------------------------------------------------------------

export const inventoryMovement = pgTable("inventory_movement", {
  id: uuid().defaultRandom().primaryKey(),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => productVariant.id),
  locationId: uuid("location_id")
    .notNull()
    .references(() => inventoryLocation.id),
  movementType: text("movement_type").notNull(),
  quantityDelta: integer("quantity_delta").notNull(),
  referenceType: text("reference_type").notNull(),
  referenceId: uuid("reference_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
