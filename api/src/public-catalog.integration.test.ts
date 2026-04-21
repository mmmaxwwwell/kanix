import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { product, productVariant, productMedia } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { productClass, productClassMembership } from "./db/schema/product-class.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

async function signUpUser(address: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${address}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  const body = (await res.json()) as { status: string; user?: { id: string } };
  if (body.status !== "OK" || !body.user) {
    throw new Error(`Signup failed: ${JSON.stringify(body)}`);
  }
  return body.user.id;
}

interface CatalogVariant {
  id: string;
  sku: string;
  title: string;
  optionValuesJson: unknown;
  priceMinor: number;
  currency: string;
  weight: string | null;
  dimensionsJson: unknown;
  status: string;
  available: number;
  inStock: boolean;
}

interface CatalogMedia {
  id: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  variantId: string | null;
}

interface CatalogProduct {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  brand: string | null;
  media: CatalogMedia[];
  variants: CatalogVariant[];
}

describe("public catalog API (T044)", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  const ts = Date.now();
  const adminEmail = `test-catalog-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  // IDs for cleanup
  let adminUserId = "";
  let testRoleId = "";

  // Test data IDs
  let activeProductId = "";
  let draftProductId = "";
  let archivedProductId = "";
  let activeVariantId = "";
  let outOfStockVariantId = "";
  let mediaId = "";
  let locationId = "";
  let testClassId = "";

  const activeSlug = `test-active-product-${ts}`;
  const draftSlug = `test-draft-product-${ts}`;
  const archivedSlug = `test-archived-product-${ts}`;

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

    // Create admin user for seeding data via admin API
    const authSubject = await signUpUser(address, adminEmail, adminPassword);
    const [role] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_catalog_super_admin_${ts}`,
        description: "Test catalog super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [admin] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Catalog Admin",
        status: "active",
      })
      .returning();
    adminUserId = admin.id;

    await dbConn.db.insert(adminUserRole).values({
      adminUserId: admin.id,
      adminRoleId: role.id,
    });

    // --- Seed test data ---

    // 0. Product class (needed for public catalog filtering)
    const [testClass] = await dbConn.db
      .insert(productClass)
      .values({
        name: `Test Class ${ts}`,
        slug: `test-class-${ts}`,
        sortOrder: 0,
      })
      .returning();
    testClassId = testClass.id;

    // 1. Active product with active variant (in stock) + draft variant + out-of-stock variant + media
    const [activeProd] = await dbConn.db
      .insert(product)
      .values({
        slug: activeSlug,
        title: "Active Test Product",
        subtitle: "A test subtitle",
        description: "A test description",
        status: "active",
        brand: "Kanix",
      })
      .returning();
    activeProductId = activeProd.id;

    // Add class membership so it appears in public catalog
    await dbConn.db.insert(productClassMembership).values({
      productId: activeProductId,
      productClassId: testClassId,
    });

    const [activeVar] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: activeProductId,
        sku: `SKU-ACTIVE-${ts}`,
        title: "TPU Variant",
        optionValuesJson: { material: "TPU" },
        priceMinor: 2999,
        currency: "USD",
        status: "active",
      })
      .returning();
    activeVariantId = activeVar.id;

    // Draft variant — should NOT appear in public API
    await dbConn.db.insert(productVariant).values({
      productId: activeProductId,
      sku: `SKU-DRAFT-${ts}`,
      title: "Draft Variant",
      optionValuesJson: { material: "PA11" },
      priceMinor: 4999,
      currency: "USD",
      status: "draft",
    });

    // Out-of-stock active variant — should appear but inStock = false
    const [oosVar] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: activeProductId,
        sku: `SKU-OOS-${ts}`,
        title: "TPC Variant",
        optionValuesJson: { material: "TPC" },
        priceMinor: 5999,
        currency: "USD",
        status: "active",
      })
      .returning();
    outOfStockVariantId = oosVar.id;

    // Media for the active product
    const [med] = await dbConn.db
      .insert(productMedia)
      .values({
        productId: activeProductId,
        url: "https://example.com/image1.jpg",
        altText: "Product image",
        sortOrder: 0,
      })
      .returning();
    mediaId = med.id;

    // Inventory: create location + balance for active variant (in stock)
    const [loc] = await dbConn.db
      .insert(inventoryLocation)
      .values({
        name: "Test Catalog Warehouse",
        code: `test-catalog-wh-${ts}`,
        type: "warehouse",
      })
      .returning();
    locationId = loc.id;

    await dbConn.db.insert(inventoryBalance).values({
      variantId: activeVariantId,
      locationId: locationId,
      onHand: 50,
      reserved: 5,
      available: 45,
      safetyStock: 10,
    });

    // Out-of-stock variant: balance with available = 0
    await dbConn.db.insert(inventoryBalance).values({
      variantId: outOfStockVariantId,
      locationId: locationId,
      onHand: 0,
      reserved: 0,
      available: 0,
      safetyStock: 5,
    });

    // 2. Draft product — should NOT appear in public API
    const [draftProd] = await dbConn.db
      .insert(product)
      .values({
        slug: draftSlug,
        title: "Draft Test Product",
        status: "draft",
      })
      .returning();
    draftProductId = draftProd.id;

    // 3. Archived product — should NOT appear in public API
    const [archivedProd] = await dbConn.db
      .insert(product)
      .values({
        slug: archivedSlug,
        title: "Archived Test Product",
        status: "archived",
      })
      .returning();
    archivedProductId = archivedProd.id;
  }, 30000);

  afterAll(async () => {
    try {
      // Cleanup in reverse dependency order
      await dbConn.db
        .delete(inventoryBalance)
        .where(eq(inventoryBalance.variantId, activeVariantId));
      await dbConn.db
        .delete(inventoryBalance)
        .where(eq(inventoryBalance.variantId, outOfStockVariantId));
      await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, locationId));
      await dbConn.db.delete(productMedia).where(eq(productMedia.id, mediaId));
      await dbConn.db
        .delete(productClassMembership)
        .where(eq(productClassMembership.productId, activeProductId));
      await dbConn.db.delete(productVariant).where(eq(productVariant.productId, activeProductId));
      await dbConn.db.delete(product).where(eq(product.id, activeProductId));
      await dbConn.db.delete(product).where(eq(product.id, draftProductId));
      await dbConn.db.delete(product).where(eq(product.id, archivedProductId));
      await dbConn.db.delete(productClass).where(eq(productClass.id, testClassId));
      await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
      await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUserId));
      await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
    } catch {
      // best-effort cleanup
    }
    await stopTestServer(ts_);
  });

  it("GET /api/products returns only active products (no auth required)", async () => {
    const res = await fetch(`${address}/api/products`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { products: CatalogProduct[] };
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.products.length).toBeGreaterThanOrEqual(1);

    // Active product should be present with correct top-level fields
    const activeProduct = body.products.find((p) => p.slug === activeSlug);
    expect(activeProduct).not.toBeUndefined();
    expect(activeProduct!.id).toBe(activeProductId);
    expect(activeProduct!.title).toBe("Active Test Product");
    expect(activeProduct!.subtitle).toBe("A test subtitle");
    expect(activeProduct!.description).toBe("A test description");
    expect(activeProduct!.brand).toBe("Kanix");

    // Draft and archived products should NOT be present
    expect(body.products.find((p) => p.slug === draftSlug)).toBeUndefined();
    expect(body.products.find((p) => p.slug === archivedSlug)).toBeUndefined();
  });

  it("GET /api/products returns products with variants, media, and pricing", async () => {
    const res = await fetch(`${address}/api/products`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { products: CatalogProduct[] };
    const activeProduct = body.products.find((p) => p.slug === activeSlug);
    expect(activeProduct).not.toBeUndefined();

    // Should include exactly 2 active variants (not the draft)
    expect(activeProduct!.variants.length).toBe(2);
    expect(activeProduct!.variants.find((v) => v.sku === `SKU-DRAFT-${ts}`)).toBeUndefined();

    // In-stock variant: assert every field
    const inStockVariant = activeProduct!.variants.find((v) => v.sku === `SKU-ACTIVE-${ts}`);
    expect(inStockVariant).not.toBeUndefined();
    expect(inStockVariant!.id).toBe(activeVariantId);
    expect(inStockVariant!.title).toBe("TPU Variant");
    expect(inStockVariant!.priceMinor).toBe(2999);
    expect(inStockVariant!.currency).toBe("USD");
    expect(inStockVariant!.status).toBe("active");
    expect(inStockVariant!.available).toBe(45);
    expect(inStockVariant!.inStock).toBe(true);
    expect(inStockVariant!.optionValuesJson).toEqual({ material: "TPU" });

    // Out-of-stock variant: assert every field
    const oosVariant = activeProduct!.variants.find((v) => v.sku === `SKU-OOS-${ts}`);
    expect(oosVariant).not.toBeUndefined();
    expect(oosVariant!.id).toBe(outOfStockVariantId);
    expect(oosVariant!.title).toBe("TPC Variant");
    expect(oosVariant!.priceMinor).toBe(5999);
    expect(oosVariant!.currency).toBe("USD");
    expect(oosVariant!.status).toBe("active");
    expect(oosVariant!.available).toBe(0);
    expect(oosVariant!.inStock).toBe(false);
    expect(oosVariant!.optionValuesJson).toEqual({ material: "TPC" });

    // Media: assert exact count and all fields
    expect(activeProduct!.media.length).toBe(1);
    expect(activeProduct!.media[0].id).toBe(mediaId);
    expect(activeProduct!.media[0].url).toBe("https://example.com/image1.jpg");
    expect(activeProduct!.media[0].altText).toBe("Product image");
    expect(activeProduct!.media[0].sortOrder).toBe(0);
  });

  it("GET /api/products/:slug returns full product detail with all fields", async () => {
    const res = await fetch(`${address}/api/products/${activeSlug}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { product: CatalogProduct };

    // Top-level product fields
    expect(body.product.id).toBe(activeProductId);
    expect(body.product.slug).toBe(activeSlug);
    expect(body.product.title).toBe("Active Test Product");
    expect(body.product.subtitle).toBe("A test subtitle");
    expect(body.product.description).toBe("A test description");
    expect(body.product.brand).toBe("Kanix");

    // Exactly 2 active variants (draft excluded)
    expect(body.product.variants.length).toBe(2);

    // In-stock variant: every field asserted
    const inStockVariant = body.product.variants.find((v) => v.sku === `SKU-ACTIVE-${ts}`);
    expect(inStockVariant).not.toBeUndefined();
    expect(inStockVariant!.id).toBe(activeVariantId);
    expect(inStockVariant!.title).toBe("TPU Variant");
    expect(inStockVariant!.priceMinor).toBe(2999);
    expect(inStockVariant!.currency).toBe("USD");
    expect(inStockVariant!.status).toBe("active");
    expect(inStockVariant!.available).toBe(45);
    expect(inStockVariant!.inStock).toBe(true);
    expect(inStockVariant!.optionValuesJson).toEqual({ material: "TPU" });

    // Out-of-stock variant: every field asserted
    const oosVariant = body.product.variants.find((v) => v.sku === `SKU-OOS-${ts}`);
    expect(oosVariant).not.toBeUndefined();
    expect(oosVariant!.id).toBe(outOfStockVariantId);
    expect(oosVariant!.title).toBe("TPC Variant");
    expect(oosVariant!.priceMinor).toBe(5999);
    expect(oosVariant!.currency).toBe("USD");
    expect(oosVariant!.status).toBe("active");
    expect(oosVariant!.available).toBe(0);
    expect(oosVariant!.inStock).toBe(false);
    expect(oosVariant!.optionValuesJson).toEqual({ material: "TPC" });

    // Media: exact count and all fields
    expect(body.product.media.length).toBe(1);
    expect(body.product.media[0].id).toBe(mediaId);
    expect(body.product.media[0].url).toBe("https://example.com/image1.jpg");
    expect(body.product.media[0].altText).toBe("Product image");
    expect(body.product.media[0].sortOrder).toBe(0);
  });

  it("GET /api/products/:slug flags out-of-stock variant correctly", async () => {
    const res = await fetch(`${address}/api/products/${activeSlug}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { product: CatalogProduct };

    const oosVariant = body.product.variants.find((v) => v.sku === `SKU-OOS-${ts}`);
    expect(oosVariant).not.toBeUndefined();
    expect(oosVariant!.available).toBe(0);
    expect(oosVariant!.inStock).toBe(false);

    // In-stock variant should have inStock = true
    const inStockVariant = body.product.variants.find((v) => v.sku === `SKU-ACTIVE-${ts}`);
    expect(inStockVariant).not.toBeUndefined();
    expect(inStockVariant!.available).toBe(45);
    expect(inStockVariant!.inStock).toBe(true);
  });

  it("GET /api/products/:slug returns 404 for non-existent product", async () => {
    const res = await fetch(`${address}/api/products/non-existent-slug-${ts}`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_NOT_FOUND");
    expect(body.message).toBe("Product not found");
  });

  it("GET /api/products/:slug returns 404 for draft product", async () => {
    const res = await fetch(`${address}/api/products/${draftSlug}`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_NOT_FOUND");
    expect(body.message).toBe("Product not found");
  });

  it("GET /api/products/:slug returns 404 for archived product", async () => {
    const res = await fetch(`${address}/api/products/${archivedSlug}`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_NOT_FOUND");
    expect(body.message).toBe("Product not found");
  });
});
