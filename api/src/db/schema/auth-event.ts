import { pgTable, uuid, text, timestamp, inet, jsonb } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// auth_event_log
// ---------------------------------------------------------------------------

export const authEventLog = pgTable("auth_event_log", {
  id: uuid().defaultRandom().primaryKey(),
  eventType: text("event_type").notNull(),
  actorId: text("actor_id").notNull(),
  ipAddress: inet("ip_address"),
  userAgent: text("user_agent"),
  metadataJson: jsonb("metadata_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
