import { pgTable, uuid, text, timestamp, inet, jsonb, primaryKey } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// admin_user
// ---------------------------------------------------------------------------

export const adminUser = pgTable("admin_user", {
  id: uuid().defaultRandom().primaryKey(),
  authSubject: text("auth_subject").notNull(),
  email: text().notNull(),
  name: text().notNull(),
  status: text().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// admin_role
// ---------------------------------------------------------------------------

export const adminRole = pgTable("admin_role", {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull(),
  description: text(),
});

// ---------------------------------------------------------------------------
// admin_user_role
// ---------------------------------------------------------------------------

export const adminUserRole = pgTable(
  "admin_user_role",
  {
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => adminUser.id),
    adminRoleId: uuid("admin_role_id")
      .notNull()
      .references(() => adminRole.id),
  },
  (t) => [primaryKey({ columns: [t.adminUserId, t.adminRoleId] })],
);

// ---------------------------------------------------------------------------
// admin_audit_log
// ---------------------------------------------------------------------------

export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid().defaultRandom().primaryKey(),
  actorAdminUserId: uuid("actor_admin_user_id")
    .notNull()
    .references(() => adminUser.id),
  action: text().notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  beforeJson: jsonb("before_json"),
  afterJson: jsonb("after_json"),
  ipAddress: inet("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
