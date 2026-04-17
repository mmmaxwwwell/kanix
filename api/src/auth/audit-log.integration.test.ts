import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "../server.js";
import { createDatabaseConnection, type DatabaseConnection } from "../db/connection.js";
import type { Config } from "../config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "../db/schema/admin.js";
import { product } from "../db/schema/catalog.js";
import { ROLE_CAPABILITIES } from "./admin.js";
import { findAuditLogsByEntityId } from "../db/queries/audit-log.js";

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

// Skip when dependencies are unavailable
const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("admin audit log middleware (T035)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;

  const adminEmail = `test-audit-admin-${Date.now()}@kanix.dev`;
  const adminPassword = "AuditAdmin123!";
  let adminAuthSubject: string;
  let adminUserId: string;

  // Track created entities for cleanup
  const createdProductIds: string[] = [];

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

    // Sign up admin user
    adminAuthSubject = await signUpUser(address, adminEmail, adminPassword);

    // Create admin role with super_admin capabilities
    await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_audit_super_admin_${Date.now()}`,
        description: "Test audit super admin role",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .onConflictDoNothing();

    const allRoles = await dbConn.db.select().from(adminRole);
    const superAdminRoleRow = allRoles.find((r) => r.description === "Test audit super admin role");
    if (!superAdminRoleRow) throw new Error("Test role not created");

    // Create admin_user record
    const [insertedAdmin] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject: adminAuthSubject,
        email: adminEmail,
        name: "Test Audit Admin",
        status: "active",
      })
      .returning();

    adminUserId = insertedAdmin.id;

    // Assign role
    await dbConn.db
      .insert(adminUserRole)
      .values({ adminUserId: insertedAdmin.id, adminRoleId: superAdminRoleRow.id })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    markNotReady();
    if (dbConn) {
      try {
        // Clean up audit log entries
        for (const pid of createdProductIds) {
          await dbConn.db.delete(adminAuditLog).where(eq(adminAuditLog.entityId, pid));
          await dbConn.db.delete(product).where(eq(product.id, pid));
        }

        // Clean up admin data
        const testAdminUsers = await dbConn.db
          .select()
          .from(adminUser)
          .where(eq(adminUser.email, adminEmail));

        for (const u of testAdminUsers) {
          await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, u.id));
          await dbConn.db.delete(adminAuditLog).where(eq(adminAuditLog.actorAdminUserId, u.id));
          await dbConn.db.delete(adminUser).where(eq(adminUser.id, u.id));
        }

        // Clean up test roles
        const testRoles = await dbConn.db.select().from(adminRole);
        for (const r of testRoles) {
          if (r.description?.startsWith("Test audit")) {
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

  it("admin creates a product → audit log entry exists with correct before (null) and after (product JSON)", async function () {
    if (!superTokensAvailable) return;

    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    const slug = `audit-test-product-${Date.now()}`;
    const res = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        slug,
        title: "Audit Test Product",
        description: "A product created to test audit logging",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      product: { id: string; slug: string; title: string };
    };
    expect(body.product.slug).toBe(slug);
    expect(body.product.title).toBe("Audit Test Product");

    const productId = body.product.id;
    createdProductIds.push(productId);

    // The audit log is written in the onResponse hook, which fires after the
    // response is sent. Give it a moment to complete.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify audit log entry exists
    const logs = await findAuditLogsByEntityId(dbConn.db, productId);

    expect(logs.length).toBeGreaterThanOrEqual(1);
    const entry = logs[0];
    expect(entry.actorAdminUserId).toBe(adminUserId);
    expect(entry.action).toBe("CREATE");
    expect(entry.entityType).toBe("product");
    expect(entry.entityId).toBe(productId);
    expect(entry.beforeJson).toBeNull();
    expect(entry.afterJson).not.toBeNull();

    // Verify the after JSON contains the product data
    const afterData = entry.afterJson as { id: string; slug: string; title: string };
    expect(afterData.id).toBe(productId);
    expect(afterData.slug).toBe(slug);
    expect(afterData.title).toBe("Audit Test Product");

    // Verify IP address is captured
    expect(entry.ipAddress).toBeTruthy();

    // Verify created_at timestamp is recent
    expect(entry.createdAt).toBeInstanceOf(Date);
    const timeDiff = Date.now() - entry.createdAt.getTime();
    expect(timeDiff).toBeLessThan(10000); // within 10 seconds
  });

  it("failed requests do not create audit log entries", async function () {
    if (!superTokensAvailable) return;

    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Send a request missing required fields — should fail with 400
    const res = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ slug: "" }),
    });

    expect(res.status).toBe(400);

    // Wait for any hook to fire
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Query audit logs for this admin user — should not have a log for this failed request
    // We check that no audit log with action CREATE and entity_type product was created
    // with a null entity_id (since validation fails before product creation)
    const allLogs = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.actorAdminUserId, adminUserId));

    // Any existing logs should only be from successful requests
    for (const log of allLogs) {
      expect(log.entityId).toBeTruthy();
    }
  });

  it("read-only admin endpoints do not create audit log entries (no auditContext set)", async function () {
    if (!superTokensAvailable) return;

    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Count existing audit logs
    const beforeLogs = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.actorAdminUserId, adminUserId));

    const beforeCount = beforeLogs.length;

    // Access read-only endpoint
    const res = await fetch(`${address}/api/admin/me`, { headers });
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Count audit logs after — should be unchanged
    const afterLogs = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.actorAdminUserId, adminUserId));

    expect(afterLogs.length).toBe(beforeCount);
  });
});
