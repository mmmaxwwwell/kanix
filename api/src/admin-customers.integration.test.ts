import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "./db/schema/admin.js";
import { order } from "./db/schema/order.js";
import { supportTicket } from "./db/schema/support.js";
import { customer, customerAddress } from "./db/schema/customer.js";
import { authEventLog } from "./db/schema/auth-event.js";
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

describe("admin customer APIs (T224)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  // Super-admin (has CUSTOMERS_PII)
  let superAdminHeaders: Record<string, string>;
  let superAdminUserId: string;
  let superAdminRoleId: string;

  // Operator admin (support role — has CUSTOMERS_READ but NOT CUSTOMERS_PII / CUSTOMERS_MANAGE)
  let operatorHeaders: Record<string, string>;
  let operatorAdminUserId: string;
  let operatorRoleId: string;

  const ts = Date.now();
  const superAdminEmail = `test-cust-super-${ts}@kanix.dev`;
  const operatorEmail = `test-cust-operator-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  let testCustomerId: string;
  let testCustomer2Id: string;
  let testCustomerAuthSubject: string;
  let testOrderId: string;
  let testOrder2Id: string;
  let testTicketId: string;
  let testTicket2Id: string;
  let testAddressId: string;
  let testAuthEventId: string;

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

    // -- Create super_admin user --
    const superAuthSubject = await signUpUser(address, superAdminEmail, adminPassword);

    const [superRole] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_cust_super_admin_${ts}`,
        description: "Test super admin for customer tests",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    superAdminRoleId = superRole.id;

    const [superUser] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject: superAuthSubject,
        email: superAdminEmail,
        name: "Super Admin",
        status: "active",
      })
      .returning();
    superAdminUserId = superUser.id;

    await dbConn.db.insert(adminUserRole).values({
      adminUserId: superUser.id,
      adminRoleId: superRole.id,
    });
    superAdminHeaders = await signInAndGetHeaders(address, superAdminEmail, adminPassword);

    // -- Create operator (support role) user --
    const operatorAuthSubject = await signUpUser(address, operatorEmail, adminPassword);

    const [opRole] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_cust_support_${ts}`,
        description: "Test support role for customer tests",
        capabilitiesJson: ROLE_CAPABILITIES.support,
      })
      .returning();
    operatorRoleId = opRole.id;

    const [opUser] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject: operatorAuthSubject,
        email: operatorEmail,
        name: "Operator User",
        status: "active",
      })
      .returning();
    operatorAdminUserId = opUser.id;

    await dbConn.db.insert(adminUserRole).values({
      adminUserId: opUser.id,
      adminRoleId: opRole.id,
    });
    operatorHeaders = await signInAndGetHeaders(address, operatorEmail, adminPassword);

    // -- Seed test customer 1 with orders, tickets, address, and auth events --
    testCustomerAuthSubject = `cust-detail-test-${ts}`;
    const [cust1] = await dbConn.db
      .insert(customer)
      .values({
        authSubject: testCustomerAuthSubject,
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

    // Create address for customer 1
    const [addr] = await dbConn.db
      .insert(customerAddress)
      .values({
        customerId: testCustomerId,
        type: "shipping",
        fullName: "Alice TestCustomer",
        line1: "123 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
        isDefault: true,
      })
      .returning();
    testAddressId = addr.id;

    // Create auth event log entry for customer 1
    const [evt] = await dbConn.db
      .insert(authEventLog)
      .values({
        eventType: "login",
        actorId: testCustomerAuthSubject,
        ipAddress: "127.0.0.1",
        userAgent: "test-agent",
      })
      .returning();
    testAuthEventId = evt.id;
  }, 30000);

  afterAll(async () => {
    if (dbConn) {
      try {
        await dbConn.db.delete(authEventLog).where(eq(authEventLog.id, testAuthEventId));
        await dbConn.db.delete(customerAddress).where(eq(customerAddress.id, testAddressId));
        await dbConn.db.delete(supportTicket).where(eq(supportTicket.id, testTicketId));
        await dbConn.db.delete(supportTicket).where(eq(supportTicket.id, testTicket2Id));
        await dbConn.db.delete(order).where(eq(order.id, testOrderId));
        await dbConn.db.delete(order).where(eq(order.id, testOrder2Id));
        // Reset customer status in case ban test changed it
        await dbConn.db.update(customer).set({ status: "active" }).where(eq(customer.id, testCustomerId));
        await dbConn.db.delete(customer).where(eq(customer.id, testCustomerId));
        await dbConn.db.delete(customer).where(eq(customer.id, testCustomer2Id));
        await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, superAdminUserId));
        await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, operatorAdminUserId));
        await dbConn.db.delete(adminAuditLog).where(eq(adminAuditLog.actorAdminUserId, superAdminUserId));
        await dbConn.db.delete(adminAuditLog).where(eq(adminAuditLog.actorAdminUserId, operatorAdminUserId));
        await dbConn.db.delete(adminUser).where(eq(adminUser.id, superAdminUserId));
        await dbConn.db.delete(adminUser).where(eq(adminUser.id, operatorAdminUserId));
        await dbConn.db.delete(adminRole).where(eq(adminRole.id, superAdminRoleId));
        await dbConn.db.delete(adminRole).where(eq(adminRole.id, operatorRoleId));
      } catch {
        // Best-effort cleanup
      }
    }
    await stopTestServer(ts_);
  }, 15000);

  // ===================================================================
  // GET /api/admin/customers — list + search
  // ===================================================================

  it("lists customers with concrete field assertions", async () => {
    const res = await fetch(`${address}/api/admin/customers`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<Record<string, unknown>>; total: number };

    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.customers.length).toBeGreaterThanOrEqual(2);

    const alice = body.customers.find((c) => c.id === testCustomerId);
    expect(alice).toBeDefined();
    expect(alice!.email).toBe(`cust-detail-${ts}@example.com`);
    expect(alice!.firstName).toBe("Alice");
    expect(alice!.lastName).toBe("TestCustomer");
    expect(alice!.status).toBe("active");
    expect(alice!.createdAt).toBeTruthy();
  });

  it("searches customers by name", async () => {
    const res = await fetch(`${address}/api/admin/customers?search=Alice`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<Record<string, unknown>>; total: number };

    expect(body.total).toBeGreaterThanOrEqual(1);
    const found = body.customers.find((c) => c.id === testCustomerId);
    expect(found).toBeDefined();
    expect(found!.firstName).toBe("Alice");
  });

  it("searches customers by email", async () => {
    const res = await fetch(`${address}/api/admin/customers?search=bob-detail-${ts}`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<Record<string, unknown>>; total: number };

    expect(body.total).toBeGreaterThanOrEqual(1);
    const found = body.customers.find((c) => c.id === testCustomer2Id);
    expect(found).toBeDefined();
    expect(found!.firstName).toBe("Bob");
  });

  it("searches customers by order number", async () => {
    const res = await fetch(`${address}/api/admin/customers?search=CUST-ORD-1-${ts}`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<Record<string, unknown>>; total: number };

    expect(body.total).toBeGreaterThanOrEqual(1);
    const found = body.customers.find((c) => c.id === testCustomerId);
    expect(found).toBeDefined();
    expect(found!.firstName).toBe("Alice");
  });

  it("filters customers by status", async () => {
    const res = await fetch(`${address}/api/admin/customers?status=active`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<Record<string, unknown>>; total: number };

    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const c of body.customers) {
      expect(c.status).toBe("active");
    }
  });

  it("requires authentication for customer list", async () => {
    const res = await fetch(`${address}/api/admin/customers`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });

  // ===================================================================
  // GET /api/admin/customers/:id — detail
  // ===================================================================

  it("returns customer detail with stats for super_admin (full PII)", async () => {
    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.id).toBe(testCustomerId);
    expect(body.email).toBe(`cust-detail-${ts}@example.com`);
    expect(body.firstName).toBe("Alice");
    expect(body.lastName).toBe("TestCustomer");
    expect(body.phone).toBe("+15551234567");
    expect(body.status).toBe("active");

    const stats = body.stats as Record<string, number>;
    expect(stats.totalOrders).toBe(2);
    expect(stats.totalSpentMinor).toBe(2999 + 4999);
    expect(stats.openTickets).toBe(1);
  });

  it("returns 404 for non-existent customer", async () => {
    const res = await fetch(`${address}/api/admin/customers/00000000-0000-0000-0000-000000000000`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Customer not found");
  });

  // ===================================================================
  // PII redaction for operator (non-super_admin)
  // ===================================================================

  it("redacts PII for operator (support role) on customer detail", async () => {
    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}`, {
      headers: operatorHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.id).toBe(testCustomerId);
    // PII fields should be redacted
    expect(body.email).toBe("***@redacted");
    expect(body.firstName).toBe("***");
    expect(body.lastName).toBe("***");
    expect(body.phone).toBe("***-redacted");

    // Non-PII fields should still be present
    expect(body.status).toBe("active");
    const stats = body.stats as Record<string, number>;
    expect(stats.totalOrders).toBe(2);
  });

  it("redacts PII for operator on customer list", async () => {
    const res = await fetch(`${address}/api/admin/customers`, {
      headers: operatorHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<Record<string, unknown>>; total: number };

    const alice = body.customers.find((c) => c.id === testCustomerId);
    expect(alice).toBeDefined();
    expect(alice!.email).toBe("***@redacted");
    expect(alice!.firstName).toBe("***");
    expect(alice!.lastName).toBe("***");
  });

  // ===================================================================
  // GET /api/admin/customers/:id/orders
  // ===================================================================

  it("returns customer orders with concrete field assertions", async () => {
    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}/orders`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<Record<string, unknown>> };

    expect(body.orders.length).toBe(2);

    const ord1 = body.orders.find((o) => o.orderNumber === `CUST-ORD-1-${ts}`);
    expect(ord1).toBeDefined();
    expect(ord1!.status).toBe("confirmed");
    expect(ord1!.fulfillmentStatus).toBe("unfulfilled");
    expect(ord1!.totalMinor).toBe(2999);

    const ord2 = body.orders.find((o) => o.orderNumber === `CUST-ORD-2-${ts}`);
    expect(ord2).toBeDefined();
    expect(ord2!.status).toBe("completed");
    expect(ord2!.fulfillmentStatus).toBe("fulfilled");
    expect(ord2!.totalMinor).toBe(4999);
  });

  it("returns 404 for orders of non-existent customer", async () => {
    const res = await fetch(
      `${address}/api/admin/customers/00000000-0000-0000-0000-000000000000/orders`,
      { headers: superAdminHeaders },
    );
    expect(res.status).toBe(404);
  });

  // ===================================================================
  // GET /api/admin/customers/:id/tickets
  // ===================================================================

  it("returns customer tickets with concrete field assertions", async () => {
    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}/tickets`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tickets: Array<Record<string, unknown>> };

    expect(body.tickets.length).toBe(2);

    const tk1 = body.tickets.find((t) => t.ticketNumber === `CUST-TK-1-${ts}`);
    expect(tk1).toBeDefined();
    expect(tk1!.subject).toBe("Need help with order");
    expect(tk1!.category).toBe("order_issue");
    expect(tk1!.priority).toBe("normal");
    expect(tk1!.status).toBe("open");

    const tk2 = body.tickets.find((t) => t.ticketNumber === `CUST-TK-2-${ts}`);
    expect(tk2).toBeDefined();
    expect(tk2!.subject).toBe("General question");
    expect(tk2!.category).toBe("general");
    expect(tk2!.status).toBe("resolved");
  });

  it("returns 404 for tickets of non-existent customer", async () => {
    const res = await fetch(
      `${address}/api/admin/customers/00000000-0000-0000-0000-000000000000/tickets`,
      { headers: superAdminHeaders },
    );
    expect(res.status).toBe(404);
  });

  // ===================================================================
  // GET /api/admin/customers/:id/addresses
  // ===================================================================

  it("returns customer addresses with concrete field assertions", async () => {
    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}/addresses`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { addresses: Array<Record<string, unknown>> };

    expect(body.addresses.length).toBeGreaterThanOrEqual(1);
    const addr = body.addresses.find((a) => a.id === testAddressId);
    expect(addr).toBeDefined();
    expect(addr!.fullName).toBe("Alice TestCustomer");
    expect(addr!.line1).toBe("123 Main St");
    expect(addr!.city).toBe("Austin");
    expect(addr!.state).toBe("TX");
    expect(addr!.postalCode).toBe("78701");
    expect(addr!.country).toBe("US");
    expect(addr!.isDefault).toBe(true);
  });

  it("returns 404 for addresses of non-existent customer", async () => {
    const res = await fetch(
      `${address}/api/admin/customers/00000000-0000-0000-0000-000000000000/addresses`,
      { headers: superAdminHeaders },
    );
    expect(res.status).toBe(404);
  });

  // ===================================================================
  // GET /api/admin/customers/:id/audit-trail
  // ===================================================================

  it("returns customer audit trail with auth events", async () => {
    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}/audit-trail`, {
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };

    expect(body.events.length).toBeGreaterThanOrEqual(1);
    const loginEvent = body.events.find((e) => e.id === testAuthEventId);
    expect(loginEvent).toBeDefined();
    expect(loginEvent!.eventType).toBe("login");
    expect(loginEvent!.actorId).toBe(testCustomerAuthSubject);
    expect(loginEvent!.ipAddress).toBe("127.0.0.1");
    expect(loginEvent!.userAgent).toBe("test-agent");
  });

  it("returns 404 for audit trail of non-existent customer", async () => {
    const res = await fetch(
      `${address}/api/admin/customers/00000000-0000-0000-0000-000000000000/audit-trail`,
      { headers: superAdminHeaders },
    );
    expect(res.status).toBe(404);
  });

  // ===================================================================
  // POST /api/admin/customers/:id/ban + /unban
  // ===================================================================

  it("bans a customer (super_admin)", async () => {
    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}/ban`, {
      method: "POST",
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(testCustomerId);
    expect(body.status).toBe("banned");

    // Verify the customer is actually banned in the detail endpoint
    const detailRes = await fetch(`${address}/api/admin/customers/${testCustomerId}`, {
      headers: superAdminHeaders,
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as Record<string, unknown>;
    expect(detail.status).toBe("banned");
  });

  it("unbans a customer (super_admin)", async () => {
    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}/unban`, {
      method: "POST",
      headers: superAdminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(testCustomerId);
    expect(body.status).toBe("active");

    // Verify restoration
    const detailRes = await fetch(`${address}/api/admin/customers/${testCustomerId}`, {
      headers: superAdminHeaders,
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as Record<string, unknown>;
    expect(detail.status).toBe("active");
  });

  it("returns 404 when banning non-existent customer", async () => {
    const res = await fetch(
      `${address}/api/admin/customers/00000000-0000-0000-0000-000000000000/ban`,
      { method: "POST", headers: superAdminHeaders },
    );
    expect(res.status).toBe(404);
  });

  it("rejects ban from operator (missing CUSTOMERS_MANAGE)", async () => {
    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}/ban`, {
      method: "POST",
      headers: operatorHeaders,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_INSUFFICIENT_PERMISSIONS");
  });

  it("rejects unban from operator (missing CUSTOMERS_MANAGE)", async () => {
    const res = await fetch(`${address}/api/admin/customers/${testCustomerId}/unban`, {
      method: "POST",
      headers: operatorHeaders,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_INSUFFICIENT_PERMISSIONS");
  });
});
