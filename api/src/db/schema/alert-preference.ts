import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { adminUser } from "./admin.js";

// ---------------------------------------------------------------------------
// admin_alert_preference — per-admin notification channel config
// ---------------------------------------------------------------------------

export const adminAlertPreference = pgTable("admin_alert_preference", {
  id: uuid().defaultRandom().primaryKey(),
  adminUserId: uuid("admin_user_id")
    .notNull()
    .references(() => adminUser.id)
    .unique(),
  channel: text().notNull().default("both"), // "email" | "push" | "both"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
