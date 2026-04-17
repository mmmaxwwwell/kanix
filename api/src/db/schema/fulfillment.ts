import { pgTable, uuid, text, timestamp, integer, numeric, jsonb } from "drizzle-orm/pg-core";
import { order, orderLine } from "./order.js";
import { adminUser } from "./admin.js";

// ---------------------------------------------------------------------------
// fulfillment_task
// ---------------------------------------------------------------------------

export const fulfillmentTask = pgTable("fulfillment_task", {
  id: uuid().defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => order.id),
  status: text().notNull().default("new"),
  priority: text().notNull().default("normal"),
  assignedAdminUserId: uuid("assigned_admin_user_id").references(() => adminUser.id),
  pickingStatus: text("picking_status"),
  packingStatus: text("packing_status"),
  notes: text(),
  blockedReason: text("blocked_reason"),
  preBlockedStatus: text("pre_blocked_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// shipment
// ---------------------------------------------------------------------------

export const shipment = pgTable("shipment", {
  id: uuid().defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => order.id),
  shipmentNumber: text("shipment_number").notNull(),
  status: text().notNull().default("draft"),
  carrier: text(),
  serviceLevel: text("service_level"),
  shippingProvider: text("shipping_provider"),
  trackingNumber: text("tracking_number"),
  trackingUrl: text("tracking_url"),
  labelUrl: text("label_url"),
  labelPurchasedAt: timestamp("label_purchased_at", { withTimezone: true }),
  shippedAt: timestamp("shipped_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// shipment_package
// ---------------------------------------------------------------------------

export const shipmentPackage = pgTable("shipment_package", {
  id: uuid().defaultRandom().primaryKey(),
  shipmentId: uuid("shipment_id")
    .notNull()
    .references(() => shipment.id),
  weight: numeric({ precision: 10, scale: 4 }),
  dimensionsJson: jsonb("dimensions_json"),
  packageType: text("package_type"),
  labelUrl: text("label_url"),
});

// ---------------------------------------------------------------------------
// shipment_line
// ---------------------------------------------------------------------------

export const shipmentLine = pgTable("shipment_line", {
  id: uuid().defaultRandom().primaryKey(),
  shipmentId: uuid("shipment_id")
    .notNull()
    .references(() => shipment.id),
  orderLineId: uuid("order_line_id")
    .notNull()
    .references(() => orderLine.id),
  quantity: integer().notNull(),
});

// ---------------------------------------------------------------------------
// shipment_event
// ---------------------------------------------------------------------------

export const shipmentEvent = pgTable("shipment_event", {
  id: uuid().defaultRandom().primaryKey(),
  shipmentId: uuid("shipment_id")
    .notNull()
    .references(() => shipment.id),
  providerEventId: text("provider_event_id"),
  status: text().notNull(),
  description: text(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  rawPayloadJson: jsonb("raw_payload_json"),
});

// ---------------------------------------------------------------------------
// shipping_label_purchase
// ---------------------------------------------------------------------------

export const shippingLabelPurchase = pgTable("shipping_label_purchase", {
  id: uuid().defaultRandom().primaryKey(),
  shipmentId: uuid("shipment_id")
    .notNull()
    .references(() => shipment.id),
  providerLabelId: text("provider_label_id").notNull(),
  costMinor: integer("cost_minor").notNull(),
  currency: text().notNull().default("USD"),
  purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull(),
  rawPayloadJson: jsonb("raw_payload_json"),
});
