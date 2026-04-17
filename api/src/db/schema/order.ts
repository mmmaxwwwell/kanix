import { pgTable, uuid, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { customer } from "./customer.js";
import { productVariant } from "./catalog.js";
import { adminUser } from "./admin.js";

// ---------------------------------------------------------------------------
// order (reserved word — table name is quoted in SQL)
// ---------------------------------------------------------------------------

export const order = pgTable("order", {
  id: uuid().defaultRandom().primaryKey(),
  orderNumber: text("order_number").notNull(),
  customerId: uuid("customer_id").references(() => customer.id),
  email: text().notNull(),
  status: text().notNull().default("draft"),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  fulfillmentStatus: text("fulfillment_status").notNull().default("unfulfilled"),
  shippingStatus: text("shipping_status").notNull().default("not_shipped"),
  currency: text().notNull().default("USD"),
  subtotalMinor: integer("subtotal_minor").notNull(),
  taxMinor: integer("tax_minor").notNull().default(0),
  shippingMinor: integer("shipping_minor").notNull().default(0),
  discountMinor: integer("discount_minor").notNull().default(0),
  totalMinor: integer("total_minor").notNull(),
  billingAddressSnapshotJson: jsonb("billing_address_snapshot_json"),
  shippingAddressSnapshotJson: jsonb("shipping_address_snapshot_json"),
  placedAt: timestamp("placed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// order_line
// ---------------------------------------------------------------------------

export const orderLine = pgTable("order_line", {
  id: uuid().defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => order.id),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => productVariant.id),
  skuSnapshot: text("sku_snapshot").notNull(),
  titleSnapshot: text("title_snapshot").notNull(),
  optionValuesSnapshotJson: jsonb("option_values_snapshot_json").notNull().default({}),
  quantity: integer().notNull(),
  unitPriceMinor: integer("unit_price_minor").notNull(),
  totalMinor: integer("total_minor").notNull(),
});

// ---------------------------------------------------------------------------
// order_status_history
// ---------------------------------------------------------------------------

export const orderStatusHistory = pgTable("order_status_history", {
  id: uuid().defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => order.id),
  statusType: text("status_type").notNull(),
  oldValue: text("old_value").notNull(),
  newValue: text("new_value").notNull(),
  reason: text(),
  actorAdminUserId: uuid("actor_admin_user_id").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
