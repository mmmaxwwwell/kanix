import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "./db/schema/admin.js";
import { adminSetting } from "./db/schema/setting.js";
import { ROLE_CAPABILITIES, CAPABILITIES } from "./auth/admin.js";
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

describe("admin settings APIs (T229)", () => {
  let ts_: TestServer;

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
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

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

    // Create admin WITHOUT settings capability (support role)
    const noPermAuthSubject = await signUpUser(address, noPermEmail, noPermPassword);

    const [noPermRole] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_settings_support_${ts}`,
        description: "Test support admin (no settings)",
        capabilitiesJson: ROLE_CAPABILITIES.support,
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
    try {
      await dbConn.db.delete(adminSetting).where(eq(adminSetting.key, "shipping"));
      await dbConn.db.delete(adminAuditLog).where(eq(adminAuditLog.actorAdminUserId, adminUsrId));
      await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUsrId));
      await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, noPermAdminId));
      await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUsrId));
      await dbConn.db.delete(adminUser).where(eq(adminUser.id, noPermAdminId));
      await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
      await dbConn.db.delete(adminRole).where(eq(adminRole.id, noPermRoleId));
    } catch {
      // Best-effort cleanup
    }
    await stopTestServer(ts_);
  }, 15000);

  // ---- GET /api/admin/settings/shipping ----

  it("returns default shipping settings when none configured", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Concrete value assertions for all default fields
    expect(body.defaultCarrier).toBe("USPS");
    expect(body.serviceLevels).toEqual(["Priority", "Express", "Ground"]);
    expect(body.labelFormat).toBe("PDF");
    expect(body.labelSize).toBe("4x6");
    expect(body.requireSignature).toBe(false);
  });

  it("requires authentication for GET shipping settings", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });

  it("requires SETTINGS_MANAGE capability for GET shipping settings", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      headers: noPermHeaders,
    });
    expect(res.status).toBe(403);
  });

  // ---- PATCH /api/admin/settings/shipping ----

  it("updates shipping settings and persists changes", async () => {
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

    // Updated fields
    expect(body.defaultCarrier).toBe("FedEx");
    expect(body.requireSignature).toBe(true);
    // Retained defaults
    expect(body.labelFormat).toBe("PDF");
    expect(body.labelSize).toBe("4x6");
    expect(body.serviceLevels).toEqual(["Priority", "Express", "Ground"]);

    // Verify persistence: read back
    const getRes = await fetch(`${address}/api/admin/settings/shipping`, {
      headers: adminHeaders,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect(getBody.defaultCarrier).toBe("FedEx");
    expect(getBody.requireSignature).toBe(true);
    expect(getBody.labelFormat).toBe("PDF");
    expect(getBody.labelSize).toBe("4x6");
  });

  it("updates service levels while retaining other changes", async () => {
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
    expect(body.requireSignature).toBe(true);
  });

  it("fires settings.changed domain event on PATCH", async () => {
    const wsManager = ts_.server.wsManager;
    const bufferLenBefore = wsManager ? wsManager.messageBuffer.length : 0;

    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ labelFormat: "ZPL" }),
    });
    expect(res.status).toBe(200);

    // Verify the event was buffered
    expect(wsManager).toBeDefined();
    const newMessages = wsManager!.messageBuffer.slice(bufferLenBefore);
    const settingsEvent = newMessages.find(
      (m) => m.message.type === "settings.changed",
    );
    expect(settingsEvent).toBeDefined();
    expect(settingsEvent!.message.entity).toBe("setting");
    expect(settingsEvent!.message.entityId).toBe("shipping");
    expect(settingsEvent!.channel).toBe("setting:shipping");
    expect(settingsEvent!.wildcardChannel).toBe("setting:*");

    const data = settingsEvent!.message.data;
    expect(data).toHaveProperty("changes");
    expect(data).toHaveProperty("result");
    expect((data.changes as Record<string, unknown>).labelFormat).toBe("ZPL");
    expect((data.result as Record<string, unknown>).labelFormat).toBe("ZPL");
  });

  it("writes audit log entry on settings update", async () => {
    // Count existing audit entries
    const logsBefore = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.actorAdminUserId, adminUsrId),
          eq(adminAuditLog.action, "settings_updated"),
        ),
      );
    const countBefore = logsBefore.length;

    // Make a settings change with a unique value
    const uniqueCarrier = `TestCarrier_${Date.now()}`;
    await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ defaultCarrier: uniqueCarrier }),
    });

    // Audit log hook fires asynchronously — wait briefly
    await new Promise((r) => setTimeout(r, 300));

    const logsAfter = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.actorAdminUserId, adminUsrId),
          eq(adminAuditLog.action, "settings_updated"),
        ),
      )
      .orderBy(desc(adminAuditLog.createdAt));

    expect(logsAfter.length).toBeGreaterThan(countBefore);
    const latest = logsAfter[0];
    expect(latest.entityType).toBe("setting");
    expect(latest.entityId).toBe("00000000-0000-0000-0000-000000000000");
    expect(latest.afterJson).not.toBeNull();
    expect(latest.beforeJson).not.toBeNull();
    const afterJson = latest.afterJson as Record<string, unknown>;
    expect(afterJson.defaultCarrier).toBe(uniqueCarrier);
  });

  // ---- Role-gating: SETTINGS_MANAGE required for super_admin only ----

  it("rejects PATCH from admin without SETTINGS_MANAGE capability", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...noPermHeaders, "content-type": "application/json" },
      body: JSON.stringify({ defaultCarrier: "DHL" }),
    });
    expect(res.status).toBe(403);

    // Verify settings were NOT changed
    const getRes = await fetch(`${address}/api/admin/settings/shipping`, {
      headers: adminHeaders,
    });
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect(getBody.defaultCarrier).not.toBe("DHL");
  });

  // ---- Invalid setting keys / body validation ----

  it("strips unknown properties from PATCH body (removeAdditional)", async () => {
    // First set a known state
    await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ defaultCarrier: "UPS" }),
    });

    // PATCH with only unknown fields — they get stripped, no actual changes
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ unknownField: "value", anotherBadKey: 123 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Unknown fields are NOT persisted
    expect(body).not.toHaveProperty("unknownField");
    expect(body).not.toHaveProperty("anotherBadKey");
    // Existing values unchanged
    expect(body.defaultCarrier).toBe("UPS");
  });

  it("returns 404 for non-existent settings key path", async () => {
    const res = await fetch(`${address}/api/admin/settings/nonexistent`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for PATCH to non-existent settings key path", async () => {
    const res = await fetch(`${address}/api/admin/settings/nonexistent`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ key: "value" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects PATCH with wrong value types with 400", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ requireSignature: "not-a-boolean" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects PATCH with object where string expected", async () => {
    const res = await fetch(`${address}/api/admin/settings/shipping`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ defaultCarrier: { nested: "object" } }),
    });
    expect(res.status).toBe(400);
  });
});
