import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "../db/schema/admin.js";
import { authEventLog } from "../db/schema/auth-event.js";
import { product } from "../db/schema/catalog.js";
import { ROLE_CAPABILITIES } from "./admin.js";
import { findAuditLogsByEntityId } from "../db/queries/audit-log.js";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function signUpUser(
  address: string,
  email: string,
  password: string,
): Promise<{ status: string; user?: { id: string } }> {
  const res = await fetch(`${address}/auth/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
      "user-agent": "audit-log-test-agent",
    },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  return (await res.json()) as { status: string; user?: { id: string } };
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
      "user-agent": "audit-log-test-agent",
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
    "user-agent": "audit-log-test-agent",
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  if (antiCsrf) headers["anti-csrf"] = antiCsrf;
  return headers;
}

async function signInRaw(
  address: string,
  email: string,
  password: string,
): Promise<{ status: number; body: { status: string; user?: { id: string } } }> {
  const res = await fetch(`${address}/auth/signin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
      "user-agent": "audit-log-test-agent",
    },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  const body = (await res.json()) as { status: string; user?: { id: string } };
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("auth audit log (T208)", () => {
  let ts: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  // Admin user for admin-only endpoint tests
  const adminEmail = `audit-admin-${Date.now()}@kanix.dev`;
  const adminPassword = "AuditAdmin123!";
  let adminAuthSubject: string;
  let adminUserId: string;

  // Regular customer for non-admin tests
  const customerEmail = `audit-customer-${Date.now()}@kanix.dev`;
  const customerPassword = "AuditCust123!";
  let customerAuthSubject: string;

  // Track product IDs for cleanup
  const createdProductIds: string[] = [];

  beforeAll(async () => {
    ts = await createTestServer();
    app = ts.app;
    dbConn = ts.dbConn;
    address = ts.address;

    // Sign up admin user
    const adminSignup = await signUpUser(address, adminEmail, adminPassword);
    if (adminSignup.status !== "OK" || !adminSignup.user) {
      throw new Error(`Admin signup failed: ${JSON.stringify(adminSignup)}`);
    }
    adminAuthSubject = adminSignup.user.id;

    // Create admin role with super_admin capabilities
    const roleName = `test_audit_super_admin_${Date.now()}`;
    await dbConn.db
      .insert(adminRole)
      .values({
        name: roleName,
        description: "Test audit super admin role",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .onConflictDoNothing();

    const allRoles = await dbConn.db.select().from(adminRole);
    const superAdminRoleRow = allRoles.find((r) => r.name === roleName);
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

    // Wait for signup auth event to be logged
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Sign up regular customer
    const custSignup = await signUpUser(address, customerEmail, customerPassword);
    if (custSignup.status !== "OK" || !custSignup.user) {
      throw new Error(`Customer signup failed: ${JSON.stringify(custSignup)}`);
    }
    customerAuthSubject = custSignup.user.id;

    // Wait for signup auth event to be logged
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  afterAll(async () => {
    try {
      // Clean up audit log entries
      for (const pid of createdProductIds) {
        await dbConn.db.delete(adminAuditLog).where(eq(adminAuditLog.entityId, pid));
        await dbConn.db.delete(product).where(eq(product.id, pid));
      }

      // Clean up auth event log entries for test actors
      if (adminAuthSubject) {
        await dbConn.db.delete(authEventLog).where(eq(authEventLog.actorId, adminAuthSubject));
      }
      if (customerAuthSubject) {
        await dbConn.db.delete(authEventLog).where(eq(authEventLog.actorId, customerAuthSubject));
      }
      // Clean up failed login entries by email
      await dbConn.db.delete(authEventLog).where(eq(authEventLog.actorId, adminEmail));
      await dbConn.db
        .delete(authEventLog)
        .where(eq(authEventLog.actorId, "nonexistent-audit-test@kanix.dev"));

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
    await stopTestServer(ts);
  });

  // =========================================================================
  // Auth event logging — signup
  // =========================================================================

  it("signup event is logged with correct event_type, actor_id, and user_agent", async () => {
    // The admin and customer signups happened in beforeAll. Check the logs.
    const adminEvents = await dbConn.db
      .select()
      .from(authEventLog)
      .where(and(eq(authEventLog.actorId, adminAuthSubject), eq(authEventLog.eventType, "signup")));

    expect(adminEvents.length).toBeGreaterThanOrEqual(1);
    const entry = adminEvents[0];
    expect(entry.eventType).toBe("signup");
    expect(entry.actorId).toBe(adminAuthSubject);
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.userAgent).toBe("audit-log-test-agent");
    expect(entry.ipAddress).toBeTruthy();

    // Verify metadata contains email
    const metadata = entry.metadataJson as { email?: string };
    expect(metadata.email).toBe(adminEmail);
  });

  // =========================================================================
  // Auth event logging — login
  // =========================================================================

  it("login event is logged with correct fields on successful sign-in", async () => {
    // Sign in to generate a login event
    await signInAndGetHeaders(address, adminEmail, adminPassword);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const loginEvents = await dbConn.db
      .select()
      .from(authEventLog)
      .where(and(eq(authEventLog.actorId, adminAuthSubject), eq(authEventLog.eventType, "login")));

    expect(loginEvents.length).toBeGreaterThanOrEqual(1);
    const entry = loginEvents[0];
    expect(entry.eventType).toBe("login");
    expect(entry.actorId).toBe(adminAuthSubject);
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.ipAddress).toBeTruthy();
    expect(entry.userAgent).toBe("audit-log-test-agent");
  });

  // =========================================================================
  // Auth event logging — failed login
  // =========================================================================

  it("failed_login event is logged when credentials are wrong", async () => {
    const result = await signInRaw(address, adminEmail, "WrongPassword999!");
    expect(result.body.status).toBe("WRONG_CREDENTIALS_ERROR");

    await new Promise((resolve) => setTimeout(resolve, 300));

    const failedEvents = await dbConn.db
      .select()
      .from(authEventLog)
      .where(and(eq(authEventLog.actorId, adminEmail), eq(authEventLog.eventType, "failed_login")));

    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
    const entry = failedEvents[0];
    expect(entry.eventType).toBe("failed_login");
    expect(entry.actorId).toBe(adminEmail);
    expect(entry.ipAddress).toBeTruthy();
    expect(entry.userAgent).toBe("audit-log-test-agent");

    const metadata = entry.metadataJson as { reason?: string };
    expect(metadata.reason).toBe("wrong_credentials");
  });

  it("failed_login event is logged for non-existent email", async () => {
    const fakeEmail = "nonexistent-audit-test@kanix.dev";
    const result = await signInRaw(address, fakeEmail, "SomePass123!");
    expect(result.body.status).toBe("WRONG_CREDENTIALS_ERROR");

    await new Promise((resolve) => setTimeout(resolve, 300));

    const failedEvents = await dbConn.db
      .select()
      .from(authEventLog)
      .where(and(eq(authEventLog.actorId, fakeEmail), eq(authEventLog.eventType, "failed_login")));

    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
    expect(failedEvents[0].eventType).toBe("failed_login");
    expect(failedEvents[0].actorId).toBe(fakeEmail);
  });

  // =========================================================================
  // Auth event logging — logout
  // =========================================================================

  it("logout event is logged on sign-out", async () => {
    // Sign in first to get session headers
    const headers = await signInAndGetHeaders(address, customerEmail, customerPassword);

    // Sign out
    const signOutRes = await fetch(`${address}/auth/signout`, {
      method: "POST",
      headers: {
        ...headers,
        "user-agent": "audit-log-test-agent",
      },
    });
    expect(signOutRes.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));

    const logoutEvents = await dbConn.db
      .select()
      .from(authEventLog)
      .where(
        and(eq(authEventLog.actorId, customerAuthSubject), eq(authEventLog.eventType, "logout")),
      );

    expect(logoutEvents.length).toBeGreaterThanOrEqual(1);
    const entry = logoutEvents[0];
    expect(entry.eventType).toBe("logout");
    expect(entry.actorId).toBe(customerAuthSubject);
    expect(entry.ipAddress).toBeTruthy();
    expect(entry.userAgent).toBe("audit-log-test-agent");
  });

  // =========================================================================
  // Admin CRUD audit logging (existing functionality)
  // =========================================================================

  it("admin creates a product → audit log entry with correct before (null) and after (product JSON)", async () => {
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

    // The audit log is written in the onResponse hook
    await new Promise((resolve) => setTimeout(resolve, 300));

    const logs = await findAuditLogsByEntityId(dbConn.db, productId);
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const entry = logs[0];
    expect(entry.actorAdminUserId).toBe(adminUserId);
    expect(entry.action).toBe("CREATE");
    expect(entry.entityType).toBe("product");
    expect(entry.entityId).toBe(productId);
    expect(entry.beforeJson).toBeNull();
    expect(entry.afterJson).not.toBeNull();

    const afterData = entry.afterJson as { id: string; slug: string; title: string };
    expect(afterData.id).toBe(productId);
    expect(afterData.slug).toBe(slug);
    expect(afterData.title).toBe("Audit Test Product");
    expect(entry.ipAddress).toBeTruthy();

    // Verify timestamp is recent
    expect(entry.createdAt).toBeInstanceOf(Date);
    const timeDiff = Date.now() - entry.createdAt.getTime();
    expect(timeDiff).toBeLessThan(10000);
  });

  it("failed admin requests do not create audit log entries", async () => {
    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Send request with missing required fields — should fail with 400
    const res = await fetch(`${address}/api/admin/products`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ slug: "" }),
    });

    expect(res.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // All audit logs for this admin should have non-null entityId (from successful ops only)
    const allLogs = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.actorAdminUserId, adminUserId));

    for (const log of allLogs) {
      expect(log.entityId).toBeTruthy();
    }
  });

  it("read-only admin endpoints do not create audit log entries", async () => {
    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    const beforeLogs = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.actorAdminUserId, adminUserId));
    const beforeCount = beforeLogs.length;

    const res = await fetch(`${address}/api/admin/me`, { headers });
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));

    const afterLogs = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.actorAdminUserId, adminUserId));

    expect(afterLogs.length).toBe(beforeCount);
  });

  // =========================================================================
  // Admin audit-log endpoint — paginated listing
  // =========================================================================

  it("GET /api/admin/audit-log returns paginated auth event entries", async () => {
    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    const res = await fetch(`${address}/api/admin/audit-log?limit=5&page=1`, { headers });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{
        id: string;
        eventType: string;
        actorId: string;
        ipAddress: string | null;
        userAgent: string | null;
        createdAt: string;
      }>;
      total: number;
      page: number;
      limit: number;
    };

    expect(body.page).toBe(1);
    expect(body.limit).toBe(5);
    expect(typeof body.total).toBe("number");
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.length).toBeLessThanOrEqual(5);

    // Verify item shape
    const item = body.items[0];
    expect(item.id).toBeTruthy();
    expect(item.eventType).toBeTruthy();
    expect(item.actorId).toBeTruthy();
    expect(item.createdAt).toBeTruthy();
  });

  it("GET /api/admin/audit-log filters by actor_id", async () => {
    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    const res = await fetch(`${address}/api/admin/audit-log?actor_id=${adminAuthSubject}`, {
      headers,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ actorId: string; eventType: string }>;
      total: number;
    };

    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const item of body.items) {
      expect(item.actorId).toBe(adminAuthSubject);
    }
  });

  it("GET /api/admin/audit-log filters by event_type", async () => {
    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    const res = await fetch(`${address}/api/admin/audit-log?event_type=signup`, { headers });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ eventType: string }>;
      total: number;
    };

    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const item of body.items) {
      expect(item.eventType).toBe("signup");
    }
  });

  it("GET /api/admin/audit-log filters by date range", async () => {
    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const res = await fetch(
      `${address}/api/admin/audit-log?from=${oneHourAgo.toISOString()}&to=${now.toISOString()}`,
      { headers },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ createdAt: string }>;
      total: number;
    };

    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const item of body.items) {
      const ts = new Date(item.createdAt).getTime();
      expect(ts).toBeGreaterThanOrEqual(oneHourAgo.getTime());
      expect(ts).toBeLessThanOrEqual(now.getTime() + 5000); // small tolerance
    }
  });

  it("GET /api/admin/audit-log combines actor_id + event_type filters", async () => {
    const headers = await signInAndGetHeaders(address, adminEmail, adminPassword);

    const res = await fetch(
      `${address}/api/admin/audit-log?actor_id=${adminAuthSubject}&event_type=signup`,
      { headers },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ actorId: string; eventType: string }>;
      total: number;
    };

    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const item of body.items) {
      expect(item.actorId).toBe(adminAuthSubject);
      expect(item.eventType).toBe("signup");
    }
  });

  // =========================================================================
  // Non-admin access denial
  // =========================================================================

  it("non-admin users cannot access GET /api/admin/audit-log (403)", async () => {
    // Sign in as regular customer (not an admin)
    const headers = await signInAndGetHeaders(address, customerEmail, customerPassword);

    const res = await fetch(`${address}/api/admin/audit-log`, { headers });
    expect(res.status).toBe(403);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_FORBIDDEN");
  });

  it("unauthenticated requests to GET /api/admin/audit-log return 401", async () => {
    const res = await fetch(`${address}/api/admin/audit-log`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });
});
