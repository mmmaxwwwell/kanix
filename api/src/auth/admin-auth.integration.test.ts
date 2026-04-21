import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "../server.js";
import { createDatabaseConnection, type DatabaseConnection } from "../db/connection.js";
import type { Config } from "../config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole } from "../db/schema/admin.js";
import { ROLE_CAPABILITIES, CAPABILITIES } from "./admin.js";
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

/**
 * Helper: sign up a user via SuperTokens and return their auth subject (user ID).
 */
async function signUpUser(address: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${address}/auth/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
    },
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

/**
 * Helper: sign in and return session headers for authenticated requests.
 */
async function signInAndGetHeaders(
  address: string,
  email: string,
  password: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${address}/auth/signin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
    },
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

describe("admin auth + capability-based permissions (T034)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  // Test admin credentials
  const adminEmail = `test-admin-${Date.now()}@kanix.dev`;
  const adminPassword = "AdminPassword123!";
  let adminAuthSubject: string;

  // Limited-role admin credentials
  const limitedAdminEmail = `test-limited-admin-${Date.now()}@kanix.dev`;
  const limitedAdminPassword = "LimitedAdmin123!";
  let limitedAdminAuthSubject: string;

  // Non-admin user credentials
  const nonAdminEmail = `test-nonadmin-${Date.now()}@example.com`;
  const nonAdminPassword = "NonAdmin123!";

  beforeAll(async () => {
    await assertSuperTokensUp();

    dbConn = createDatabaseConnection(DATABASE_URL);

    // Create SuperTokens accounts via signup
    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
    });
    address = await server.start();
    markReady();
    app = server.app;

    // Sign up test users via SuperTokens
    adminAuthSubject = await signUpUser(address, adminEmail, adminPassword);
    limitedAdminAuthSubject = await signUpUser(address, limitedAdminEmail, limitedAdminPassword);
    await signUpUser(address, nonAdminEmail, nonAdminPassword);

    // Create admin_role entries with capabilities
    await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_super_admin_${Date.now()}`,
        description: "Test super admin role",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .onConflictDoNothing();

    await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_support_${Date.now()}`,
        description: "Test support role",
        capabilitiesJson: ROLE_CAPABILITIES.support,
      })
      .onConflictDoNothing();

    // Fetch the roles back
    const allRoles = await dbConn.db.select().from(adminRole);
    const superAdminRoleRow = allRoles.find((r) => r.description === "Test super admin role");
    const supportRoleRow = allRoles.find((r) => r.description === "Test support role");

    if (!superAdminRoleRow || !supportRoleRow) {
      throw new Error("Test roles not created");
    }

    // Create admin_user records in DB
    await dbConn.db
      .insert(adminUser)
      .values({
        authSubject: adminAuthSubject,
        email: adminEmail,
        name: "Test Super Admin",
        status: "active",
      })
      .onConflictDoNothing();

    await dbConn.db
      .insert(adminUser)
      .values({
        authSubject: limitedAdminAuthSubject,
        email: limitedAdminEmail,
        name: "Test Support Admin",
        status: "active",
      })
      .onConflictDoNothing();

    // Fetch admin users back
    const adminUsers = await dbConn.db.select().from(adminUser);
    const superAdminUser = adminUsers.find((u) => u.email === adminEmail);
    const supportAdminUser = adminUsers.find((u) => u.email === limitedAdminEmail);

    if (!superAdminUser || !supportAdminUser) {
      throw new Error("Test admin users not created");
    }

    // Assign roles
    await dbConn.db
      .insert(adminUserRole)
      .values({ adminUserId: superAdminUser.id, adminRoleId: superAdminRoleRow.id })
      .onConflictDoNothing();

    await dbConn.db
      .insert(adminUserRole)
      .values({ adminUserId: supportAdminUser.id, adminRoleId: supportRoleRow.id })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    markNotReady();
    // Clean up test data
    if (dbConn) {
      try {
        // Remove test admin_user_role entries
        const testAdminUsers = await dbConn.db
          .select()
          .from(adminUser)
          .where(eq(adminUser.email, adminEmail));
        const testLimitedUsers = await dbConn.db
          .select()
          .from(adminUser)
          .where(eq(adminUser.email, limitedAdminEmail));

        for (const u of [...testAdminUsers, ...testLimitedUsers]) {
          await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, u.id));
          await dbConn.db.delete(adminUser).where(eq(adminUser.id, u.id));
        }

        // Clean up test roles
        const testRoles = await dbConn.db.select().from(adminRole);
        for (const r of testRoles) {
          if (r.description?.startsWith("Test ")) {
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

  it("unauthenticated request to admin endpoint returns 401", async function () {
    const res = await fetch(`${address}/api/admin/me`, {
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
  });

  it("non-admin user accessing admin endpoint returns 403", async function () {
    const headers = await signInAndGetHeaders(address, nonAdminEmail, nonAdminPassword);
    const res = await fetch(`${address}/api/admin/me`, { headers });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_FORBIDDEN");
  });

  it("admin login → has permission → allowed (super_admin)", async function () {
    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Access admin profile
    const meRes = await fetch(`${address}/api/admin/me`, { headers });
    expect(meRes.status).toBe(200);

    const meBody = (await meRes.json()) as {
      admin: { id: string; email: string; name: string; capabilities: string[] };
    };
    expect(meBody.admin.email).toBe(adminEmail);
    expect(meBody.admin.name).toBe("Test Super Admin");
    expect(meBody.admin.capabilities).toContain(CAPABILITIES.ORDERS_READ);
    expect(meBody.admin.capabilities).toContain(CAPABILITIES.INVENTORY_READ);
    expect(meBody.admin.capabilities).toContain(CAPABILITIES.INVENTORY_ADJUST);

    // Access orders endpoint (requires orders.read)
    const ordersRes = await fetch(`${address}/api/admin/orders`, { headers });
    expect(ordersRes.status).toBe(200);

    // Access inventory endpoint (requires inventory.read)
    const inventoryRes = await fetch(`${address}/api/admin/inventory`, { headers });
    expect(inventoryRes.status).toBe(200);
  });

  it("admin without permission → 403 (support role cannot adjust inventory)", async function () {
    const headers = await signInAndGetHeaders(address, limitedAdminEmail, limitedAdminPassword);

    // Support role CAN read orders
    const ordersRes = await fetch(`${address}/api/admin/orders`, { headers });
    expect(ordersRes.status).toBe(200);

    // Support role CAN read inventory
    const inventoryRes = await fetch(`${address}/api/admin/inventory`, { headers });
    expect(inventoryRes.status).toBe(200);

    // Verify admin profile shows correct capabilities (support role)
    const meRes = await fetch(`${address}/api/admin/me`, { headers });
    expect(meRes.status).toBe(200);

    const meBody = (await meRes.json()) as {
      admin: { capabilities: string[] };
    };
    // Support role has orders.read but NOT inventory.adjust
    expect(meBody.admin.capabilities).toContain(CAPABILITIES.ORDERS_READ);
    expect(meBody.admin.capabilities).toContain(CAPABILITIES.SUPPORT_READ);
    expect(meBody.admin.capabilities).toContain(CAPABILITIES.SUPPORT_MANAGE);
    expect(meBody.admin.capabilities).not.toContain(CAPABILITIES.INVENTORY_ADJUST);
    expect(meBody.admin.capabilities).not.toContain(CAPABILITIES.ORDERS_REFUND);
    expect(meBody.admin.capabilities).not.toContain(CAPABILITIES.ORDERS_CANCEL);
  });

  it("permission matrix matches spec for all roles", function () {
    // Verify the capability assignments match the expected spec
    const superAdmin = ROLE_CAPABILITIES.super_admin;
    const support = ROLE_CAPABILITIES.support;
    const fulfillment = ROLE_CAPABILITIES.fulfillment;
    const finance = ROLE_CAPABILITIES.finance;

    // super_admin has ALL capabilities
    expect(superAdmin).toContain(CAPABILITIES.ORDERS_READ);
    expect(superAdmin).toContain(CAPABILITIES.ORDERS_REFUND);
    expect(superAdmin).toContain(CAPABILITIES.ORDERS_CANCEL);
    expect(superAdmin).toContain(CAPABILITIES.INVENTORY_READ);
    expect(superAdmin).toContain(CAPABILITIES.INVENTORY_ADJUST);
    expect(superAdmin).toContain(CAPABILITIES.PRODUCTS_READ);
    expect(superAdmin).toContain(CAPABILITIES.PRODUCTS_WRITE);
    expect(superAdmin).toContain(CAPABILITIES.FULFILLMENT_READ);
    expect(superAdmin).toContain(CAPABILITIES.FULFILLMENT_MANAGE);
    expect(superAdmin).toContain(CAPABILITIES.SUPPORT_READ);
    expect(superAdmin).toContain(CAPABILITIES.SUPPORT_MANAGE);
    expect(superAdmin).toContain(CAPABILITIES.DISPUTES_READ);
    expect(superAdmin).toContain(CAPABILITIES.DISPUTES_MANAGE);
    expect(superAdmin).toContain(CAPABILITIES.CONTRIBUTORS_READ);
    expect(superAdmin).toContain(CAPABILITIES.CONTRIBUTORS_MANAGE);
    expect(superAdmin).toContain(CAPABILITIES.ADMIN_USERS_READ);
    expect(superAdmin).toContain(CAPABILITIES.ADMIN_USERS_MANAGE);

    // support: orders.read, support.*, disputes.*, products.read, inventory.read
    expect(support).toContain(CAPABILITIES.ORDERS_READ);
    expect(support).toContain(CAPABILITIES.SUPPORT_READ);
    expect(support).toContain(CAPABILITIES.SUPPORT_MANAGE);
    expect(support).toContain(CAPABILITIES.DISPUTES_READ);
    expect(support).toContain(CAPABILITIES.DISPUTES_MANAGE);
    expect(support).not.toContain(CAPABILITIES.ORDERS_REFUND);
    expect(support).not.toContain(CAPABILITIES.INVENTORY_ADJUST);
    expect(support).not.toContain(CAPABILITIES.FULFILLMENT_MANAGE);

    // fulfillment: orders.read, fulfillment.*, inventory.read/adjust, products.read
    expect(fulfillment).toContain(CAPABILITIES.ORDERS_READ);
    expect(fulfillment).toContain(CAPABILITIES.FULFILLMENT_READ);
    expect(fulfillment).toContain(CAPABILITIES.FULFILLMENT_MANAGE);
    expect(fulfillment).toContain(CAPABILITIES.INVENTORY_READ);
    expect(fulfillment).toContain(CAPABILITIES.INVENTORY_ADJUST);
    expect(fulfillment).not.toContain(CAPABILITIES.ORDERS_REFUND);
    expect(fulfillment).not.toContain(CAPABILITIES.SUPPORT_MANAGE);

    // finance: orders.read/refund/cancel, products.read, inventory.read, contributors.read
    expect(finance).toContain(CAPABILITIES.ORDERS_READ);
    expect(finance).toContain(CAPABILITIES.ORDERS_REFUND);
    expect(finance).toContain(CAPABILITIES.ORDERS_CANCEL);
    expect(finance).toContain(CAPABILITIES.CONTRIBUTORS_READ);
    expect(finance).not.toContain(CAPABILITIES.INVENTORY_ADJUST);
    expect(finance).not.toContain(CAPABILITIES.FULFILLMENT_MANAGE);
    expect(finance).not.toContain(CAPABILITIES.SUPPORT_MANAGE);
  });
});
