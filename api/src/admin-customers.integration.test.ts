import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "./db/schema/admin.js";
import { order } from "./db/schema/order.js";
import { supportTicket } from "./db/schema/support.js";
import { customer } from "./db/schema/customer.js";
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

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("admin customer detail APIs (T071b)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;
  let adminHeaders: Record<string, string>;
  let adminUsrId: string;

  const ts = Date.now();
  const adminEmail = `test-cust-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  let testRoleId: string;
  let testCustomerId: string;
  let testCustomer2Id: string;
  let testOrderId: string;
  let testOrder2Id: string;
  let testTicketId: string;
  let testTicket2Id: string;

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

    // Create admin user
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_cust_super_admin_${ts}`,
        description: "Test customer admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Customer Admin",
        status: "active",
      })
      .returning();
    adminUsrId = user.id;

    await dbConn.db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Seed test customer with orders and tickets
    const [cust1] = await dbConn.db
      .insert(customer)
      .values({
        authSubject: `cust-detail-test-${ts}`,
        email: `cust-detail-${ts}@example.com`,
        firstName: "Alice",
        lastName: "TestCustomer",
        phone: "+15551234567",
      })
      .returning();
    testCustomerId = cust1.id;

    // Second customer for search testing
    const [cust2] = await dbConn.db
      .insert(customer)
      .values({
        authSubject: `cust-detail-test2-${ts}`,
        email: `bob-detail-${ts}@example.com`,
        firstName: "Bob",
        lastName: "SearchTarget",
      })
      .returning();
    testCustomer2Id = cust2.id;

    // Create orders for customer 1
    const [ord1] = await dbConn.db
      .insert(order)
      .values({
        orderNumber: `CUST-ORD-1-${ts}`,
        customerId: testCustomerId,
        email: `cust-detail-${ts}@example.com`,
        status: "confirmed",
        fulfillmentStatus: "unfulfilled",
        subtotalMinor: 2999,
        totalMinor: 2999,
      })
      .returning();
    testOrderId = ord1.id;

    const [ord2] = await dbConn.db
      .insert(order)
      .values({
        orderNumber: `CUST-ORD-2-${ts}`,
        customerId: testCustomerId,
        email: `cust-detail-${ts}@example.com`,
        status: "completed",
        fulfillmentStatus: "fulfilled",
        subtotalMinor: 4999,
        totalMinor: 4999,
      })
      .returning();
    testOrder2Id = ord2.id;

    // Create tickets for customer 1
    const [tk1] = await dbConn.db
      .insert(supportTicket)
      .values({
        ticketNumber: `CUST-TK-1-${ts}`,
        customerId: testCustomerId,
        orderId: testOrderId,
        subject: "Need help with order",
        category: "order_issue",
        priority: "normal",
        status: "open",
        source: "web",
      })
      .returning();
    testTicketId = tk1.id;

    const [tk2] = await dbConn.db
      .insert(supportTicket)
      .values({
        ticketNumber: `CUST-TK-2-${ts}`,
        customerId: testCustomerId,
        subject: "General question",
        category: "general",
        priority: "low",
        status: "resolved",
        source: "email",
      })
      .returning();
    testTicket2Id = tk2.id;
  }, 30000);

  afterAll(async () => {
    markNotReady();
    if (dbConn) {
      try {
        await dbConn.db.delete(supportTicket).where(eq(supportTicket.id, testTicketId));
        await dbConn.db.delete(supportTicket).where(eq(supportTicket.id, testTicket2Id));
        await dbConn.db.delete(order).where(eq(order.id, testOrderId));
        await dbConn.db.delete(order).where(eq(order.id, testOrder2Id));
        await dbConn.db.delete(customer).where(eq(customer.id, testCustomerId));
        await dbConn.db.delete(customer).where(eq(customer.id, testCustomer2Id));
        await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUsrId));
        await dbConn.db.delete(adminAuditLog).where(eq(adminAuditLog.actorAdminUserId, adminUsrId));
        await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUsrId));
        await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
      } catch {
        // Best-effort cleanup
      }
      await dbConn.close();
    }
    if (app) {
      await app.close();
    }
  }, 15000);

  // ---- GET /api/admin/customers ----

  it("lists customers", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/customers`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<Record<string, unknown>>; total: number };

    expect(body).toHaveProperty("customers");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.customers)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it("searches customers by name", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/customers?search=Alice`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<Record<string, unknown>>; total: number };

    expect(body.total).toBeGreaterThanOrEqual(1);
    const found = body.customers.find((c) => c.firstName === "Alice");
    expect(found).toBeDefined();
  });

  it("searches customers by email", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/customers?search=bob-detail-${ts}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<Record<string, unknown>>; total: number };

    expect(body.total).toBeGreaterThanOrEqual(1);
    const found = body.customers.find((c) => c.firstName === "Bob");
    expect(found).toBeDefined();
  });

  it("filters customers by status", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/customers?status=active`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<Record<string, unknown>>; total: number };

    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const c of body.customers) {
      expect(c.status).toBe("active");
    }
  });

  it("requires authentication for customer list", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/customers`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });

  // ---- GET /api/admin/customers/:id ----

  it("returns customer detail with stats", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.id).toBe(testCustomerId);
    expect(body.email).toBe(`cust-detail-${ts}@example.com`);
    expect(body.firstName).toBe("Alice");
    expect(body.lastName).toBe("TestCustomer");
    expect(body).toHaveProperty("stats");

    const stats = body.stats as Record<string, number>;
    expect(stats.totalOrders).toBe(2);
    expect(stats.totalSpentMinor).toBe(2999 + 4999);
    expect(stats.openTickets).toBe(1); // only the "open" one, not the "resolved" one
  });

  it("returns 404 for non-existent customer", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/customers/00000000-0000-0000-0000-000000000000`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });

  // ---- GET /api/admin/customers/:id/orders ----

  it("returns customer orders", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}/orders`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<Record<string, unknown>> };

    expect(body).toHaveProperty("orders");
    expect(Array.isArray(body.orders)).toBe(true);
    expect(body.orders.length).toBe(2);

    const orderNumbers = body.orders.map((o) => o.orderNumber);
    expect(orderNumbers).toContain(`CUST-ORD-1-${ts}`);
    expect(orderNumbers).toContain(`CUST-ORD-2-${ts}`);
  });

  it("returns 404 for orders of non-existent customer", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(
      `${address}/api/admin/customers/00000000-0000-0000-0000-000000000000/orders`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(404);
  });

  // ---- GET /api/admin/customers/:id/tickets ----

  it("returns customer tickets", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}/tickets`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tickets: Array<Record<string, unknown>> };

    expect(body).toHaveProperty("tickets");
    expect(Array.isArray(body.tickets)).toBe(true);
    expect(body.tickets.length).toBe(2);

    const ticketNumbers = body.tickets.map((t) => t.ticketNumber);
    expect(ticketNumbers).toContain(`CUST-TK-1-${ts}`);
    expect(ticketNumbers).toContain(`CUST-TK-2-${ts}`);
  });

  it("returns 404 for tickets of non-existent customer", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(
      `${address}/api/admin/customers/00000000-0000-0000-0000-000000000000/tickets`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(404);
  });
});
