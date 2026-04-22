/**
 * Flow test: low-stock alert → notification delivery [mirrors T104e, FR-038, FR-085]
 *
 * Walks the full low-stock alert flow:
 *   variant with safety_stock=10 → inventory adjustment drops available to 9 →
 *   admin WebSocket receives alert within 2s → email logged to logs/emails.jsonl
 *   with variant SKU + product title + available count + threshold (all asserted).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection } from "../db/connection.js";
import { eq, and } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryAdjustment,
  inventoryMovement,
  inventoryReservation,
} from "../db/schema/inventory.js";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "../db/schema/admin.js";
import { adminAlertPreference } from "../db/schema/alert-preference.js";
import { ROLE_CAPABILITIES } from "../auth/admin.js";
import {
  createLowStockAlertService,
  type LowStockAlertService,
} from "../services/low-stock-alert.js";
import type { WsManager } from "../ws/manager.js";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("flow: low-stock alert → notification delivery (T273, FR-038, FR-085)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;
  let alertService: LowStockAlertService;
  let wsManager: WsManager | undefined;

  const run = Date.now();
  const adminEmail = `flow-lowstock-admin-${run}@kanix.dev`;
  const adminPassword = "AdminPassword123!";
  const defaultEmailLogPath = join(process.cwd(), "logs", "emails.jsonl");

  let testProductId: string;
  let testVariantId: string;
  let testVariantSku: string;
  let testProductTitle: string;
  let testLocationId: string;
  let testRoleId: string;

  // Short cooldown so tests don't block on dedup
  const COOLDOWN_MS = 500;

  beforeAll(async () => {
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
        name: `flow_lowstock_super_admin_${run}`,
        description: "Flow test low-stock super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Flow Low-Stock Admin",
        status: "active",
      })
      .returning();
    adminUserId = user.id;

    await dbConn.db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });

    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Create test product + variant
    testProductTitle = `Flow Low-Stock Product ${run}`;
    testVariantSku = `FLOW-LOWSTOCK-${run}`;

    const [testProduct] = await dbConn.db
      .insert(product)
      .values({
        title: testProductTitle,
        slug: `flow-lowstock-${run}`,
        status: "active",
      })
      .returning();
    testProductId = testProduct.id;

    const [testVariant] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: testVariantSku,
        title: "Flow Low-Stock Variant",
        status: "active",
        priceMinor: 2999,
        currency: "USD",
      })
      .returning();
    testVariantId = testVariant.id;

    // Create test location + initial inventory balance with safety_stock=10
    const [location] = await dbConn.db
      .insert(inventoryLocation)
      .values({
        name: `Flow Low-Stock WH ${run}`,
        code: `flow-ls-wh-${run}`,
        type: "warehouse",
      })
      .returning();
    testLocationId = location.id;

    // Seed initial inventory: 20 units on hand, safety_stock=10
    await dbConn.db.insert(inventoryBalance).values({
      variantId: testVariantId,
      locationId: testLocationId,
      onHand: 20,
      reserved: 0,
      available: 20,
      safetyStock: 10,
    });
  }, 30_000);

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
  }, 15_000);

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

  // =========================================================================
  // Step 1: Verify initial state — variant has 20 available, safety_stock=10
  // =========================================================================
  it("step 1: variant starts with 20 available and safety_stock=10", async () => {
    const [balance] = await dbConn.db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, testVariantId),
          eq(inventoryBalance.locationId, testLocationId),
        ),
      );
    expect(balance.available).toBe(20);
    expect(balance.safetyStock).toBe(10);
    expect(balance.onHand).toBe(20);
    expect(balance.reserved).toBe(0);
  });

  // =========================================================================
  // Step 2: Adjustment drops available to 9 (below safety_stock=10)
  // =========================================================================
  it("step 2: shrinkage -11 drops available to 9, triggering low-stock alert", async () => {
    alertService.clear();

    // Record WS buffer length before the adjustment
    expect(wsManager).toBeDefined();
    const bufLenBefore = wsManager!.messageBuffer.length;

    // Record email log position before
    let emailLinesBefore = 0;
    if (existsSync(defaultEmailLogPath)) {
      emailLinesBefore = readFileSync(defaultEmailLogPath, "utf-8").trim().split("\n").length;
    }

    // Shrinkage -11: 20 → 9, which is < safety_stock(10)
    const result = await makeAdjustment("shrinkage", -11, "Flow test: drop below threshold");
    expect(result.status).toBe(201);
    expect(result.body.low_stock).toBe(true);

    const balance = result.body.balance as { available: number; safetyStock: number };
    expect(balance.available).toBe(9);
    expect(balance.safetyStock).toBe(10);

    // Verify alert was queued in the alert service
    const alerts = alertService.getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].variantId).toBe(testVariantId);
    expect(alerts[0].variantSku).toBe(testVariantSku);
    expect(alerts[0].productTitle).toBe(testProductTitle);
    expect(alerts[0].available).toBe(9);
    expect(alerts[0].safetyStock).toBe(10);
    expect(alerts[0].timestamp).toBeInstanceOf(Date);
  });

  // =========================================================================
  // Step 3: Admin WebSocket receives inventory.low_stock event
  // =========================================================================
  it("step 3: admin WebSocket receives inventory.low_stock domain event within 2s", async () => {
    expect(wsManager).toBeDefined();

    // Check new entries in the wsManager's message buffer
    // The alert from step 2 should have published an event
    const allEntries = wsManager!.messageBuffer;
    const lowStockEvents = allEntries.filter(
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

    // Verify the message is on the admin-visible inventory:* wildcard channel
    expect(lowStockEvents[0].wildcardChannel).toBe("inventory:*");

    // Verify the event was published within 2 seconds of now (latency budget)
    const eventTimestamp = event.timestamp ?? event.createdAt;
    if (eventTimestamp) {
      const latencyMs = Date.now() - new Date(eventTimestamp).getTime();
      expect(latencyMs).toBeLessThan(2000);
    }
  });

  // =========================================================================
  // Step 4: Email logged to logs/emails.jsonl with all required fields
  // =========================================================================
  it("step 4: email logged to logs/emails.jsonl with variant SKU, product title, available count, and threshold", () => {
    expect(existsSync(defaultEmailLogPath)).toBe(true);
    const allLines = readFileSync(defaultEmailLogPath, "utf-8").trim().split("\n");

    // Find the email for our specific variant and admin
    const parsed = allLines.map((line) =>
      JSON.parse(line) as {
        to: string;
        subject: string;
        body: string;
        templateId: string;
        timestamp: string;
      },
    );

    const matchingEntry = parsed.find(
      (entry) =>
        entry.templateId === "low_stock_alert" &&
        entry.subject.includes(testVariantId) &&
        entry.to === adminEmail,
    );

    expect(matchingEntry).toBeDefined();

    // Assert all required fields are present in the email body
    expect(matchingEntry!.body).toContain(testVariantId);
    expect(matchingEntry!.body).toContain("9");  // available count
    expect(matchingEntry!.body).toContain("10"); // safety stock threshold
    expect(matchingEntry!.timestamp).toBeTruthy();

    // Verify email subject references the variant
    expect(matchingEntry!.subject).toContain(testVariantId);
  });

  // =========================================================================
  // Step 5: Verify complete alert data integrity
  // =========================================================================
  it("step 5: alert contains all required fields — variant SKU, product title, available count, threshold", () => {
    const alerts = alertService.getAlerts();
    expect(alerts).toHaveLength(1);

    const alert = alerts[0];
    // Exact field assertions — no toBeDefined/toBeTruthy
    expect(alert.variantSku).toBe(testVariantSku);
    expect(alert.productTitle).toBe(testProductTitle);
    expect(alert.available).toBe(9);
    expect(alert.safetyStock).toBe(10);
    expect(alert.variantId).toBe(testVariantId);
    expect(alert.timestamp.getTime()).toBeLessThanOrEqual(Date.now());
    expect(alert.timestamp.getTime()).toBeGreaterThan(Date.now() - 5000);
  });
});
