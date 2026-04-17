import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { product, productVariant, productMedia } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const SUPERTOKENS_URI = process.env["SUPERTOKENS_CONNECTION_URI"] ?? "http://localhost:3567";

async function isSuperTokensUp(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPERTOKENS_URI}/hello`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: DATABASE_URL ?? "postgres://localhost/test",
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "whsec_xxx",
    STRIPE_TAX_ENABLED: false,
    SUPERTOKENS_API_KEY: "test-key",
    SUPERTOKENS_CONNECTION_URI: SUPERTOKENS_URI,
    EASYPOST_API_KEY: "test-key",
    EASYPOST_WEBHOOK_SECRET: "",
    GITHUB_OAUTH_CLIENT_ID: "test-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW_MS: 60000,
    ...overrides,
  };
}

function createFakeProcess(): EventEmitter {
  return new EventEmitter();
}

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

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("public catalog API (T044)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;

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

  const activeSlug = `test-active-product-${ts}`;
  const draftSlug = `test-draft-product-${ts}`;
  const archivedSlug = `test-archived-product-${ts}`;

  beforeAll(async () => {
    superTokensAvailable = await isSuperTokensUp();
    if (!superTokensAvailable) return;

    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      reservationCleanupIntervalMs: 0,
    });
    address = await server.start();
    markReady();
    app = server.app;

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
    markNotReady();
    if (dbConn) {
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
        await dbConn.db.delete(productVariant).where(eq(productVariant.productId, activeProductId));
        await dbConn.db.delete(product).where(eq(product.id, activeProductId));
        await dbConn.db.delete(product).where(eq(product.id, draftProductId));
        await dbConn.db.delete(product).where(eq(product.id, archivedProductId));
        await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
        await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUserId));
        await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
      } catch {
        // best-effort cleanup
      }
      await dbConn.close();
    }
    if (app) await app.close();
  });

  it("should skip if SuperTokens is not available", () => {
    if (!superTokensAvailable) {
      console.log("Skipping: SuperTokens not available");
      return;
    }
    expect(superTokensAvailable).toBe(true);
  });

  it("GET /api/products returns only active products (no auth required)", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/products`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { products: Array<{ slug: string; id: string }> };
    expect(body.products).toBeDefined();
    expect(Array.isArray(body.products)).toBe(true);

    // Active product should be present
    const activeProduct = body.products.find((p) => p.slug === activeSlug);
    expect(activeProduct).toBeDefined();

    // Draft and archived products should NOT be present
    const draftProduct = body.products.find((p) => p.slug === draftSlug);
    expect(draftProduct).toBeUndefined();

    const archivedProduct = body.products.find((p) => p.slug === archivedSlug);
    expect(archivedProduct).toBeUndefined();
  });

  it("GET /api/products returns products with variants, media, and pricing", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/products`);
    const body = (await res.json()) as {
      products: Array<{
        slug: string;
        variants: Array<{
          id: string;
          sku: string;
          priceMinor: number;
          currency: string;
          available: number;
          inStock: boolean;
          status: string;
        }>;
        media: Array<{ id: string; url: string; altText: string | null; sortOrder: number }>;
      }>;
    };

    const activeProduct = body.products.find((p) => p.slug === activeSlug);
    expect(activeProduct).toBeDefined();
    if (!activeProduct) return;

    // Should include active variants only (not draft)
    expect(activeProduct.variants.length).toBe(2); // active + out-of-stock active
    const draftVariant = activeProduct.variants.find((v) => v.sku === `SKU-DRAFT-${ts}`);
    expect(draftVariant).toBeUndefined();

    // In-stock variant
    const inStockVariant = activeProduct.variants.find((v) => v.sku === `SKU-ACTIVE-${ts}`);
    expect(inStockVariant).toBeDefined();
    if (!inStockVariant) return;
    expect(inStockVariant.priceMinor).toBe(2999);
    expect(inStockVariant.currency).toBe("USD");
    expect(inStockVariant.available).toBe(45);
    expect(inStockVariant.inStock).toBe(true);

    // Media should be included
    expect(activeProduct.media.length).toBeGreaterThanOrEqual(1);
    expect(activeProduct.media[0].url).toBe("https://example.com/image1.jpg");
  });

  it("GET /api/products/:slug returns product detail with variant availability", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/products/${activeSlug}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      product: {
        id: string;
        slug: string;
        title: string;
        subtitle: string | null;
        description: string | null;
        brand: string | null;
        variants: Array<{
          id: string;
          sku: string;
          title: string;
          priceMinor: number;
          available: number;
          inStock: boolean;
        }>;
        media: Array<{ id: string; url: string }>;
      };
    };

    expect(body.product).toBeDefined();
    expect(body.product.slug).toBe(activeSlug);
    expect(body.product.title).toBe("Active Test Product");
    expect(body.product.subtitle).toBe("A test subtitle");
    expect(body.product.description).toBe("A test description");
    expect(body.product.brand).toBe("Kanix");

    // Only active variants
    expect(body.product.variants.length).toBe(2);

    // Check media
    expect(body.product.media.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/products/:slug flags out-of-stock variant", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/products/${activeSlug}`);
    const body = (await res.json()) as {
      product: {
        variants: Array<{
          sku: string;
          available: number;
          inStock: boolean;
        }>;
      };
    };

    const oosVariant = body.product.variants.find((v) => v.sku === `SKU-OOS-${ts}`);
    expect(oosVariant).toBeDefined();
    if (!oosVariant) return;
    expect(oosVariant.available).toBe(0);
    expect(oosVariant.inStock).toBe(false);
  });

  it("GET /api/products/:slug returns 404 for non-existent product", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/products/non-existent-slug-${ts}`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_NOT_FOUND");
  });

  it("GET /api/products/:slug returns 404 for draft product", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/products/${draftSlug}`);
    expect(res.status).toBe(404);
  });

  it("GET /api/products/:slug returns 404 for archived product", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/products/${archivedSlug}`);
    expect(res.status).toBe(404);
  });
});
