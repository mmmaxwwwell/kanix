import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "./db/schema/admin.js";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "./db/schema/inventory.js";
import { order } from "./db/schema/order.js";
import { supportTicket } from "./db/schema/support.js";
import { payment, dispute } from "./db/schema/payment.js";
import { shipment } from "./db/schema/fulfillment.js";
import { customer } from "./db/schema/customer.js";
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

interface DashboardSummary {
  ordersAwaitingFulfillment: number;
  openSupportTickets: number;
  lowStockVariants: number;
  openDisputes: number;
  shipmentsWithExceptions: number;
}

interface DashboardAlert {
  type: string;
  severity: "warning" | "critical";
  message: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

describe("admin dashboard aggregates (T225)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;

  const ts = Date.now();
  const adminEmail = `test-dashboard-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  // Non-admin user for 401 test
  const customerEmail = `test-dashboard-cust-${ts}@kanix.dev`;
  const customerPassword = "CustomerPassword123!";
  let customerHeaders: Record<string, string>;

  // Track IDs for cleanup
  let testRoleId: string;
  let testProductId: string;
  let testVariantId: string;
  let testVariant2Id: string;
  let testLocationId: string;
  let testCustomerId: string;
  let testOrderId: string;
  let testOrder2Id: string;
  let testTicketId: string;
  let testTicket2Id: string;
  let testPaymentId: string;
  let testDisputeId: string;
  let testShipmentId: string;
  let testReservationId: string;

  // Snapshot of counts before our seeded data
  let baselineSummary: DashboardSummary;

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

    // Capture baseline counts before seeding our test data
    const baselineRes = await fetch(`${address}/api/admin/dashboard/summary`);
    // Unauthenticated — we'll get 401. Need admin first.

    // Create admin user with super_admin role
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_dashboard_super_admin_${ts}`,
        description: "Test dashboard super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Dashboard Admin",
        status: "active",
      })
      .returning();
    adminUserId = user.id;

    await dbConn.db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Create a non-admin user for auth boundary tests
    await signUpUser(address, customerEmail, customerPassword);
    customerHeaders = await signInAndGetHeaders(address, customerEmail, customerPassword);

    // Capture baseline summary BEFORE seeding test-specific data
    const blRes = await fetch(`${address}/api/admin/dashboard/summary`, {
      headers: adminHeaders,
    });
    baselineSummary = (await blRes.json()) as DashboardSummary;

    // Seed test data with known counts

    // 1. Create product + variants for inventory
    const [testProduct] = await dbConn.db
      .insert(product)
      .values({
        title: `Dashboard Test Product ${ts}`,
        slug: `dash-test-product-${ts}`,
        status: "active",
      })
      .returning();
    testProductId = testProduct.id;

    const [variant1] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `DASH-V1-${ts}`,
        title: "Dashboard Variant 1",
        status: "active",
        priceMinor: 1999,
        currency: "USD",
      })
      .returning();
    testVariantId = variant1.id;

    const [variant2] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `DASH-V2-${ts}`,
        title: "Dashboard Variant 2",
        status: "active",
        priceMinor: 2999,
        currency: "USD",
      })
      .returning();
    testVariant2Id = variant2.id;

    // 2. Create location + low-stock inventory balances
    const [location] = await dbConn.db
      .insert(inventoryLocation)
      .values({
        name: `Dashboard Test Warehouse ${ts}`,
        code: `dash-wh-${ts}`,
        type: "warehouse",
      })
      .returning();
    testLocationId = location.id;

    // Low stock: available (2) <= safetyStock (5)
    await dbConn.db.insert(inventoryBalance).values({
      variantId: testVariantId,
      locationId: testLocationId,
      onHand: 2,
      reserved: 0,
      available: 2,
      safetyStock: 5,
    });

    // Low stock: available (0) <= safetyStock (3)
    await dbConn.db.insert(inventoryBalance).values({
      variantId: testVariant2Id,
      locationId: testLocationId,
      onHand: 1,
      reserved: 1,
      available: 0,
      safetyStock: 3,
    });

    // 3. Create customer
    const [cust] = await dbConn.db
      .insert(customer)
      .values({
        authSubject: `dash-test-cust-${ts}`,
        email: `dash-customer-${ts}@example.com`,
        firstName: "Dashboard",
        lastName: "Tester",
      })
      .returning();
    testCustomerId = cust.id;

    // 4. Create orders awaiting fulfillment
    const [ord1] = await dbConn.db
      .insert(order)
      .values({
        orderNumber: `DASH-ORD-1-${ts}`,
        customerId: testCustomerId,
        email: `dash-customer-${ts}@example.com`,
        status: "confirmed",
        fulfillmentStatus: "unfulfilled",
        subtotalMinor: 1999,
        totalMinor: 1999,
      })
      .returning();
    testOrderId = ord1.id;

    const [ord2] = await dbConn.db
      .insert(order)
      .values({
        orderNumber: `DASH-ORD-2-${ts}`,
        customerId: testCustomerId,
        email: `dash-customer-${ts}@example.com`,
        status: "confirmed",
        fulfillmentStatus: "unfulfilled",
        subtotalMinor: 2999,
        totalMinor: 2999,
      })
      .returning();
    testOrder2Id = ord2.id;

    // 5. Create open support tickets
    const [ticket1] = await dbConn.db
      .insert(supportTicket)
      .values({
        ticketNumber: `DASH-TK-1-${ts}`,
        customerId: testCustomerId,
        orderId: testOrderId,
        subject: "Dashboard test ticket 1",
        category: "order_issue",
        priority: "normal",
        status: "open",
        source: "web",
      })
      .returning();
    testTicketId = ticket1.id;

    const [ticket2] = await dbConn.db
      .insert(supportTicket)
      .values({
        ticketNumber: `DASH-TK-2-${ts}`,
        customerId: testCustomerId,
        subject: "Dashboard test ticket 2",
        category: "general",
        priority: "high",
        status: "waiting_on_internal",
        source: "web",
      })
      .returning();
    testTicket2Id = ticket2.id;

    // 6. Create payment + open dispute
    const [pay] = await dbConn.db
      .insert(payment)
      .values({
        orderId: testOrderId,
        providerPaymentIntentId: `pi_dash_test_${ts}`,
        status: "succeeded",
        amountMinor: 1999,
      })
      .returning();
    testPaymentId = pay.id;

    const [disp] = await dbConn.db
      .insert(dispute)
      .values({
        paymentId: testPaymentId,
        orderId: testOrderId,
        providerDisputeId: `dp_dash_test_${ts}`,
        reason: "fraudulent",
        amountMinor: 1999,
        status: "evidence_gathering",
        dueBy: new Date(Date.now() + 36 * 60 * 60 * 1000), // 36 hours from now
        openedAt: new Date(),
      })
      .returning();
    testDisputeId = disp.id;

    // 7. Create shipment with exception status
    const [ship] = await dbConn.db
      .insert(shipment)
      .values({
        orderId: testOrderId,
        shipmentNumber: `DASH-SHIP-1-${ts}`,
        status: "exception",
      })
      .returning();
    testShipmentId = ship.id;

    // 8. Create expiring reservation (within 24 hours)
    const [res] = await dbConn.db
      .insert(inventoryReservation)
      .values({
        orderId: testOrderId,
        variantId: testVariantId,
        locationId: testLocationId,
        quantity: 1,
        status: "pending",
        reservationReason: "checkout",
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000), // 12 hours from now
      })
      .returning();
    testReservationId = res.id;
  }, 30000);

  afterAll(async () => {
    try {
      // Cleanup in reverse dependency order
      await dbConn.db
        .delete(inventoryReservation)
        .where(eq(inventoryReservation.id, testReservationId));
      await dbConn.db.delete(shipment).where(eq(shipment.id, testShipmentId));
      await dbConn.db.delete(dispute).where(eq(dispute.id, testDisputeId));
      await dbConn.db.delete(payment).where(eq(payment.id, testPaymentId));
      await dbConn.db.delete(supportTicket).where(eq(supportTicket.id, testTicketId));
      await dbConn.db.delete(supportTicket).where(eq(supportTicket.id, testTicket2Id));
      await dbConn.db.delete(order).where(eq(order.id, testOrderId));
      await dbConn.db.delete(order).where(eq(order.id, testOrder2Id));
      await dbConn.db.delete(customer).where(eq(customer.id, testCustomerId));
      await dbConn.db
        .delete(inventoryBalance)
        .where(
          inArray(inventoryBalance.variantId, [testVariantId, testVariant2Id]),
        );
      await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, testLocationId));
      await dbConn.db
        .delete(productVariant)
        .where(inArray(productVariant.id, [testVariantId, testVariant2Id]));
      await dbConn.db.delete(product).where(eq(product.id, testProductId));
      await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
      await dbConn.db
        .delete(adminAuditLog)
        .where(eq(adminAuditLog.actorAdminUserId, adminUserId));
      await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUserId));
      await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
    } catch {
      // Best-effort cleanup
    }
    await stopTestServer(ts_);
  }, 15000);

  // ---------------------------------------------------------------------------
  // Summary endpoint — concrete delta-based assertions
  // ---------------------------------------------------------------------------

  it("returns correct aggregate counts reflecting seeded fixture data", async () => {
    const res = await fetch(`${address}/api/admin/dashboard/summary`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardSummary;

    // Delta = current - baseline = exactly what we seeded
    expect(body.ordersAwaitingFulfillment - baselineSummary.ordersAwaitingFulfillment).toBe(2);
    expect(body.openSupportTickets - baselineSummary.openSupportTickets).toBe(2);
    expect(body.lowStockVariants - baselineSummary.lowStockVariants).toBe(2);
    expect(body.openDisputes - baselineSummary.openDisputes).toBe(1);
    expect(body.shipmentsWithExceptions - baselineSummary.shipmentsWithExceptions).toBe(1);
  });

  it("summary response contains exactly the expected numeric fields", async () => {
    const res = await fetch(`${address}/api/admin/dashboard/summary`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    const expectedKeys = [
      "ordersAwaitingFulfillment",
      "openSupportTickets",
      "lowStockVariants",
      "openDisputes",
      "shipmentsWithExceptions",
    ];
    for (const key of expectedKeys) {
      expect(body[key]).toEqual(expect.any(Number));
      expect(Number.isInteger(body[key])).toBe(true);
      expect(body[key] as number).toBeGreaterThanOrEqual(0);
    }
  });

  it("adding an order increases ordersAwaitingFulfillment by exactly 1", async () => {
    const beforeRes = await fetch(`${address}/api/admin/dashboard/summary`, {
      headers: adminHeaders,
    });
    const before = (await beforeRes.json()) as DashboardSummary;

    // Insert a third order
    const [extraOrder] = await dbConn.db
      .insert(order)
      .values({
        orderNumber: `DASH-ORD-DELTA-${ts}`,
        customerId: testCustomerId,
        email: `dash-customer-${ts}@example.com`,
        status: "confirmed",
        fulfillmentStatus: "unfulfilled",
        subtotalMinor: 500,
        totalMinor: 500,
      })
      .returning();

    try {
      const afterRes = await fetch(`${address}/api/admin/dashboard/summary`, {
        headers: adminHeaders,
      });
      const after = (await afterRes.json()) as DashboardSummary;
      expect(after.ordersAwaitingFulfillment).toBe(before.ordersAwaitingFulfillment + 1);
      // Other counts should be unchanged
      expect(after.openSupportTickets).toBe(before.openSupportTickets);
      expect(after.lowStockVariants).toBe(before.lowStockVariants);
      expect(after.openDisputes).toBe(before.openDisputes);
      expect(after.shipmentsWithExceptions).toBe(before.shipmentsWithExceptions);
    } finally {
      await dbConn.db.delete(order).where(eq(order.id, extraOrder.id));
    }
  });

  // ---------------------------------------------------------------------------
  // Date range filter
  // ---------------------------------------------------------------------------

  it("date range filter narrows results to the specified window", async () => {
    // All our test data was created at ~now. Query a window that ends before our
    // test run started — should produce 0 for time-based aggregates.
    const longAgo = new Date("2020-01-01T00:00:00Z");
    const alsoLongAgo = new Date("2020-01-02T00:00:00Z");

    const res = await fetch(
      `${address}/api/admin/dashboard/summary?from=${longAgo.toISOString()}&to=${alsoLongAgo.toISOString()}`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardSummary;

    // No orders/tickets/disputes/shipments were created in Jan 2020
    expect(body.ordersAwaitingFulfillment).toBe(0);
    expect(body.openSupportTickets).toBe(0);
    expect(body.openDisputes).toBe(0);
    expect(body.shipmentsWithExceptions).toBe(0);
    // Low stock is point-in-time, unaffected by date range
    expect(body.lowStockVariants).toBeGreaterThanOrEqual(2);
  });

  it("date range filter including current time returns our seeded data", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);

    const res = await fetch(
      `${address}/api/admin/dashboard/summary?from=${oneHourAgo.toISOString()}&to=${oneHourLater.toISOString()}`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardSummary;

    // Our data was created within this 2-hour window
    expect(body.ordersAwaitingFulfillment).toBeGreaterThanOrEqual(2);
    expect(body.openSupportTickets).toBeGreaterThanOrEqual(2);
    expect(body.openDisputes).toBeGreaterThanOrEqual(1);
    expect(body.shipmentsWithExceptions).toBeGreaterThanOrEqual(1);
  });

  it("rejects invalid date in from parameter", async () => {
    const res = await fetch(
      `${address}/api/admin/dashboard/summary?from=not-a-date`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/from/i);
  });

  it("rejects invalid date in to parameter", async () => {
    const res = await fetch(
      `${address}/api/admin/dashboard/summary?to=garbage`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/to/i);
  });

  // ---------------------------------------------------------------------------
  // Timezone handling — ISO 8601 with explicit offsets
  // ---------------------------------------------------------------------------

  it("handles timezone offsets in date range parameters", async () => {
    // Use UTC+5 offset — should be parsed correctly to the same instant
    const oneHourAgoUtc = new Date(Date.now() - 60 * 60 * 1000);
    // Express the same instant as UTC+05:00
    const offset5 = new Date(oneHourAgoUtc.getTime() + 5 * 60 * 60 * 1000);
    const hours = String(offset5.getUTCHours()).padStart(2, "0");
    const mins = String(offset5.getUTCMinutes()).padStart(2, "0");
    const secs = String(offset5.getUTCSeconds()).padStart(2, "0");
    const y = offset5.getUTCFullYear();
    const mo = String(offset5.getUTCMonth() + 1).padStart(2, "0");
    const d = String(offset5.getUTCDate()).padStart(2, "0");
    const fromStr = `${y}-${mo}-${d}T${hours}:${mins}:${secs}+05:00`;

    const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);

    const res = await fetch(
      `${address}/api/admin/dashboard/summary?from=${encodeURIComponent(fromStr)}&to=${oneHourLater.toISOString()}`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardSummary;

    // The +05:00 offset should resolve to the same UTC instant as oneHourAgoUtc,
    // so our test data (created ~now) falls within the window
    expect(body.ordersAwaitingFulfillment).toBeGreaterThanOrEqual(2);
    expect(body.openSupportTickets).toBeGreaterThanOrEqual(2);
  });

  it("negative UTC offset is parsed correctly", async () => {
    // Far-past window expressed with -08:00 offset
    // 2020-01-01T00:00:00-08:00 = 2020-01-01T08:00:00Z
    const res = await fetch(
      `${address}/api/admin/dashboard/summary?from=${encodeURIComponent("2020-01-01T00:00:00-08:00")}&to=${encodeURIComponent("2020-01-02T00:00:00-08:00")}`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardSummary;

    // No data in 2020 window
    expect(body.ordersAwaitingFulfillment).toBe(0);
    expect(body.openSupportTickets).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Alerts endpoint — concrete entity-level assertions
  // ---------------------------------------------------------------------------

  it("returns reservation_expiring alert for our seeded reservation", async () => {
    const res = await fetch(`${address}/api/admin/dashboard/alerts`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: DashboardAlert[] };

    expect(Array.isArray(body.alerts)).toBe(true);

    const ourAlert = body.alerts.find(
      (a) => a.type === "reservation_expiring" && a.entityId === testReservationId,
    );
    expect(ourAlert).toBeDefined();
    expect(ourAlert!.severity).toBe("warning");
    expect(ourAlert!.entityType).toBe("inventory_reservation");
    expect(ourAlert!.message).toContain(testReservationId);
    expect(ourAlert!.metadata).toBeDefined();
    expect(ourAlert!.metadata!.variantId).toBe(testVariantId);
    expect(typeof ourAlert!.metadata!.expiresAt).toBe("string");
  });

  it("returns dispute_due_soon alert for our seeded dispute", async () => {
    const res = await fetch(`${address}/api/admin/dashboard/alerts`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: DashboardAlert[] };

    const ourDisputeAlert = body.alerts.find(
      (a) => a.type === "dispute_due_soon" && a.entityId === testDisputeId,
    );
    expect(ourDisputeAlert).toBeDefined();
    expect(ourDisputeAlert!.severity).toBe("critical");
    expect(ourDisputeAlert!.entityType).toBe("dispute");
    expect(ourDisputeAlert!.message).toContain(`dp_dash_test_${ts}`);
    expect(ourDisputeAlert!.metadata).toBeDefined();
    expect(ourDisputeAlert!.metadata!.providerDisputeId).toBe(`dp_dash_test_${ts}`);
    expect(ourDisputeAlert!.metadata!.status).toBe("evidence_gathering");
    expect(typeof ourDisputeAlert!.metadata!.dueBy).toBe("string");
  });

  it("alert severity values are limited to warning or critical", async () => {
    const res = await fetch(`${address}/api/admin/dashboard/alerts`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: DashboardAlert[] };

    for (const alert of body.alerts) {
      expect(["warning", "critical"]).toContain(alert.severity);
      expect(typeof alert.type).toBe("string");
      expect(alert.type.length).toBeGreaterThan(0);
      expect(typeof alert.message).toBe("string");
      expect(alert.message.length).toBeGreaterThan(0);
      expect(typeof alert.entityType).toBe("string");
      expect(typeof alert.entityId).toBe("string");
    }
  });

  // ---------------------------------------------------------------------------
  // Auth boundary
  // ---------------------------------------------------------------------------

  it("summary endpoint returns 401 without authentication", async () => {
    const res = await fetch(`${address}/api/admin/dashboard/summary`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });

  it("alerts endpoint returns 401 without authentication", async () => {
    const res = await fetch(`${address}/api/admin/dashboard/alerts`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });

  it("summary endpoint returns 403 for non-admin authenticated user", async () => {
    const res = await fetch(`${address}/api/admin/dashboard/summary`, {
      headers: customerHeaders,
    });
    expect(res.status).toBe(403);
  });

  it("alerts endpoint returns 403 for non-admin authenticated user", async () => {
    const res = await fetch(`${address}/api/admin/dashboard/alerts`, {
      headers: customerHeaders,
    });
    expect(res.status).toBe(403);
  });
});
