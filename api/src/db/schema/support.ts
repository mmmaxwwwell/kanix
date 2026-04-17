import { pgTable, uuid, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { customer } from "./customer.js";
import { order } from "./order.js";
import { shipment } from "./fulfillment.js";
import { adminUser } from "./admin.js";

// ---------------------------------------------------------------------------
// support_ticket
// ---------------------------------------------------------------------------

export const supportTicket = pgTable("support_ticket", {
  id: uuid().defaultRandom().primaryKey(),
  ticketNumber: text("ticket_number").notNull(),
  customerId: uuid("customer_id").references(() => customer.id),
  orderId: uuid("order_id").references(() => order.id),
  shipmentId: uuid("shipment_id").references(() => shipment.id),
  subject: text().notNull(),
  category: text().notNull(),
  priority: text().notNull().default("normal"),
  status: text().notNull().default("open"),
  source: text().notNull(),
  potentialDuplicate: boolean("potential_duplicate").notNull().default(false),
  linkedTicketId: uuid("linked_ticket_id"),
  duplicateDismissed: boolean("duplicate_dismissed").notNull().default(false),
  mergedIntoTicketId: uuid("merged_into_ticket_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// support_ticket_message
// ---------------------------------------------------------------------------

export const supportTicketMessage = pgTable("support_ticket_message", {
  id: uuid().defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => supportTicket.id),
  authorType: text("author_type").notNull(),
  customerId: uuid("customer_id").references(() => customer.id),
  adminUserId: uuid("admin_user_id").references(() => adminUser.id),
  body: text().notNull(),
  isInternalNote: boolean("is_internal_note").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// support_ticket_attachment
// ---------------------------------------------------------------------------

export const supportTicketAttachment = pgTable("support_ticket_attachment", {
  id: uuid().defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => supportTicket.id),
  messageId: uuid("message_id").references(() => supportTicketMessage.id),
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// support_ticket_status_history
// ---------------------------------------------------------------------------

export const supportTicketStatusHistory = pgTable("support_ticket_status_history", {
  id: uuid().defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => supportTicket.id),
  oldStatus: text("old_status").notNull(),
  newStatus: text("new_status").notNull(),
  actorAdminUserId: uuid("actor_admin_user_id").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
