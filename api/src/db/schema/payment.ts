import { pgTable, uuid, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { order } from "./order.js";
import { adminUser } from "./admin.js";

// ---------------------------------------------------------------------------
// payment
// ---------------------------------------------------------------------------

export const payment = pgTable("payment", {
  id: uuid().defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => order.id),
  provider: text().notNull().default("stripe"),
  providerPaymentIntentId: text("provider_payment_intent_id").notNull(),
  providerChargeId: text("provider_charge_id"),
  status: text().notNull().default("pending"),
  amountMinor: integer("amount_minor").notNull(),
  currency: text().notNull().default("USD"),
  paymentMethodType: text("payment_method_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// payment_event
// ---------------------------------------------------------------------------

export const paymentEvent = pgTable("payment_event", {
  id: uuid().defaultRandom().primaryKey(),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => payment.id),
  providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: jsonb("payload_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// refund
// ---------------------------------------------------------------------------

export const refund = pgTable("refund", {
  id: uuid().defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => order.id),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => payment.id),
  providerRefundId: text("provider_refund_id"),
  amountMinor: integer("amount_minor").notNull(),
  reason: text().notNull(),
  status: text().notNull().default("pending"),
  actorAdminUserId: uuid("actor_admin_user_id").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// dispute
// ---------------------------------------------------------------------------

export const dispute = pgTable("dispute", {
  id: uuid().defaultRandom().primaryKey(),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => payment.id),
  orderId: uuid("order_id")
    .notNull()
    .references(() => order.id),
  providerDisputeId: text("provider_dispute_id").notNull(),
  reason: text(),
  amountMinor: integer("amount_minor").notNull(),
  currency: text().notNull().default("USD"),
  status: text().notNull().default("opened"),
  dueBy: timestamp("due_by", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});
