import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "../server.js";
import { createDatabaseConnection, type DatabaseConnection } from "../db/connection.js";
import type { Config } from "../config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole } from "../db/schema/admin.js";
import { product } from "../db/schema/catalog.js";
import { productVariant } from "../db/schema/catalog.js";
import { productClass, productClassMembership } from "../db/schema/product-class.js";
import { ROLE_CAPABILITIES } from "../auth/admin.js";
import { assertSuperTokensUp, getSuperTokensUri, requireDatabaseUrl } from "../test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();
const SUPERTOKENS_URI = getSuperTokensUri();

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: DATABASE_URL,
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "whsec_xxx",
    PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_xxx",
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

describe("product variant + classification API (T039)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;

  const adminEmail = `test-admin-t039-${Date.now()}@kanix.dev`;
  const adminPassword = "AdminPassword123!";
  let adminAuthSubject: string;

  // IDs to track for cleanup
  let testProductId: string;
  let testVariantTPUId: string;
  let testVariantPA11Id: string;
  let testClassId: string;
  let testRoleId: string;
  let testAdminUserId: string;

  beforeAll(async () => {
    await assertSuperTokensUp();

    dbConn = createDatabaseConnection(DATABASE_URL);

    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
    });
    address = await server.start();
    markReady();
    app = server.app;

    // Sign up admin user via SuperTokens
    adminAuthSubject = await signUpUser(address, adminEmail, adminPassword);

    // Create admin role with super_admin capabilities
    const [role] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_super_admin_t039_${Date.now()}`,
        description: "Test super admin role (T039)",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    // Create admin user record
    const [adminUserRow] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject: adminAuthSubject,
        email: adminEmail,
        name: "Test Admin T039",
        status: "active",
      })
      .returning();
    testAdminUserId = adminUserRow.id;

    // Assign role
    await dbConn.db
      .insert(adminUserRole)
      .values({ adminUserId: testAdminUserId, adminRoleId: testRoleId });

    // Get auth headers
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);
  });

  afterAll(async () => {
    markNotReady();
    if (dbConn) {
      try {
        // Clean up in dependency order
        if (testProductId && testClassId) {
          await dbConn.db
            .delete(productClassMembership)
            .where(eq(productClassMembership.productId, testProductId));
        }
        if (testClassId) {
          await dbConn.db.delete(productClass).where(eq(productClass.id, testClassId));
        }
        if (testVariantTPUId) {
          await dbConn.db.delete(productVariant).where(eq(productVariant.id, testVariantTPUId));
        }
        if (testVariantPA11Id) {
          await dbConn.db.delete(productVariant).where(eq(productVariant.id, testVariantPA11Id));
        }
        if (testProductId) {
          await dbConn.db.delete(product).where(eq(product.id, testProductId));
        }
        if (testAdminUserId) {
          await dbConn.db
            .delete(adminUserRole)
            .where(eq(adminUserRole.adminUserId, testAdminUserId));
          await dbConn.db.delete(adminUser).where(eq(adminUser.id, testAdminUserId));
        }
        if (testRoleId) {
          await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
        }
      } catch {
        // Best-effort cleanup
      }
    }
    if (app) await app.close();
    if (dbConn) await dbConn.close();
  });

  it("create product → add TPU variant → add PA11 variant → assign to class", async function () {
    // Step 1: Create a product
    const productRes = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: `test-product-t039-${Date.now()}`,
        title: "Test Product T039",
      }),
    });
    expect(productRes.status).toBe(201);
    const productBody = (await productRes.json()) as { product: { id: string } };
    testProductId = productBody.product.id;

    // Step 2: Add TPU variant ($29.99 = 2999 cents)
    const tpuRes = await fetch(`${address}/api/admin/products/${testProductId}/variants`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: `TPU-T039-${Date.now()}`,
        title: "TPU Variant",
        material: "TPU",
        price_minor: 2999,
        weight: "0.1500",
        dimensions: { length: 4, width: 4, height: 2, unit: "in" },
      }),
    });
    expect(tpuRes.status).toBe(201);
    const tpuBody = (await tpuRes.json()) as {
      variant: {
        id: string;
        sku: string;
        priceMinor: number;
        optionValuesJson: { material: string };
        status: string;
      };
    };
    testVariantTPUId = tpuBody.variant.id;
    expect(tpuBody.variant.priceMinor).toBe(2999);
    expect(tpuBody.variant.optionValuesJson).toEqual({ material: "TPU" });
    expect(tpuBody.variant.status).toBe("draft");

    // Step 3: Add PA11 variant ($49.99 = 4999 cents)
    const pa11Res = await fetch(`${address}/api/admin/products/${testProductId}/variants`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: `PA11-T039-${Date.now()}`,
        title: "PA11 Variant",
        material: "PA11",
        price_minor: 4999,
        weight: "0.2000",
      }),
    });
    expect(pa11Res.status).toBe(201);
    const pa11Body = (await pa11Res.json()) as {
      variant: {
        id: string;
        sku: string;
        priceMinor: number;
        optionValuesJson: { material: string };
      };
    };
    testVariantPA11Id = pa11Body.variant.id;
    expect(pa11Body.variant.priceMinor).toBe(4999);
    expect(pa11Body.variant.optionValuesJson).toEqual({ material: "PA11" });

    // Step 4: List variants — should have both
    const listRes = await fetch(`${address}/api/admin/products/${testProductId}/variants`, {
      headers: adminHeaders,
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { variants: { id: string }[] };
    expect(listBody.variants).toHaveLength(2);

    // Step 5: Create product class "modules"
    const classRes = await fetch(`${address}/api/admin/product-classes`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Modules",
        slug: `modules-t039-${Date.now()}`,
        description: "Kanix compatible modules",
      }),
    });
    expect(classRes.status).toBe(201);
    const classBody = (await classRes.json()) as { product_class: { id: string; name: string } };
    testClassId = classBody.product_class.id;
    expect(classBody.product_class.name).toBe("Modules");

    // Step 6: Assign product to class "modules"
    const assignRes = await fetch(
      `${address}/api/admin/products/${testProductId}/classes/${testClassId}`,
      {
        method: "POST",
        headers: adminHeaders,
      },
    );
    expect(assignRes.status).toBe(201);
    const assignBody = (await assignRes.json()) as {
      membership: { productId: string; productClassId: string };
    };
    expect(assignBody.membership.productId).toBe(testProductId);
    expect(assignBody.membership.productClassId).toBe(testClassId);
  });

  it("variant status transitions: draft → active → inactive → archived", async function () {
    if (!testVariantTPUId || !testProductId) return;

    // draft → active
    const activateRes = await fetch(
      `${address}/api/admin/products/${testProductId}/variants/${testVariantTPUId}`,
      {
        method: "PATCH",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      },
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as { variant: { status: string } };
    expect(activateBody.variant.status).toBe("active");

    // active → inactive
    const inactivateRes = await fetch(
      `${address}/api/admin/products/${testProductId}/variants/${testVariantTPUId}`,
      {
        method: "PATCH",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "inactive" }),
      },
    );
    expect(inactivateRes.status).toBe(200);
    const inactivateBody = (await inactivateRes.json()) as { variant: { status: string } };
    expect(inactivateBody.variant.status).toBe("inactive");

    // inactive → archived
    const archiveRes = await fetch(
      `${address}/api/admin/products/${testProductId}/variants/${testVariantTPUId}`,
      {
        method: "PATCH",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      },
    );
    expect(archiveRes.status).toBe(200);
    const archiveBody = (await archiveRes.json()) as { variant: { status: string } };
    expect(archiveBody.variant.status).toBe("archived");
  });

  it("rejects invalid variant status transition (archived → active)", async function () {
    if (!testVariantTPUId || !testProductId) return;

    // archived is terminal — cannot transition back
    const res = await fetch(
      `${address}/api/admin/products/${testProductId}/variants/${testVariantTPUId}`,
      {
        method: "PATCH",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_INVALID_TRANSITION");
  });

  it("variant creation requires sku, title, price_minor", async function () {
    if (!testProductId) return;

    const res = await fetch(`${address}/api/admin/products/${testProductId}/variants`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Missing SKU" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_VALIDATION");
  });

  it("product class CRUD: create → get → update → delete", async function () {
    // Create
    const createRes = await fetch(`${address}/api/admin/product-classes`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Temp Class",
        slug: `temp-class-${Date.now()}`,
        description: "temporary",
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { product_class: { id: string; name: string } };
    const tempClassId = createBody.product_class.id;

    // Get
    const getRes = await fetch(`${address}/api/admin/product-classes/${tempClassId}`, {
      headers: adminHeaders,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { product_class: { name: string } };
    expect(getBody.product_class.name).toBe("Temp Class");

    // Update
    const updateRes = await fetch(`${address}/api/admin/product-classes/${tempClassId}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Class" }),
    });
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as { product_class: { name: string } };
    expect(updateBody.product_class.name).toBe("Updated Class");

    // List — should include our class
    const listRes = await fetch(`${address}/api/admin/product-classes`, {
      headers: adminHeaders,
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { product_classes: { id: string }[] };
    expect(listBody.product_classes.some((c) => c.id === tempClassId)).toBe(true);

    // Delete
    const deleteRes = await fetch(`${address}/api/admin/product-classes/${tempClassId}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(deleteRes.status).toBe(204);

    // Verify deleted
    const verifyRes = await fetch(`${address}/api/admin/product-classes/${tempClassId}`, {
      headers: adminHeaders,
    });
    expect(verifyRes.status).toBe(404);
  });

  it("remove product from class", async function () {
    if (!testProductId || !testClassId) return;

    // Remove
    const removeRes = await fetch(
      `${address}/api/admin/products/${testProductId}/classes/${testClassId}`,
      {
        method: "DELETE",
        headers: adminHeaders,
      },
    );
    expect(removeRes.status).toBe(204);

    // Re-assign for cleanup expectation
    await fetch(`${address}/api/admin/products/${testProductId}/classes/${testClassId}`, {
      method: "POST",
      headers: adminHeaders,
    });
  });

  it("returns 404 for variant on non-existent product", async function () {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${address}/api/admin/products/${fakeId}/variants`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ sku: "X", title: "X", price_minor: 100 }),
    });
    expect(res.status).toBe(404);
  });
});
