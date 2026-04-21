import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "./db/schema/admin.js";
import { adminSetting } from "./db/schema/setting.js";
import { ROLE_CAPABILITIES, CAPABILITIES } from "./auth/admin.js";
import { assertSuperTokensUp, getSuperTokensUri, requireDatabaseUrl } from "./test-helpers.js";

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

describe("admin settings APIs (T071c)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;
  let adminUsrId: string;
  let noPermHeaders: Record<string, string>;
  let noPermAdminId: string;

  const ts = Date.now();
  const adminEmail = `test-settings-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";
  const noPermEmail = `test-settings-noperm-${ts}@kanix.dev`;
  const noPermPassword = "NoPermPassword123!";

  let testRoleId: string;
  let noPermRoleId: string;

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

    // Create admin with settings capability (super_admin)
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_settings_super_admin_${ts}`,
        description: "Test settings admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Settings Admin",
        status: "active",
      })
      .returning();
    adminUsrId = user.id;

    await dbConn.db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Create admin WITHOUT settings capability
    const noPermAuthSubject = await signUpUser(address, noPermEmail, noPermPassword);

    const [noPermRole] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_settings_support_${ts}`,
        description: "Test support admin (no settings)",
        capabilitiesJson: [CAPABILITIES.ORDERS_READ, CAPABILITIES.SUPPORT_READ],
      })
      .returning();
    noPermRoleId = noPermRole.id;

    const [noPermUser] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject: noPermAuthSubject,
        email: noPermEmail,
        name: "Test No-Perm Admin",
        status: "active",
      })
      .returning();
    noPermAdminId = noPermUser.id;

    await dbConn.db
      .insert(adminUserRole)
      .values({ adminUserId: noPermUser.id, adminRoleId: noPermRole.id });
    noPermHeaders = await signInAndGetHeaders(address, noPermEmail, noPermPassword);

    // Clean any pre-existing shipping setting for test isolation
    await dbConn.db.delete(adminSetting).where(eq(adminSetting.key, "shipping"));
  }, 30000);

  afterAll(async () => {
    markNotReady();
    if (dbConn) {
      try {
        await dbConn.db.delete(adminSetting).where(eq(adminSetting.key, "shipping"));
        await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUsrId));
        await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, noPermAdminId));
        await dbConn.db.delete(adminAuditLog).where(eq(adminAuditLog.actorAdminUserId, adminUsrId));
        await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUsrId));
        await dbConn.db.delete(adminUser).where(eq(adminUser.id, noPermAdminId));
        await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
        await dbConn.db.delete(adminRole).where(eq(adminRole.id, noPermRoleId));
      } catch {
        // Best-effort cleanup
      }
      await dbConn.close();
    }
    if (app) {
      await app.close();
    }
  }, 15000);

  // ---- GET /api/admin/settings/shipping ----

  it("returns default shipping settings when none configured", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty("defaultCarrier");
    expect(body).toHaveProperty("serviceLevels");
    expect(body).toHaveProperty("labelFormat");
    expect(body).toHaveProperty("labelSize");
    expect(body).toHaveProperty("requireSignature");
    expect(body.defaultCarrier).toBe("USPS");
    expect(Array.isArray(body.serviceLevels)).toBe(true);
  });

  it("requires authentication for shipping settings", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });

  it("requires admin.settings.manage capability", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      headers: noPermHeaders,
    });
    expect(res.status).toBe(403);
  });

  // ---- PATCH /api/admin/settings/shipping ----

  it("updates shipping settings", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        defaultCarrier: "FedEx",
        requireSignature: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.defaultCarrier).toBe("FedEx");
    expect(body.requireSignature).toBe(true);
    // Other fields should retain defaults
    expect(body.labelFormat).toBe("PDF");
    expect(body.labelSize).toBe("4x6");
  });

  it("persists changes across reads", async () => {
    // Read back after the previous update
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.defaultCarrier).toBe("FedEx");
    expect(body.requireSignature).toBe(true);
  });

  it("updates service levels", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        serviceLevels: ["Overnight", "TwoDay"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.serviceLevels).toEqual(["Overnight", "TwoDay"]);
    // Previous update should persist
    expect(body.defaultCarrier).toBe("FedEx");
  });

  it("rejects PATCH without admin.settings.manage capability", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...noPermHeaders, "content-type": "application/json" },
      body: JSON.stringify({ defaultCarrier: "DHL" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects unknown properties in PATCH body", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ unknownField: "value" }),
    });
    expect(res.status).toBe(400);
  });
});
