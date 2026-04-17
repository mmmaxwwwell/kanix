import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { product, productMedia, collection, collectionProduct } from "./db/schema/catalog.js";
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

async function signInAndGetHeaders(
  address: string,
  email: string,
  password: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${address}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  if (res.status !== 200) {
    throw new Error(`Sign-in failed with status ${res.status}`);
  }
  const cookies = res.headers.getSetCookie();
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const accessToken = res.headers.get("st-access-token");
  const antiCsrf = res.headers.get("anti-csrf");
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    cookie: cookieHeader,
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  if (antiCsrf) headers["anti-csrf"] = antiCsrf;
  return headers;
}

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("admin product CRUD API (T038)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const adminEmail = `test-product-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  // Track IDs for cleanup
  const createdProductIds: string[] = [];
  const createdMediaIds: string[] = [];
  const createdCollectionIds: string[] = [];

  beforeAll(async () => {
    superTokensAvailable = await isSuperTokensUp();
    if (!superTokensAvailable) return;

    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
    });
    address = await server.start();
    markReady();
    app = server.app;

    // Create admin user with super_admin role
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_product_super_admin_${ts}`,
        description: "Test product super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Product Admin",
        status: "active",
      })
      .returning();

    await dbConn.db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });

    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);
  });

  afterAll(async () => {
    markNotReady();
    if (dbConn) {
      try {
        // Cleanup collection_product associations
        for (const cid of createdCollectionIds) {
          await dbConn.db.delete(collectionProduct).where(eq(collectionProduct.collectionId, cid));
        }
        // Cleanup media
        for (const mid of createdMediaIds) {
          await dbConn.db.delete(productMedia).where(eq(productMedia.id, mid));
        }
        // Cleanup remaining media by product
        for (const pid of createdProductIds) {
          await dbConn.db.delete(productMedia).where(eq(productMedia.productId, pid));
        }
        // Cleanup collections
        for (const cid of createdCollectionIds) {
          await dbConn.db.delete(collection).where(eq(collection.id, cid));
        }
        // Cleanup products
        for (const pid of createdProductIds) {
          await dbConn.db.delete(product).where(eq(product.id, pid));
        }
        // Cleanup admin records
        const users = await dbConn.db
          .select()
          .from(adminUser)
          .where(eq(adminUser.email, adminEmail));
        for (const u of users) {
          await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, u.id));
          await dbConn.db.delete(adminUser).where(eq(adminUser.id, u.id));
        }
        const roles = await dbConn.db.select().from(adminRole);
        for (const r of roles) {
          if (r.description === "Test product super admin") {
            await dbConn.db.delete(adminRole).where(eq(adminRole.id, r.id));
          }
        }
      } catch {
        // Best-effort cleanup
      }
    }
    if (app) await app.close();
    if (dbConn) await dbConn.close();
  });

  // -------------------------------------------------------------------------
  // Product CRUD + status transitions
  // -------------------------------------------------------------------------

  it("create draft product → activate → archive (full lifecycle)", async () => {
    if (!superTokensAvailable) return;

    // Create draft product
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: `test-product-${ts}`,
        title: "Test Handler Belt",
        description: "A test product",
      }),
    });
    expect(createRes.status).toBe(201);
    const { product: created } = (await createRes.json()) as {
      product: { id: string; status: string; slug: string };
    };
    expect(created.status).toBe("draft");
    expect(created.slug).toBe(`test-product-${ts}`);
    createdProductIds.push(created.id);

    // Activate (draft → active)
    const activateRes = await fetch(`${address}/api/admin/products/${created.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(activateRes.status).toBe(200);
    const { product: activated } = (await activateRes.json()) as { product: { status: string } };
    expect(activated.status).toBe("active");

    // Archive (active → archived)
    const archiveRes = await fetch(`${address}/api/admin/products/${created.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    expect(archiveRes.status).toBe(200);
    const { product: archived } = (await archiveRes.json()) as { product: { status: string } };
    expect(archived.status).toBe("archived");

    // Cannot transition from archived (terminal)
    const reactivateRes = await fetch(`${address}/api/admin/products/${created.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(reactivateRes.status).toBe(400);
    const errBody = (await reactivateRes.json()) as { error: string };
    expect(errBody.error).toBe("ERR_INVALID_STATUS_TRANSITION");
  });

  it("GET /admin/products lists products", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/products`, { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: unknown[] };
    expect(Array.isArray(body.products)).toBe(true);
  });

  it("GET /admin/products/:id returns product with media", async () => {
    if (!superTokensAvailable) return;

    // Create a product
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-get-${ts}`, title: "Get Test Product" }),
    });
    const { product: p } = (await createRes.json()) as { product: { id: string } };
    createdProductIds.push(p.id);

    const res = await fetch(`${address}/api/admin/products/${p.id}`, { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { product: { id: string }; media: unknown[] };
    expect(body.product.id).toBe(p.id);
    expect(Array.isArray(body.media)).toBe(true);
  });

  it("GET /admin/products/:id returns 404 for non-existent product", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/products/00000000-0000-0000-0000-000000000000`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Product Media
  // -------------------------------------------------------------------------

  it("add media with sort_order and alt_text, then reorder", async () => {
    if (!superTokensAvailable) return;

    // Create a product
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-media-${ts}`, title: "Media Test Product" }),
    });
    const { product: p } = (await createRes.json()) as { product: { id: string } };
    createdProductIds.push(p.id);

    // Add media items
    const media1Res = await fetch(`${address}/api/admin/products/${p.id}/media`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://cdn.kanix.dev/img1.jpg",
        alt_text: "Front view",
        sort_order: 0,
      }),
    });
    expect(media1Res.status).toBe(201);
    const { media: m1 } = (await media1Res.json()) as {
      media: { id: string; sortOrder: number; altText: string };
    };
    expect(m1.altText).toBe("Front view");
    expect(m1.sortOrder).toBe(0);
    createdMediaIds.push(m1.id);

    const media2Res = await fetch(`${address}/api/admin/products/${p.id}/media`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://cdn.kanix.dev/img2.jpg",
        alt_text: "Side view",
        sort_order: 1,
      }),
    });
    expect(media2Res.status).toBe(201);
    const { media: m2 } = (await media2Res.json()) as { media: { id: string; sortOrder: number } };
    createdMediaIds.push(m2.id);

    const media3Res = await fetch(`${address}/api/admin/products/${p.id}/media`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://cdn.kanix.dev/img3.jpg",
        alt_text: "Back view",
        sort_order: 2,
      }),
    });
    expect(media3Res.status).toBe(201);
    const { media: m3 } = (await media3Res.json()) as { media: { id: string } };
    createdMediaIds.push(m3.id);

    // Reorder: put m3 first, m1 second, m2 third
    const reorderRes = await fetch(`${address}/api/admin/products/${p.id}/media/reorder`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ media_ids: [m3.id, m1.id, m2.id] }),
    });
    expect(reorderRes.status).toBe(200);
    const { media: reordered } = (await reorderRes.json()) as {
      media: { id: string; sortOrder: number }[];
    };
    expect(reordered).toHaveLength(3);
    expect(reordered[0].id).toBe(m3.id);
    expect(reordered[0].sortOrder).toBe(0);
    expect(reordered[1].id).toBe(m1.id);
    expect(reordered[1].sortOrder).toBe(1);
    expect(reordered[2].id).toBe(m2.id);
    expect(reordered[2].sortOrder).toBe(2);

    // Verify list is in correct order
    const listRes = await fetch(`${address}/api/admin/products/${p.id}/media`, {
      headers: adminHeaders,
    });
    expect(listRes.status).toBe(200);
    const { media: listed } = (await listRes.json()) as {
      media: { id: string; sortOrder: number }[];
    };
    expect(listed[0].id).toBe(m3.id);
    expect(listed[1].id).toBe(m1.id);
    expect(listed[2].id).toBe(m2.id);
  });

  it("update and delete media", async () => {
    if (!superTokensAvailable) return;

    // Create product + media
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-media-del-${ts}`, title: "Media Delete Test" }),
    });
    const { product: p } = (await createRes.json()) as { product: { id: string } };
    createdProductIds.push(p.id);

    const mediaRes = await fetch(`${address}/api/admin/products/${p.id}/media`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://cdn.kanix.dev/old.jpg", alt_text: "Old" }),
    });
    const { media: m } = (await mediaRes.json()) as { media: { id: string } };
    createdMediaIds.push(m.id);

    // Update alt_text
    const updateRes = await fetch(`${address}/api/admin/products/${p.id}/media/${m.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ alt_text: "Updated alt text" }),
    });
    expect(updateRes.status).toBe(200);
    const { media: updated } = (await updateRes.json()) as { media: { altText: string } };
    expect(updated.altText).toBe("Updated alt text");

    // Delete
    const deleteRes = await fetch(`${address}/api/admin/products/${p.id}/media/${m.id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(deleteRes.status).toBe(204);

    // Verify gone
    const listRes = await fetch(`${address}/api/admin/products/${p.id}/media`, {
      headers: adminHeaders,
    });
    const { media: remaining } = (await listRes.json()) as { media: unknown[] };
    expect(remaining).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Collection CRUD + product associations
  // -------------------------------------------------------------------------

  it("collection CRUD with product associations", async () => {
    if (!superTokensAvailable) return;

    // Create a product
    const prodRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-col-prod-${ts}`, title: "Collection Product" }),
    });
    const { product: p } = (await prodRes.json()) as { product: { id: string } };
    createdProductIds.push(p.id);

    // Create a collection
    const colRes = await fetch(`${address}/api/admin/collections`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: `test-collection-${ts}`,
        title: "Test Collection",
        description: "A test",
      }),
    });
    expect(colRes.status).toBe(201);
    const { collection: col } = (await colRes.json()) as {
      collection: { id: string; slug: string; status: string };
    };
    expect(col.slug).toBe(`test-collection-${ts}`);
    expect(col.status).toBe("draft");
    createdCollectionIds.push(col.id);

    // List collections
    const listRes = await fetch(`${address}/api/admin/collections`, { headers: adminHeaders });
    expect(listRes.status).toBe(200);
    const { collections } = (await listRes.json()) as { collections: unknown[] };
    expect(collections.length).toBeGreaterThanOrEqual(1);

    // Update collection
    const updateRes = await fetch(`${address}/api/admin/collections/${col.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated Collection" }),
    });
    expect(updateRes.status).toBe(200);
    const { collection: updated } = (await updateRes.json()) as { collection: { title: string } };
    expect(updated.title).toBe("Updated Collection");

    // Add product to collection
    const addRes = await fetch(`${address}/api/admin/collections/${col.id}/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: p.id, sort_order: 0 }),
    });
    expect(addRes.status).toBe(201);

    // Get collection — should include products
    const getRes = await fetch(`${address}/api/admin/collections/${col.id}`, {
      headers: adminHeaders,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      collection: { id: string };
      products: { productId: string }[];
    };
    expect(getBody.products).toHaveLength(1);
    expect(getBody.products[0].productId).toBe(p.id);

    // Remove product from collection
    const removeRes = await fetch(`${address}/api/admin/collections/${col.id}/products/${p.id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(removeRes.status).toBe(204);

    // Verify removed
    const getRes2 = await fetch(`${address}/api/admin/collections/${col.id}`, {
      headers: adminHeaders,
    });
    const getBody2 = (await getRes2.json()) as { products: unknown[] };
    expect(getBody2.products).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Permission checks
  // -------------------------------------------------------------------------

  it("products.read required for GET endpoints", async () => {
    if (!superTokensAvailable) return;

    // Unauthenticated request
    const res = await fetch(`${address}/api/admin/products`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });
});
