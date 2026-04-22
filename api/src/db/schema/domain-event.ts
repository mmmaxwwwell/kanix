import { pgTable, uuid, text, timestamp, jsonb, bigint } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// domain_event — persistent audit log for all domain events
// ---------------------------------------------------------------------------

export const domainEvent = pgTable("domain_event", {
  id: uuid().defaultRandom().primaryKey(),
  eventType: text("event_type").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  payloadJson: jsonb("payload_json").notNull(),
  customerId: uuid("customer_id"),
  sequenceId: bigint("sequence_id", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
