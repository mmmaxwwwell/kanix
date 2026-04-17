import { pgTable, uuid, text, integer, primaryKey } from "drizzle-orm/pg-core";
import { product } from "./catalog.js";

// ---------------------------------------------------------------------------
// product_class
// ---------------------------------------------------------------------------

export const productClass = pgTable("product_class", {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull(),
  slug: text().notNull(),
  description: text(),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ---------------------------------------------------------------------------
// product_class_membership
// ---------------------------------------------------------------------------

export const productClassMembership = pgTable(
  "product_class_membership",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    productClassId: uuid("product_class_id")
      .notNull()
      .references(() => productClass.id),
  },
  (t) => [primaryKey({ columns: [t.productId, t.productClassId] })],
);

// ---------------------------------------------------------------------------
// kit_definition
// ---------------------------------------------------------------------------

export const kitDefinition = pgTable("kit_definition", {
  id: uuid().defaultRandom().primaryKey(),
  slug: text().notNull(),
  title: text().notNull(),
  description: text(),
  priceMinor: integer("price_minor").notNull(),
  currency: text().notNull().default("USD"),
  status: text().notNull().default("draft"),
});

// ---------------------------------------------------------------------------
// kit_class_requirement
// ---------------------------------------------------------------------------

export const kitClassRequirement = pgTable(
  "kit_class_requirement",
  {
    kitDefinitionId: uuid("kit_definition_id")
      .notNull()
      .references(() => kitDefinition.id),
    productClassId: uuid("product_class_id")
      .notNull()
      .references(() => productClass.id),
    quantity: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.kitDefinitionId, t.productClassId] })],
);
