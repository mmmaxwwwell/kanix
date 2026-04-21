import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { product, productMedia, productVariant, collection, collectionProduct } from "./db/schema/catalog.js";
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

describe("admin product CRUD API (T227)", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const adminEmail = `test-product-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  // Track IDs for cleanup
  const createdProductIds: string[] = [];
  const createdMediaIds: string[] = [];
  const createdCollectionIds: string[] = [];
  const createdVariantIds: string[] = [];

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

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
      // Cleanup variants
      for (const vid of createdVariantIds) {
        await dbConn.db.delete(productVariant).where(eq(productVariant.id, vid));
      }
      // Cleanup remaining variants by product
      for (const pid of createdProductIds) {
        await dbConn.db.delete(productVariant).where(eq(productVariant.productId, pid));
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
    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Product CRUD + status transitions
  // -------------------------------------------------------------------------

  it("create draft product → activate → archive (full lifecycle)", async () => {
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
      product: { id: string; status: string; slug: string; title: string; description: string };
    };
    expect(created.status).toBe("draft");
    expect(created.slug).toBe(`test-product-${ts}`);
    expect(created.title).toBe("Test Handler Belt");
    expect(created.description).toBe("A test product");
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
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
    const errBody = (await reactivateRes.json()) as { error: string; message: string };
    expect(errBody.error).toBe("ERR_INVALID_STATUS_TRANSITION");
    expect(errBody.message).toContain("archived");
  });

  it("slug collision returns 400 with ERR_SLUG_COLLISION", async () => {
    const slug = `test-slug-collision-${ts}`;

    // Create first product
    const res1 = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug, title: "First Product" }),
    });
    expect(res1.status).toBe(201);
    const { product: p1 } = (await res1.json()) as { product: { id: string } };
    createdProductIds.push(p1.id);

    // Try to create another product with the same slug
    const res2 = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug, title: "Duplicate Slug Product" }),
    });
    expect(res2.status).toBe(400);
    const errBody = (await res2.json()) as { error: string; message: string };
    expect(errBody.error).toBe("ERR_SLUG_COLLISION");
    expect(errBody.message).toContain(slug);
  });

  it("GET /admin/products lists products with concrete shape", async () => {
    // Create a product so we know at least one exists
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-list-${ts}`, title: "List Test Product" }),
    });
    const { product: p } = (await createRes.json()) as { product: { id: string } };
    createdProductIds.push(p.id);

    const res = await fetch(`${address}/api/admin/products`, { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: { id: string; slug: string; title: string; status: string }[] };
    expect(body.products.length).toBeGreaterThanOrEqual(1);
    const found = body.products.find((pr) => pr.id === p.id);
    expect(found).toBeDefined();
    expect(found!.slug).toBe(`test-list-${ts}`);
    expect(found!.title).toBe("List Test Product");
    expect(found!.status).toBe("draft");
  });

  it("GET /admin/products/:id returns product with media array", async () => {
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-get-${ts}`, title: "Get Test Product" }),
    });
    const { product: p } = (await createRes.json()) as {
      product: { id: string; slug: string; title: string };
    };
    createdProductIds.push(p.id);

    const res = await fetch(`${address}/api/admin/products/${p.id}`, { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      product: { id: string; slug: string; title: string; status: string };
      media: unknown[];
    };
    expect(body.product.id).toBe(p.id);
    expect(body.product.slug).toBe(`test-get-${ts}`);
    expect(body.product.title).toBe("Get Test Product");
    expect(body.product.status).toBe("draft");
    expect(body.media).toHaveLength(0);
  });

  it("GET /admin/products/:id returns 404 for non-existent product", async () => {
    const res = await fetch(`${address}/api/admin/products/00000000-0000-0000-0000-000000000000`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // Variants + Pricing
  // -------------------------------------------------------------------------

  it("create product with variants + pricing, then update price", async () => {
    // Create product
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-variants-${ts}`, title: "Variant Test Product" }),
    });
    expect(createRes.status).toBe(201);
    const { product: p } = (await createRes.json()) as { product: { id: string } };
    createdProductIds.push(p.id);

    // Create variant with pricing
    const varRes = await fetch(`${address}/api/admin/products/${p.id}/variants`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: `SKU-VAR1-${ts}`,
        title: "TPU Variant",
        material: "TPU",
        price_minor: 2499,
        currency: "USD",
      }),
    });
    expect(varRes.status).toBe(201);
    const { variant: v1 } = (await varRes.json()) as {
      variant: {
        id: string;
        sku: string;
        title: string;
        priceMinor: number;
        currency: string;
        status: string;
        optionValuesJson: Record<string, string>;
      };
    };
    expect(v1.sku).toBe(`SKU-VAR1-${ts}`);
    expect(v1.title).toBe("TPU Variant");
    expect(v1.priceMinor).toBe(2499);
    expect(v1.currency).toBe("USD");
    expect(v1.status).toBe("draft");
    expect(v1.optionValuesJson).toEqual({ material: "TPU" });
    createdVariantIds.push(v1.id);

    // Create second variant with different price
    const var2Res = await fetch(`${address}/api/admin/products/${p.id}/variants`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: `SKU-VAR2-${ts}`,
        title: "PETG Variant",
        material: "PETG",
        price_minor: 1999,
      }),
    });
    expect(var2Res.status).toBe(201);
    const { variant: v2 } = (await var2Res.json()) as {
      variant: { id: string; priceMinor: number };
    };
    expect(v2.priceMinor).toBe(1999);
    createdVariantIds.push(v2.id);

    // List variants — should have 2
    const listRes = await fetch(`${address}/api/admin/products/${p.id}/variants`, {
      headers: adminHeaders,
    });
    expect(listRes.status).toBe(200);
    const { variants } = (await listRes.json()) as {
      variants: { id: string; priceMinor: number }[];
    };
    expect(variants).toHaveLength(2);
    const varIds = variants.map((v) => v.id);
    expect(varIds).toContain(v1.id);
    expect(varIds).toContain(v2.id);

    // Update price on first variant
    const updateRes = await fetch(`${address}/api/admin/products/${p.id}/variants/${v1.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ price_minor: 2999 }),
    });
    expect(updateRes.status).toBe(200);
    const { variant: updated } = (await updateRes.json()) as {
      variant: { id: string; priceMinor: number };
    };
    expect(updated.id).toBe(v1.id);
    expect(updated.priceMinor).toBe(2999);

    // Verify updated price persists via list
    const listRes2 = await fetch(`${address}/api/admin/products/${p.id}/variants`, {
      headers: adminHeaders,
    });
    const { variants: variants2 } = (await listRes2.json()) as {
      variants: { id: string; priceMinor: number }[];
    };
    const updatedV1 = variants2.find((v) => v.id === v1.id);
    expect(updatedV1!.priceMinor).toBe(2999);
  });

  it("variant creation requires sku, title, price_minor", async () => {
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-var-validation-${ts}`, title: "Validation Product" }),
    });
    const { product: p } = (await createRes.json()) as { product: { id: string } };
    createdProductIds.push(p.id);

    // Missing required fields
    const badRes = await fetch(`${address}/api/admin/products/${p.id}/variants`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No SKU or price" }),
    });
    expect(badRes.status).toBe(400);
    const errBody = (await badRes.json()) as { error: string; message: string };
    expect(errBody.error).toBe("ERR_VALIDATION");
    expect(errBody.message).toContain("sku");
  });

  it("variant price_minor must be positive", async () => {
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-var-neg-price-${ts}`, title: "Neg Price Product" }),
    });
    const { product: p } = (await createRes.json()) as { product: { id: string } };
    createdProductIds.push(p.id);

    const badRes = await fetch(`${address}/api/admin/products/${p.id}/variants`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ sku: `SKU-NEG-${ts}`, title: "Negative", price_minor: -100 }),
    });
    expect(badRes.status).toBe(400);
    const errBody = (await badRes.json()) as { error: string };
    expect(errBody.error).toBe("ERR_VALIDATION");
  });

  // -------------------------------------------------------------------------
  // Archive propagation to variants
  // -------------------------------------------------------------------------

  it("archiving product propagates archived status to all variants", async () => {
    // Create product
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-archive-prop-${ts}`, title: "Archive Propagation" }),
    });
    const { product: p } = (await createRes.json()) as { product: { id: string } };
    createdProductIds.push(p.id);

    // Create two variants — one active, one draft
    const v1Res = await fetch(`${address}/api/admin/products/${p.id}/variants`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: `SKU-ARCH1-${ts}`,
        title: "Active Variant",
        price_minor: 1000,
      }),
    });
    expect(v1Res.status).toBe(201);
    const { variant: v1 } = (await v1Res.json()) as { variant: { id: string } };
    createdVariantIds.push(v1.id);

    // Activate the variant
    const activateVarRes = await fetch(`${address}/api/admin/products/${p.id}/variants/${v1.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(activateVarRes.status).toBe(200);

    const v2Res = await fetch(`${address}/api/admin/products/${p.id}/variants`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: `SKU-ARCH2-${ts}`,
        title: "Draft Variant",
        price_minor: 2000,
      }),
    });
    expect(v2Res.status).toBe(201);
    const { variant: v2 } = (await v2Res.json()) as { variant: { id: string } };
    createdVariantIds.push(v2.id);

    // Activate product first (draft → active) so we can archive it
    await fetch(`${address}/api/admin/products/${p.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });

    // Archive the product
    const archiveRes = await fetch(`${address}/api/admin/products/${p.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    expect(archiveRes.status).toBe(200);
    const { product: archived } = (await archiveRes.json()) as { product: { status: string } };
    expect(archived.status).toBe("archived");

    // Verify both variants are now archived
    const listRes = await fetch(`${address}/api/admin/products/${p.id}/variants`, {
      headers: adminHeaders,
    });
    expect(listRes.status).toBe(200);
    const { variants } = (await listRes.json()) as {
      variants: { id: string; status: string }[];
    };
    expect(variants).toHaveLength(2);
    for (const v of variants) {
      expect(v.status).toBe("archived");
    }
  });

  // -------------------------------------------------------------------------
  // Product Media
  // -------------------------------------------------------------------------

  it("add media with sort_order and alt_text, then reorder", async () => {
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
      media: { id: string; sortOrder: number; altText: string; url: string };
    };
    expect(m1.altText).toBe("Front view");
    expect(m1.sortOrder).toBe(0);
    expect(m1.url).toBe("https://cdn.kanix.dev/img1.jpg");
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
    const { media: m2 } = (await media2Res.json()) as {
      media: { id: string; sortOrder: number; altText: string };
    };
    expect(m2.altText).toBe("Side view");
    expect(m2.sortOrder).toBe(1);
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
    const { media: m3 } = (await media3Res.json()) as { media: { id: string; sortOrder: number } };
    expect(m3.sortOrder).toBe(2);
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
    expect(listed).toHaveLength(3);
    expect(listed[0].id).toBe(m3.id);
    expect(listed[1].id).toBe(m1.id);
    expect(listed[2].id).toBe(m2.id);
  });

  it("update and delete media", async () => {
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
    expect(mediaRes.status).toBe(201);
    const { media: m } = (await mediaRes.json()) as {
      media: { id: string; url: string; altText: string };
    };
    expect(m.url).toBe("https://cdn.kanix.dev/old.jpg");
    expect(m.altText).toBe("Old");
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

  it("media URL is stored and returned correctly (URL signing verification)", async () => {
    const createRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: `test-media-url-${ts}`, title: "URL Test Product" }),
    });
    const { product: p } = (await createRes.json()) as { product: { id: string } };
    createdProductIds.push(p.id);

    const mediaUrl = "https://cdn.kanix.dev/uploads/product-image-12345.jpg";
    const mediaRes = await fetch(`${address}/api/admin/products/${p.id}/media`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: mediaUrl,
        alt_text: "Product hero shot",
        sort_order: 0,
      }),
    });
    expect(mediaRes.status).toBe(201);
    const { media: m } = (await mediaRes.json()) as {
      media: { id: string; url: string; altText: string; sortOrder: number; productId: string };
    };
    expect(m.url).toBe(mediaUrl);
    expect(m.altText).toBe("Product hero shot");
    expect(m.sortOrder).toBe(0);
    expect(m.productId).toBe(p.id);
    createdMediaIds.push(m.id);

    // Verify via GET that URL is persisted and returned in full
    const getRes = await fetch(`${address}/api/admin/products/${p.id}`, { headers: adminHeaders });
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { media: { id: string; url: string }[] };
    expect(body.media).toHaveLength(1);
    expect(body.media[0].url).toBe(mediaUrl);
    expect(body.media[0].id).toBe(m.id);
  });

  // -------------------------------------------------------------------------
  // Collection CRUD + product associations
  // -------------------------------------------------------------------------

  it("collection CRUD with product associations", async () => {
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
      collection: { id: string; slug: string; status: string; title: string; description: string };
    };
    expect(col.slug).toBe(`test-collection-${ts}`);
    expect(col.status).toBe("draft");
    expect(col.title).toBe("Test Collection");
    expect(col.description).toBe("A test");
    createdCollectionIds.push(col.id);

    // List collections
    const listRes = await fetch(`${address}/api/admin/collections`, { headers: adminHeaders });
    expect(listRes.status).toBe(200);
    const { collections } = (await listRes.json()) as {
      collections: { id: string; slug: string }[];
    };
    expect(collections.length).toBeGreaterThanOrEqual(1);
    const found = collections.find((c) => c.id === col.id);
    expect(found).toBeDefined();
    expect(found!.slug).toBe(`test-collection-${ts}`);

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

  it("unauthenticated request to admin products returns 401", async () => {
    const res = await fetch(`${address}/api/admin/products`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });
});
