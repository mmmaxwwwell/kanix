import { pgTable, uuid, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { order } from "./order.js";
import { payment, dispute } from "./payment.js";
import { shipment } from "./fulfillment.js";
import { supportTicket } from "./support.js";

// ---------------------------------------------------------------------------
// evidence_record
// ---------------------------------------------------------------------------

export const evidenceRecord = pgTable("evidence_record", {
  id: uuid().defaultRandom().primaryKey(),
  orderId: uuid("order_id").references(() => order.id),
  paymentId: uuid("payment_id").references(() => payment.id),
  shipmentId: uuid("shipment_id").references(() => shipment.id),
  disputeId: uuid("dispute_id").references(() => dispute.id),
  supportTicketId: uuid("support_ticket_id").references(() => supportTicket.id),
  type: text().notNull(),
  storageKey: text("storage_key"),
  textContent: text("text_content"),
  metadataJson: jsonb("metadata_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// evidence_bundle
// ---------------------------------------------------------------------------

export const evidenceBundle = pgTable("evidence_bundle", {
  id: uuid().defaultRandom().primaryKey(),
  disputeId: uuid("dispute_id")
    .notNull()
    .references(() => dispute.id),
  status: text().notNull().default("generating"),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  storageKey: text("storage_key"),
  metadataJson: jsonb("metadata_json"),
});

// ---------------------------------------------------------------------------
// policy_snapshot
// ---------------------------------------------------------------------------

export const policySnapshot = pgTable("policy_snapshot", {
  id: uuid().defaultRandom().primaryKey(),
  policyType: text("policy_type").notNull(),
  version: integer().notNull(),
  contentHtml: text("content_html").notNull(),
  contentText: text("content_text").notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------------------
// order_policy_acknowledgment
// ---------------------------------------------------------------------------

export const orderPolicyAcknowledgment = pgTable("order_policy_acknowledgment", {
  id: uuid().defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => order.id),
  policySnapshotId: uuid("policy_snapshot_id")
    .notNull()
    .references(() => policySnapshot.id),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull(),
  contextJson: jsonb("context_json"),
});
