import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// product
// ---------------------------------------------------------------------------

export const product = pgTable("product", {
  id: uuid().defaultRandom().primaryKey(),
  slug: text().notNull(),
  title: text().notNull(),
  subtitle: text(),
  description: text(),
  status: text().notNull().default("draft"),
  brand: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// product_variant
// ---------------------------------------------------------------------------

export const productVariant = pgTable("product_variant", {
  id: uuid().defaultRandom().primaryKey(),
  productId: uuid("product_id")
    .notNull()
    .references(() => product.id),
  sku: text().notNull(),
  title: text().notNull(),
  optionValuesJson: jsonb("option_values_json").notNull().default({}),
  priceMinor: integer("price_minor").notNull(),
  currency: text().notNull().default("USD"),
  weight: numeric({ precision: 10, scale: 4 }),
  dimensionsJson: jsonb("dimensions_json"),
  barcode: text(),
  status: text().notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// product_media
// ---------------------------------------------------------------------------

export const productMedia = pgTable("product_media", {
  id: uuid().defaultRandom().primaryKey(),
  productId: uuid("product_id")
    .notNull()
    .references(() => product.id),
  variantId: uuid("variant_id").references(() => productVariant.id),
  url: text().notNull(),
  altText: text("alt_text"),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ---------------------------------------------------------------------------
// collection
// ---------------------------------------------------------------------------

export const collection = pgTable("collection", {
  id: uuid().defaultRandom().primaryKey(),
  slug: text().notNull(),
  title: text().notNull(),
  description: text(),
  status: text().notNull().default("draft"),
});

// ---------------------------------------------------------------------------
// collection_product
// ---------------------------------------------------------------------------

export const collectionProduct = pgTable(
  "collection_product",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collection.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.productId] })],
);
