import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryAdjustment,
  inventoryMovement,
  inventoryLocation,
  inventoryReservation,
} from "./db/schema/inventory.js";
import { adminAuditLog } from "./db/schema/admin.js";
import { adminAlertPreference } from "./db/schema/alert-preference.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import {
  createLowStockAlertService,
  type LowStockAlertService,
} from "./services/low-stock-alert.js";
import type { WsManager } from "./ws/manager.js";
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

describe("low-stock alert (T043, FR-038, FR-085)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;
  let alertService: LowStockAlertService;
  let wsManager: WsManager | undefined;

  const ts = Date.now();
  const adminEmail = `test-lowstock-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";
  const defaultEmailLogPath = join(process.cwd(), "logs", "emails.jsonl");

  let testProductId: string;
  let testVariantId: string;
  let testLocationId: string;
  let testRoleId: string;

  // Use a short cooldown (2 seconds) for testability
  const COOLDOWN_MS = 2000;

  beforeAll(async () => {
    // Create alert service with short cooldown for deduplication testing
    const customAlertService = createLowStockAlertService({ cooldownMs: COOLDOWN_MS });

    ts_ = await createTestServer({
      serverOverrides: {
        lowStockAlertService: customAlertService,
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    alertService = ts_.server.lowStockAlertService;
    wsManager = ts_.server.wsManager;

    // Create admin user with super_admin role
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_lowstock_super_admin_${ts}`,
        description: "Test low-stock super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Low-Stock Admin",
        status: "active",
      })
      .returning();
    adminUserId = user.id;

    await dbConn.db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });

    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Create test product + variant
    const [testProduct] = await dbConn.db
      .insert(product)
      .values({
        title: `Low Stock Alert Test Product ${ts}`,
        slug: `lowstock-test-${ts}`,
        status: "active",
      })
      .returning();
    testProductId = testProduct.id;

    const [testVariant] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `LOWSTOCK-TEST-${ts}`,
        title: "Low Stock Test Variant",
        status: "active",
        priceMinor: 2999,
        currency: "USD",
      })
      .returning();
    testVariantId = testVariant.id;

    // Create test location
    const [location] = await dbConn.db
      .insert(inventoryLocation)
      .values({
        name: "Low Stock Test Warehouse",
        code: `lowstock-wh-${ts}`,
        type: "warehouse",
      })
      .returning();
    testLocationId = location.id;
  }, 30000);

  afterAll(async () => {
    try {
      await dbConn.db
        .delete(inventoryMovement)
        .where(eq(inventoryMovement.variantId, testVariantId));
      await dbConn.db
        .delete(inventoryReservation)
        .where(eq(inventoryReservation.variantId, testVariantId));
      await dbConn.db
        .delete(inventoryAdjustment)
        .where(eq(inventoryAdjustment.variantId, testVariantId));
      await dbConn.db
        .delete(inventoryBalance)
        .where(eq(inventoryBalance.variantId, testVariantId));
      await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, testLocationId));
      await dbConn.db.delete(productVariant).where(eq(productVariant.id, testVariantId));
      await dbConn.db.delete(product).where(eq(product.id, testProductId));
      await dbConn.db
        .delete(adminAlertPreference)
        .where(eq(adminAlertPreference.adminUserId, adminUserId));
      await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
      await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUserId));
      await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
      await dbConn.db
        .delete(adminAuditLog)
        .where(eq(adminAuditLog.actorAdminUserId, adminUserId));
    } catch {
      // Best-effort cleanup
    }
    await stopTestServer(ts_);
  }, 15000);

  // -------------------------------------------------------------------------
  // Helper: make an inventory adjustment via the API
  // -------------------------------------------------------------------------
  async function makeAdjustment(
    adjustmentType: string,
    quantityDelta: number,
    reason: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: adjustmentType,
        quantity_delta: quantityDelta,
        reason,
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  }

  // -------------------------------------------------------------------------
  // Helper: get current available balance
  // -------------------------------------------------------------------------
  async function getCurrentAvailable(): Promise<number> {
    const res = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const body = (await res.json()) as { balances: Array<{ available: number }> };
    return body.balances[0]?.available ?? 0;
  }

  // -------------------------------------------------------------------------
  // Helper: reset inventory to a known available count
  // -------------------------------------------------------------------------
  async function resetAvailableTo(target: number): Promise<void> {
    const current = await getCurrentAvailable();
    if (current < target) {
      const r = await makeAdjustment("restock", target - current, "Reset for test");
      expect(r.status).toBe(201);
    } else if (current > target) {
      const r = await makeAdjustment("shrinkage", -(current - target), "Reset for test");
      expect(r.status).toBe(201);
    }
  }

  // -------------------------------------------------------------------------
  // Core: alert queued when adjustment drops available below safety_stock
  // -------------------------------------------------------------------------
  it("queues low-stock alert when adjustment causes available < safety_stock", async () => {
    // Restock +15 units
    const restock = await makeAdjustment("restock", 15, "Initial stock for low-stock test");
    expect(restock.status).toBe(201);

    // Set safety_stock = 10
    await dbConn.db
      .update(inventoryBalance)
      .set({ safetyStock: 10 })
      .where(
        and(
          eq(inventoryBalance.variantId, testVariantId),
          eq(inventoryBalance.locationId, testLocationId),
        ),
      );

    alertService.clear();

    // Shrinkage -10 → available 15 → 5, which is < safety_stock (10)
    const shrink = await makeAdjustment("shrinkage", -10, "Shrinkage for low-stock test");
    expect(shrink.status).toBe(201);
    expect(shrink.body.low_stock).toBe(true);
    expect((shrink.body.balance as { available: number }).available).toBe(5);

    // Verify alert was queued with correct fields
    const alerts = alertService.getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].variantId).toBe(testVariantId);
    expect(alerts[0].variantSku).toBe(`LOWSTOCK-TEST-${ts}`);
    expect(alerts[0].productTitle).toBe(`Low Stock Alert Test Product ${ts}`);
    expect(alerts[0].available).toBe(5);
    expect(alerts[0].safetyStock).toBe(10);
    expect(alerts[0].timestamp).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // Core: no alert when available >= safety_stock
  // -------------------------------------------------------------------------
  it("does not queue alert when available >= safety_stock", async () => {
    alertService.clear();

    // Restock +100 → available well above safety_stock
    const res = await makeAdjustment("restock", 100, "Restock above threshold");
    expect(res.status).toBe(201);
    expect(res.body.low_stock).toBe(false);

    expect(alertService.getAlerts()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Reservation trigger: alert when reservation drops available below safety_stock
  // -------------------------------------------------------------------------
  it("queues low-stock alert when reservation causes available < safety_stock", async () => {
    await resetAvailableTo(15);

    alertService.clear();

    // Reserve 10 units → available 15 → 5, which is < safety_stock (10)
    const reserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 10,
        ttl_ms: 300000,
        reservation_reason: "low-stock-reservation-test",
      }),
    });
    expect(reserveRes.status).toBe(201);

    const alerts = alertService.getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].variantSku).toBe(`LOWSTOCK-TEST-${ts}`);
    expect(alerts[0].productTitle).toBe(`Low Stock Alert Test Product ${ts}`);
    expect(alerts[0].available).toBe(5);
    expect(alerts[0].safetyStock).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Threshold change: changing safety_stock updates alert behavior
  // -------------------------------------------------------------------------
  it("threshold change updates alert behavior", async () => {
    await resetAvailableTo(20);

    // Set safety_stock very low (2) — available 20 is well above 2
    await dbConn.db
      .update(inventoryBalance)
      .set({ safetyStock: 2 })
      .where(
        and(
          eq(inventoryBalance.variantId, testVariantId),
          eq(inventoryBalance.locationId, testLocationId),
        ),
      );

    alertService.clear();

    // Shrinkage -15 → available 20 → 5, which is >= safety_stock (2) → no alert
    const shrink1 = await makeAdjustment("shrinkage", -15, "Shrinkage with low threshold");
    expect(shrink1.status).toBe(201);
    expect(shrink1.body.low_stock).toBe(false);
    expect(alertService.getAlerts()).toHaveLength(0);

    // Raise threshold to 10
    await dbConn.db
      .update(inventoryBalance)
      .set({ safetyStock: 10 })
      .where(
        and(
          eq(inventoryBalance.variantId, testVariantId),
          eq(inventoryBalance.locationId, testLocationId),
        ),
      );

    // Shrinkage -1 → available 5 → 4, which is < safety_stock (10) → alert fires
    const shrink2 = await makeAdjustment("shrinkage", -1, "Shrinkage after threshold raise");
    expect(shrink2.status).toBe(201);
    expect(shrink2.body.low_stock).toBe(true);

    const alerts = alertService.getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].available).toBe(4);
    expect(alerts[0].safetyStock).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Deduplication: alerts suppressed within cooldown window
  // -------------------------------------------------------------------------
  it("deduplicates alerts within cooldown window", async () => {
    await resetAvailableTo(15);
    await dbConn.db
      .update(inventoryBalance)
      .set({ safetyStock: 10 })
      .where(
        and(
          eq(inventoryBalance.variantId, testVariantId),
          eq(inventoryBalance.locationId, testLocationId),
        ),
      );

    alertService.clear();

    // First shrinkage -6 → available 15 → 9, < 10 → alert fires
    const shrink1 = await makeAdjustment("shrinkage", -6, "First shrinkage for dedup");
    expect(shrink1.status).toBe(201);
    expect(shrink1.body.low_stock).toBe(true);
    expect(alertService.getAlerts()).toHaveLength(1);

    // Second shrinkage -1 → available 9 → 8, still < 10 → alert SUPPRESSED (within cooldown)
    const shrink2 = await makeAdjustment("shrinkage", -1, "Second shrinkage for dedup");
    expect(shrink2.status).toBe(201);
    expect(shrink2.body.low_stock).toBe(true);
    // Still only 1 alert — second was suppressed by cooldown
    expect(alertService.getAlerts()).toHaveLength(1);
  });

  it("fires alert again after cooldown window expires", async () => {
    // Wait for cooldown to expire (COOLDOWN_MS = 2000)
    await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS + 200));

    alertService.clear();

    // Shrinkage -1 → should now fire since cooldown expired
    const shrink = await makeAdjustment("shrinkage", -1, "Post-cooldown shrinkage");
    expect(shrink.status).toBe(201);
    expect(shrink.body.low_stock).toBe(true);
    expect(alertService.getAlerts()).toHaveLength(1);
  }, 10000);

  // -------------------------------------------------------------------------
  // Email notification: alert dispatches email to admins
  // -------------------------------------------------------------------------
  it("dispatches email notification to admin on low-stock alert", async () => {
    // Wait for cooldown to expire so alert isn't deduplicated
    await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS + 200));

    // Record the email log file size before the alert so we can find new entries
    let linesBefore = 0;
    if (existsSync(defaultEmailLogPath)) {
      linesBefore = readFileSync(defaultEmailLogPath, "utf-8").trim().split("\n").length;
    }

    await resetAvailableTo(15);
    alertService.clear();

    // Shrinkage -6 → available 9 < 10 → triggers alert + email dispatch
    const shrink = await makeAdjustment("shrinkage", -6, "Shrinkage for email test");
    expect(shrink.status).toBe(201);
    expect(shrink.body.low_stock).toBe(true);

    // Verify email was logged to JSONL
    expect(existsSync(defaultEmailLogPath)).toBe(true);
    const allLines = readFileSync(defaultEmailLogPath, "utf-8").trim().split("\n");
    const newLines = allLines.slice(linesBefore);
    expect(newLines.length).toBeGreaterThanOrEqual(1);

    // Find the email sent to our specific admin about this variant
    const parsed = newLines.map((line) => JSON.parse(line) as {
      to: string;
      subject: string;
      body: string;
      templateId: string;
      timestamp: string;
    });
    const matchingEntry = parsed.find(
      (entry) =>
        entry.templateId === "low_stock_alert" &&
        entry.subject.includes(testVariantId) &&
        entry.to === adminEmail,
    );

    expect(matchingEntry).toBeDefined();
    expect(matchingEntry!.body).toContain(testVariantId);
    expect(matchingEntry!.body).toContain("9"); // available count
    expect(matchingEntry!.body).toContain("10"); // safety stock
    expect(matchingEntry!.timestamp).toBeTruthy();
  }, 10000);

  // -------------------------------------------------------------------------
  // WebSocket notification: domain event published via wsManager
  // -------------------------------------------------------------------------
  it("publishes inventory.low_stock domain event via WebSocket manager", async () => {
    // Wait for cooldown to expire
    await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS + 200));

    expect(wsManager).toBeDefined();

    await resetAvailableTo(15);
    alertService.clear();

    // Record the buffer length right before the shrinkage that triggers the alert
    const bufLenBefore = wsManager!.messageBuffer.length;

    // Shrinkage -6 → triggers domain event via wsManager.publish
    const shrink = await makeAdjustment("shrinkage", -6, "Shrinkage for WS test");
    expect(shrink.status).toBe(201);
    expect(shrink.body.low_stock).toBe(true);

    // Check only NEW entries in the wsManager's message buffer.
    // Note: there may be multiple messages because notificationDispatch.dispatchAlert
    // publishes once per admin target (via inAppAdapter) in addition to the
    // single domainEvents.publish call. All active admins in the shared DB
    // are targets, so expect >= 1.
    const newEntries = wsManager!.messageBuffer.slice(bufLenBefore);
    const lowStockEvents = newEntries.filter(
      (m) =>
        m.message.type === "inventory.low_stock" &&
        m.message.entityId === testVariantId,
    );
    expect(lowStockEvents.length).toBeGreaterThanOrEqual(1);

    const event = lowStockEvents[0].message;
    expect(event.entity).toBe("inventory");
    expect(event.entityId).toBe(testVariantId);
    expect(event.data.available).toBe(9);
    expect(event.data.safetyStock).toBe(10);
    expect(event.data.locationId).toBe(testLocationId);
    expect(typeof event.sequenceId).toBe("number");
    expect(event.sequenceId).toBeGreaterThan(0);

    // Verify the message is on the inventory:* wildcard channel (admins receive this)
    expect(lowStockEvents[0].wildcardChannel).toBe("inventory:*");
  }, 10000);

  // -------------------------------------------------------------------------
  // Alert includes all required fields: variant SKU, product title, available, threshold
  // -------------------------------------------------------------------------
  it("alert includes variant SKU, product title, available count, and threshold", async () => {
    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS + 200));

    await resetAvailableTo(12);
    alertService.clear();

    // Shrinkage -5 → available 12 → 7
    const shrink = await makeAdjustment("shrinkage", -5, "Shrinkage for field test");
    expect(shrink.status).toBe(201);
    expect(shrink.body.low_stock).toBe(true);

    const alerts = alertService.getAlerts();
    expect(alerts).toHaveLength(1);

    const alert = alerts[0];
    // Exact field assertions — not toBeDefined/toBeTruthy
    expect(alert.variantSku).toBe(`LOWSTOCK-TEST-${ts}`);
    expect(alert.productTitle).toBe(`Low Stock Alert Test Product ${ts}`);
    expect(alert.available).toBe(7);
    expect(alert.safetyStock).toBe(10);
    expect(alert.variantId).toBe(testVariantId);
    expect(alert.timestamp.getTime()).toBeLessThanOrEqual(Date.now());
    expect(alert.timestamp.getTime()).toBeGreaterThan(Date.now() - 5000);
  }, 10000);
});
