import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
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
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import type { LowStockAlertService } from "./services/low-stock-alert.js";

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

describeWithDeps("low-stock alert (T043)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;
  let alertService: LowStockAlertService;

  const ts = Date.now();
  const adminEmail = `test-lowstock-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  let testProductId: string;
  let testVariantId: string;
  let testLocationId: string;
  let testRoleId: string;

  beforeAll(async () => {
    superTokensAvailable = await isSuperTokensUp();
    if (!superTokensAvailable) return;

    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      reservationCleanupIntervalMs: 0,
    });
    address = await server.start();
    markReady();
    app = server.app;
    alertService = server.lowStockAlertService;

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
    markNotReady();
    if (dbConn) {
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
        await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
        await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUserId));
        await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
        await dbConn.db
          .delete(adminAuditLog)
          .where(eq(adminAuditLog.actorAdminUserId, adminUserId));
      } catch {
        // Best-effort cleanup
      }
      await dbConn.close();
    }
    if (app) {
      await app.close();
    }
  }, 15000);

  it("should queue low-stock alert when adjustment causes available < safety_stock", async () => {
    if (!superTokensAvailable) return;

    // Step 1: Restock +15 units
    const restockRes = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "restock",
        quantity_delta: 15,
        reason: "Initial stock for low-stock test",
      }),
    });
    expect(restockRes.status).toBe(201);

    // Step 2: Set safety_stock = 10
    await dbConn.db
      .update(inventoryBalance)
      .set({ safetyStock: 10 })
      .where(
        and(
          eq(inventoryBalance.variantId, testVariantId),
          eq(inventoryBalance.locationId, testLocationId),
        ),
      );

    // Clear any previously queued alerts
    alertService.clear();

    // Step 3: Shrinkage -10 → available goes from 15 to 5, which is < safety_stock (10)
    const shrinkRes = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "shrinkage",
        quantity_delta: -10,
        reason: "Shrinkage for low-stock test",
      }),
    });
    expect(shrinkRes.status).toBe(201);
    const shrinkBody = (await shrinkRes.json()) as {
      low_stock: boolean;
      balance: { available: number };
    };
    expect(shrinkBody.low_stock).toBe(true);
    expect(shrinkBody.balance.available).toBe(5);

    // Step 4: Verify alert was queued
    const alerts = alertService.getAlerts();
    expect(alerts.length).toBe(1);
    expect(alerts[0].variantSku).toBe(`LOWSTOCK-TEST-${ts}`);
    expect(alerts[0].productTitle).toBe(`Low Stock Alert Test Product ${ts}`);
    expect(alerts[0].available).toBe(5);
    expect(alerts[0].safetyStock).toBe(10);
    expect(alerts[0].variantId).toBe(testVariantId);
  });

  it("should not queue alert when available >= safety_stock", async () => {
    if (!superTokensAvailable) return;

    alertService.clear();

    // Restock +100 → available will be well above safety_stock
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "restock",
        quantity_delta: 100,
        reason: "Restock above threshold",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { low_stock: boolean };
    expect(body.low_stock).toBe(false);

    // No alert should be queued
    expect(alertService.getAlerts().length).toBe(0);
  });

  it("should queue low-stock alert when reservation causes available < safety_stock", async () => {
    if (!superTokensAvailable) return;

    // Current state: available ~105, safety_stock = 10
    // First set available to a controlled value: shrinkage to bring it down
    // Reset: set available precisely by adjusting
    const balances = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balBody = (await balances.json()) as {
      balances: Array<{ available: number }>;
    };
    const currentAvailable = balBody.balances[0].available;

    // Shrink down to exactly 15 available
    if (currentAvailable > 15) {
      const shrinkRes = await fetch(`${address}/api/admin/inventory/adjustments`, {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          variant_id: testVariantId,
          location_id: testLocationId,
          adjustment_type: "shrinkage",
          quantity_delta: -(currentAvailable - 15),
          reason: "Adjust for reservation test",
        }),
      });
      expect(shrinkRes.status).toBe(201);
    }

    alertService.clear();

    // Reserve 10 units → available goes from 15 to 5, which is < safety_stock (10)
    const reserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 10,
        ttl_ms: 300000,
        reservation_reason: "low-stock-test",
      }),
    });
    expect(reserveRes.status).toBe(201);

    // Verify alert was queued
    const alerts = alertService.getAlerts();
    expect(alerts.length).toBe(1);
    expect(alerts[0].variantSku).toBe(`LOWSTOCK-TEST-${ts}`);
    expect(alerts[0].productTitle).toBe(`Low Stock Alert Test Product ${ts}`);
    expect(alerts[0].available).toBe(5);
    expect(alerts[0].safetyStock).toBe(10);
  });
});
