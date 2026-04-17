/**
 * Seed script — populates dev database with sample data.
 *
 * Idempotent: uses ON CONFLICT DO NOTHING so it can be run multiple times.
 *
 * Usage: pnpm db:seed
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import {
  product,
  productVariant,
  productClass,
  productClassMembership,
  kitDefinition,
  kitClassRequirement,
  adminUser,
  adminRole,
  adminUserRole,
  inventoryLocation,
  inventoryBalance,
} from "../schema/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kanix:kanix@localhost:5432/kanix";

function required<T>(value: T | undefined | null, label: string): T {
  if (value == null) throw new Error(`Seed data missing: ${label}`);
  return value;
}

async function seed() {
  const sql = postgres(DATABASE_URL);
  const db = drizzle(sql);

  console.log("Seeding database…");

  // -----------------------------------------------------------------------
  // 1. Product classes: plates, modules, belts
  // -----------------------------------------------------------------------
  const classRows = [
    {
      name: "Plates",
      slug: "plates",
      description: "Base plates and mounting plates",
      sortOrder: 1,
    },
    { name: "Modules", slug: "modules", description: "Functional add-on modules", sortOrder: 2 },
    { name: "Belts", slug: "belts", description: "Timing belts and drive belts", sortOrder: 3 },
  ];

  await db.insert(productClass).values(classRows).onConflictDoNothing();

  // Fetch classes back for FK references
  const classes = await db.select().from(productClass);
  const classMap = Object.fromEntries(classes.map((c) => [c.slug, c.id]));

  console.log(`  Product classes: ${classes.length}`);

  // -----------------------------------------------------------------------
  // 2. Products (5) with TPU/PA11/TPC variants
  // -----------------------------------------------------------------------
  const materials = ["TPU", "PA11", "TPC"] as const;

  const productsData = [
    {
      slug: "base-plate-100",
      title: "Base Plate 100mm",
      description: "100mm base plate for modular builds",
      classSlug: "plates",
      basePrice: 1999,
    },
    {
      slug: "base-plate-200",
      title: "Base Plate 200mm",
      description: "200mm base plate for larger assemblies",
      classSlug: "plates",
      basePrice: 3499,
    },
    {
      slug: "hinge-module",
      title: "Hinge Module",
      description: "Universal hinge module with 180° range",
      classSlug: "modules",
      basePrice: 1499,
    },
    {
      slug: "clip-module",
      title: "Clip Module",
      description: "Quick-release clip module",
      classSlug: "modules",
      basePrice: 999,
    },
    {
      slug: "drive-belt-gt2",
      title: "Drive Belt GT2",
      description: "GT2 timing belt for linear motion",
      classSlug: "belts",
      basePrice: 2499,
    },
  ];

  for (const p of productsData) {
    // Insert product (idempotent via slug conflict — slug has unique constraint)
    const [inserted] = await db
      .insert(product)
      .values({
        slug: p.slug,
        title: p.title,
        description: p.description,
        status: "active",
      })
      .onConflictDoNothing()
      .returning({ id: product.id });

    // If already existed, look it up
    const productId =
      inserted?.id ??
      (await db
        .select({ id: product.id })
        .from(product)
        .where(eq(product.slug, p.slug))
        .then((rows) => required(rows[0], `product ${p.slug}`).id));

    // Class membership
    await db
      .insert(productClassMembership)
      .values({
        productId,
        productClassId: required(classMap[p.classSlug], `class ${p.classSlug}`),
      })
      .onConflictDoNothing();

    // Variants per material
    for (const mat of materials) {
      await db
        .insert(productVariant)
        .values({
          productId,
          sku: `${p.slug}-${mat.toLowerCase()}`,
          title: `${p.title} (${mat})`,
          optionValuesJson: { material: mat },
          priceMinor: p.basePrice,
          status: "active",
        })
        .onConflictDoNothing();
    }
  }

  const allProducts = await db.select().from(product);
  const allVariants = await db.select().from(productVariant);
  console.log(`  Products: ${allProducts.length}`);
  console.log(`  Variants: ${allVariants.length}`);

  // -----------------------------------------------------------------------
  // 3. Kit definition (starter kit)
  // -----------------------------------------------------------------------
  await db
    .insert(kitDefinition)
    .values({
      slug: "starter-kit",
      title: "Starter Kit",
      description: "Everything you need to get started — one plate, one module, and one belt",
      priceMinor: 4999,
      status: "active",
    })
    .onConflictDoNothing();

  const kits = await db.select().from(kitDefinition);
  const starterKit = required(
    kits.find((k) => k.slug === "starter-kit"),
    "starter-kit",
  );

  // Kit requires one of each class
  for (const classSlug of ["plates", "modules", "belts"]) {
    await db
      .insert(kitClassRequirement)
      .values({
        kitDefinitionId: starterKit.id,
        productClassId: required(classMap[classSlug], `class ${classSlug}`),
        quantity: 1,
      })
      .onConflictDoNothing();
  }

  console.log(`  Kit definitions: ${kits.length}`);

  // -----------------------------------------------------------------------
  // 4. Inventory location (default warehouse)
  // -----------------------------------------------------------------------
  await db
    .insert(inventoryLocation)
    .values({
      name: "Default Warehouse",
      code: "WH-DEFAULT",
      type: "warehouse",
      addressJson: {
        line1: "123 Industrial Blvd",
        city: "Portland",
        state: "OR",
        zip: "97201",
        country: "US",
      },
      isActive: true,
    })
    .onConflictDoNothing();

  const locations = await db.select().from(inventoryLocation);
  const warehouse = required(
    locations.find((l) => l.code === "WH-DEFAULT"),
    "WH-DEFAULT location",
  );
  console.log(`  Inventory locations: ${locations.length}`);

  // -----------------------------------------------------------------------
  // 5. Inventory balances (50 units each variant)
  // -----------------------------------------------------------------------
  for (const v of allVariants) {
    await db
      .insert(inventoryBalance)
      .values({
        variantId: v.id,
        locationId: warehouse.id,
        onHand: 50,
        reserved: 0,
        available: 50,
        safetyStock: 5,
      })
      .onConflictDoNothing();
  }

  const balances = await db.select().from(inventoryBalance);
  console.log(`  Inventory balances: ${balances.length}`);

  // -----------------------------------------------------------------------
  // 6. Admin user with super_admin role
  // -----------------------------------------------------------------------
  await db
    .insert(adminRole)
    .values({ name: "super_admin", description: "Full system access" })
    .onConflictDoNothing();

  const roles = await db.select().from(adminRole);
  const superAdminRole = required(
    roles.find((r) => r.name === "super_admin"),
    "super_admin role",
  );

  await db
    .insert(adminUser)
    .values({
      authSubject: "dev-admin-001",
      email: "admin@kanix.dev",
      name: "Dev Admin",
      status: "active",
    })
    .onConflictDoNothing();

  const users = await db.select().from(adminUser);
  const devAdmin = required(
    users.find((u) => u.email === "admin@kanix.dev"),
    "dev admin user",
  );

  await db
    .insert(adminUserRole)
    .values({ adminUserId: devAdmin.id, adminRoleId: superAdminRole.id })
    .onConflictDoNothing();

  console.log(`  Admin users: ${users.length}`);
  console.log(`  Admin roles: ${roles.length}`);

  // -----------------------------------------------------------------------
  // Done
  // -----------------------------------------------------------------------
  console.log("Seed complete.");
  await sql.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
