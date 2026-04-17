import { pgTable, uuid, text, timestamp, boolean } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// customer
// ---------------------------------------------------------------------------

export const customer = pgTable("customer", {
  id: uuid().defaultRandom().primaryKey(),
  authSubject: text("auth_subject").notNull(),
  email: text().notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  phone: text(),
  status: text().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// customer_address
// ---------------------------------------------------------------------------

export const customerAddress = pgTable("customer_address", {
  id: uuid().defaultRandom().primaryKey(),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customer.id),
  type: text().notNull(),
  fullName: text("full_name").notNull(),
  phone: text(),
  line1: text().notNull(),
  line2: text(),
  city: text().notNull(),
  state: text().notNull(),
  postalCode: text("postal_code").notNull(),
  country: text().notNull().default("US"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
