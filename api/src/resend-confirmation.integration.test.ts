import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { order, orderLine } from "./db/schema/order.js";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { clearResendRateLimits } from "./db/queries/order-resend-confirmation.js";
import { createNotificationService } from "./services/notification.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";
import type { DatabaseConnection } from "./db/connection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function signUpUser(
  address: string,
  email: string,
  password: string,
): Promise<string> {
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("resend order confirmation API (T059d)", () => {
  let ts_: TestServer;
  let dbConn: DatabaseConnection;
  let address: string;

  const ts = Date.now();
  const adminEmail = `resend-admin-${ts}@kanix.dev`;
  const customerEmail = `resend-cust-${ts}@kanix.dev`;
  const password = "TestPassword123!";
  const emailLogPath = join(process.cwd(), "logs", `emails-resend-test-${ts}.jsonl`);

  let adminHeaders: Record<string, string>;
  let customerHeaders: Record<string, string>;
  let testOrderId = "";
  const testOrderNumber = `KNX-RESEND-${ts}`;
  const orderEmail = `order-owner-${ts}@test.kanix.dev`;

  beforeAll(async () => {
    // Clean up email log from prior runs
    if (existsSync(emailLogPath)) unlinkSync(emailLogPath);

    const notificationService = createNotificationService({ emailLogPath });

    ts_ = await createTestServer({
      serverOverrides: {
        notificationService,
      },
    });
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // Create admin user (super_admin has ORDERS_MANAGE)
    const adminAuthSubject = await signUpUser(address, adminEmail, password);
    const [role] = await db
      .insert(adminRole)
      .values({
        name: `resend_super_admin_${ts}`,
        description: "Super admin for resend confirmation tests",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();

    const [user] = await db
      .insert(adminUser)
      .values({
        authSubject: adminAuthSubject,
        email: adminEmail,
        name: "Resend Test Admin",
        status: "active",
      })
      .returning();

    await db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, password);

    // Create a non-admin customer user (no admin role)
    await signUpUser(address, customerEmail, password);
    customerHeaders = await signInAndGetHeaders(address, customerEmail, password);

    // Create a confirmed test order
    const [newOrder] = await db
      .insert(order)
      .values({
        orderNumber: testOrderNumber,
        email: orderEmail,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 5000,
        taxMinor: 250,
        shippingMinor: 599,
        totalMinor: 5849,
        placedAt: new Date(),
      })
      .returning();
    testOrderId = newOrder.id;
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId));
      await db.delete(order).where(eq(order.id, testOrderId));
    }
    await stopTestServer(ts_);
    if (existsSync(emailLogPath)) unlinkSync(emailLogPath);
  });

  it("resends order confirmation with correct response shape", async () => {
    clearResendRateLimits();

    const res = await fetch(`${address}/api/admin/orders/${testOrderId}/resend-confirmation`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      orderId: string;
      email: string;
    };
    expect(body.success).toBe(true);
    expect(body.orderId).toBe(testOrderId);
    expect(body.email).toBe(orderEmail);
  });

  it("logs email to emails.jsonl with full order contents", async () => {
    clearResendRateLimits();

    const res = await fetch(`${address}/api/admin/orders/${testOrderId}/resend-confirmation`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    // Read the email log file and verify content
    expect(existsSync(emailLogPath)).toBe(true);
    const lines = readFileSync(emailLogPath, "utf-8").trim().split("\n");
    const lastEntry = JSON.parse(lines[lines.length - 1]) as {
      to: string;
      subject: string;
      body: string;
      templateId: string;
      orderId: string;
      orderNumber: string;
      timestamp: string;
    };
    expect(lastEntry.to).toBe(orderEmail);
    expect(lastEntry.subject).toContain(testOrderNumber);
    expect(lastEntry.body).toContain(testOrderNumber);
    expect(lastEntry.templateId).toBe("order_confirmation");
    expect(lastEntry.orderId).toBe(testOrderId);
    expect(lastEntry.orderNumber).toBe(testOrderNumber);
    // Verify timestamp is a valid ISO string
    expect(new Date(lastEntry.timestamp).toISOString()).toBe(lastEntry.timestamp);
  });

  it("rate-limits resend — 429 on spam-resend", async () => {
    clearResendRateLimits();

    // First call succeeds
    const res1 = await fetch(`${address}/api/admin/orders/${testOrderId}/resend-confirmation`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res1.status).toBe(200);

    // Second call within window is rate-limited
    const res2 = await fetch(`${address}/api/admin/orders/${testOrderId}/resend-confirmation`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res2.status).toBe(429);

    const body = (await res2.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_RATE_LIMIT_EXCEEDED");
    expect(body.message).toContain("Rate limit exceeded");
  });

  it("returns 404 for non-existent order", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const res = await fetch(`${address}/api/admin/orders/${fakeId}/resend-confirmation`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_ORDER_NOT_FOUND");
    expect(body.message).toContain("not found");
  });

  it("rejects non-admin customer with 401 or 403", async () => {
    const res = await fetch(`${address}/api/admin/orders/${testOrderId}/resend-confirmation`, {
      method: "POST",
      headers: customerHeaders,
    });
    expect([401, 403]).toContain(res.status);
  });

  it("rejects unauthenticated request with 401", async () => {
    const res = await fetch(`${address}/api/admin/orders/${testOrderId}/resend-confirmation`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });

  it("allows resend after rate-limit window expires", async () => {
    clearResendRateLimits();

    // First send
    const res1 = await fetch(`${address}/api/admin/orders/${testOrderId}/resend-confirmation`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res1.status).toBe(200);

    // Should be rate-limited
    const res2 = await fetch(`${address}/api/admin/orders/${testOrderId}/resend-confirmation`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res2.status).toBe(429);

    // Clear rate limits (simulates window expiry)
    clearResendRateLimits();

    // Should succeed again
    const res3 = await fetch(`${address}/api/admin/orders/${testOrderId}/resend-confirmation`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res3.status).toBe(200);
    const body = (await res3.json()) as { success: boolean; orderId: string };
    expect(body.success).toBe(true);
    expect(body.orderId).toBe(testOrderId);
  });

  it("admin without ORDERS_MANAGE capability gets 403", async () => {
    const db = dbConn.db;

    // Create a support-role admin (no ORDERS_MANAGE)
    const supportEmail = `resend-support-${ts}@kanix.dev`;
    const supportAuthSubject = await signUpUser(address, supportEmail, password);

    const [supportRole] = await db
      .insert(adminRole)
      .values({
        name: `resend_support_${ts}`,
        description: "Support role for resend tests (no ORDERS_MANAGE)",
        capabilitiesJson: ROLE_CAPABILITIES.support,
      })
      .returning();

    const [supportUser] = await db
      .insert(adminUser)
      .values({
        authSubject: supportAuthSubject,
        email: supportEmail,
        name: "Resend Support Admin",
        status: "active",
      })
      .returning();

    await db.insert(adminUserRole).values({
      adminUserId: supportUser.id,
      adminRoleId: supportRole.id,
    });

    const supportHeaders = await signInAndGetHeaders(address, supportEmail, password);

    const res = await fetch(`${address}/api/admin/orders/${testOrderId}/resend-confirmation`, {
      method: "POST",
      headers: supportHeaders,
    });
    expect(res.status).toBe(403);
  });
});
