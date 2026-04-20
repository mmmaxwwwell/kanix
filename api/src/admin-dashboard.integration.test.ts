import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
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

describeWithDeps("admin dashboard summary + alerts API (T071a)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;

  const ts = Date.now();
  const adminEmail = `test-dashboard-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

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
        dueBy: new Date(Date.now() + 36 * 60 * 60 * 1000), // 36 hours from now (within 48h alert threshold)
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
    markNotReady();
    if (dbConn) {
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
          .where(eq(inventoryBalance.variantId, testVariantId));
        await dbConn.db
          .delete(inventoryBalance)
          .where(eq(inventoryBalance.variantId, testVariant2Id));
        await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, testLocationId));
        await dbConn.db.delete(productVariant).where(eq(productVariant.id, testVariantId));
        await dbConn.db.delete(productVariant).where(eq(productVariant.id, testVariant2Id));
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
      await dbConn.close();
    }
    if (app) {
      await app.close();
    }
  }, 15000);

  it("GET /api/admin/dashboard/summary returns correct counts", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/dashboard/summary`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;

    // We seeded: 2 orders awaiting fulfillment, 2 open tickets, 2 low-stock variants,
    // 1 open dispute, 1 shipment with exception
    expect(body.ordersAwaitingFulfillment).toBeGreaterThanOrEqual(2);
    expect(body.openSupportTickets).toBeGreaterThanOrEqual(2);
    expect(body.lowStockVariants).toBeGreaterThanOrEqual(2);
    expect(body.openDisputes).toBeGreaterThanOrEqual(1);
    expect(body.shipmentsWithExceptions).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/admin/dashboard/summary has all required fields", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/dashboard/summary`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty("ordersAwaitingFulfillment");
    expect(body).toHaveProperty("openSupportTickets");
    expect(body).toHaveProperty("lowStockVariants");
    expect(body).toHaveProperty("openDisputes");
    expect(body).toHaveProperty("shipmentsWithExceptions");
    expect(typeof body.ordersAwaitingFulfillment).toBe("number");
    expect(typeof body.openSupportTickets).toBe("number");
    expect(typeof body.lowStockVariants).toBe("number");
    expect(typeof body.openDisputes).toBe("number");
    expect(typeof body.shipmentsWithExceptions).toBe("number");
  });

  it("GET /api/admin/dashboard/alerts returns alerts array", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/dashboard/alerts`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: Array<Record<string, unknown>> };

    expect(body).toHaveProperty("alerts");
    expect(Array.isArray(body.alerts)).toBe(true);

    // We seeded: 1 expiring reservation (12h), 1 dispute due in 36h (within 48h threshold)
    const reservationAlerts = body.alerts.filter((a) => a.type === "reservation_expiring");
    const disputeAlerts = body.alerts.filter(
      (a) => a.type === "dispute_due_soon" || a.type === "dispute_overdue",
    );
    expect(reservationAlerts.length).toBeGreaterThanOrEqual(1);
    expect(disputeAlerts.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/admin/dashboard/alerts has correct alert structure", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/dashboard/alerts`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: Array<Record<string, unknown>> };

    for (const alert of body.alerts) {
      expect(alert).toHaveProperty("type");
      expect(alert).toHaveProperty("severity");
      expect(alert).toHaveProperty("message");
      expect(alert).toHaveProperty("entityType");
      expect(alert).toHaveProperty("entityId");
      expect(["warning", "critical"]).toContain(alert.severity);
    }
  });

  it("GET /api/admin/dashboard/summary requires authentication", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/dashboard/summary`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/dashboard/alerts requires authentication", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/dashboard/alerts`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });
});
