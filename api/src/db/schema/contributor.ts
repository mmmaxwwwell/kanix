import { pgTable, uuid, text, timestamp, integer } from "drizzle-orm/pg-core";
import { customer } from "./customer.js";
import { product } from "./catalog.js";
import { orderLine } from "./order.js";

// ---------------------------------------------------------------------------
// contributor
// ---------------------------------------------------------------------------

export const contributor = pgTable("contributor", {
  id: uuid().defaultRandom().primaryKey(),
  githubUsername: text("github_username").notNull(),
  githubUserId: text("github_user_id").notNull(),
  customerId: uuid("customer_id").references(() => customer.id),
  claAcceptedAt: timestamp("cla_accepted_at", { withTimezone: true }),
  status: text().notNull().default("pending"),
});

// ---------------------------------------------------------------------------
// contributor_design
// ---------------------------------------------------------------------------

export const contributorDesign = pgTable("contributor_design", {
  id: uuid().defaultRandom().primaryKey(),
  contributorId: uuid("contributor_id")
    .notNull()
    .references(() => contributor.id),
  productId: uuid("product_id")
    .notNull()
    .references(() => product.id),
  salesCount: integer("sales_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// contributor_royalty
// ---------------------------------------------------------------------------

export const contributorRoyalty = pgTable("contributor_royalty", {
  id: uuid().defaultRandom().primaryKey(),
  contributorId: uuid("contributor_id")
    .notNull()
    .references(() => contributor.id),
  orderLineId: uuid("order_line_id")
    .notNull()
    .references(() => orderLine.id),
  amountMinor: integer("amount_minor").notNull(),
  currency: text().notNull().default("USD"),
  status: text().notNull().default("accrued"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// contributor_milestone
// ---------------------------------------------------------------------------

export const contributorMilestone = pgTable("contributor_milestone", {
  id: uuid().defaultRandom().primaryKey(),
  contributorId: uuid("contributor_id")
    .notNull()
    .references(() => contributor.id),
  milestoneType: text("milestone_type").notNull(),
  reachedAt: timestamp("reached_at", { withTimezone: true }).notNull(),
  fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
  notes: text(),
});

// ---------------------------------------------------------------------------
// contributor_tax_document
// ---------------------------------------------------------------------------

export const contributorTaxDocument = pgTable("contributor_tax_document", {
  id: uuid().defaultRandom().primaryKey(),
  contributorId: uuid("contributor_id")
    .notNull()
    .references(() => contributor.id),
  documentType: text("document_type").notNull(),
  storageKey: text("storage_key").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
  status: text().notNull().default("pending_review"),
});

// ---------------------------------------------------------------------------
// contributor_payout
// ---------------------------------------------------------------------------

export const contributorPayout = pgTable("contributor_payout", {
  id: uuid().defaultRandom().primaryKey(),
  contributorId: uuid("contributor_id")
    .notNull()
    .references(() => contributor.id),
  amountMinor: integer("amount_minor").notNull(),
  currency: text().notNull().default("USD"),
  payoutMethod: text("payout_method").notNull(),
  status: text().notNull().default("pending"),
  initiatedAt: timestamp("initiated_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// contributor_donation
// ---------------------------------------------------------------------------

export const contributorDonation = pgTable("contributor_donation", {
  id: uuid().defaultRandom().primaryKey(),
  contributorId: uuid("contributor_id")
    .notNull()
    .references(() => contributor.id),
  charityName: text("charity_name").notNull(),
  charityEin: text("charity_ein").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: text().notNull().default("USD"),
  status: text().notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
