import { pgTable, uuid, text, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { customer } from "./customer.js";
import { productVariant } from "./catalog.js";
import { kitDefinition, productClass } from "./product-class.js";

// ---------------------------------------------------------------------------
// cart
// ---------------------------------------------------------------------------

export const cart = pgTable("cart", {
  id: uuid().defaultRandom().primaryKey(),
  token: uuid().defaultRandom().notNull(),
  customerId: uuid("customer_id").references(() => customer.id),
  status: text().notNull().default("active"),
  currency: text().notNull().default("USD"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// cart_line
// ---------------------------------------------------------------------------

export const cartLine = pgTable("cart_line", {
  id: uuid().defaultRandom().primaryKey(),
  cartId: uuid("cart_id")
    .notNull()
    .references(() => cart.id),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => productVariant.id),
  quantity: integer().notNull(),
  unitPriceMinor: integer("unit_price_minor").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// cart_kit_selection
// ---------------------------------------------------------------------------

export const cartKitSelection = pgTable(
  "cart_kit_selection",
  {
    cartLineId: uuid("cart_line_id")
      .notNull()
      .references(() => cartLine.id),
    kitDefinitionId: uuid("kit_definition_id")
      .notNull()
      .references(() => kitDefinition.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariant.id),
    productClassId: uuid("product_class_id")
      .notNull()
      .references(() => productClass.id),
  },
  (t) => [
    unique("uq_cart_kit_selection").on(
      t.cartLineId,
      t.kitDefinitionId,
      t.productClassId,
      t.variantId,
    ),
  ],
);
