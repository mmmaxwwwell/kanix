import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// admin_setting — key-value configuration store
// ---------------------------------------------------------------------------

export const adminSetting = pgTable("admin_setting", {
  key: text().primaryKey(),
  valueJson: jsonb("value_json").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
