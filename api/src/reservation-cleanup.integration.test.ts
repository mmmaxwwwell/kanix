import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryReservation,
  inventoryMovement,
  inventoryLocation,
} from "./db/schema/inventory.js";
import { adminAuditLog } from "./db/schema/admin.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { releaseExpiredReservations } from "./db/queries/reservation.js";

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

describeWithDeps("reservation cleanup cron (T042)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;

  const ts = Date.now();
  const adminEmail = `test-cleanup-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  let testProductId: string;
  let testVariantId: string;
  let testLocationId: string;
  let testRoleId: string;

  beforeAll(async () => {
    superTokensAvailable = await isSuperTokensUp();
    if (!superTokensAvailable) return;

    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    // Disable the built-in cron (interval 0) — we call releaseExpiredReservations manually
    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      reservationCleanupIntervalMs: 0,
    });
    address = await server.start();
    markReady();
    app = server.app;

    // Create admin user with super_admin role
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_cleanup_super_admin_${ts}`,
        description: "Test cleanup super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Cleanup Admin",
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
        title: `Cleanup Test Product ${ts}`,
        slug: `cleanup-test-product-${ts}`,
        status: "active",
      })
      .returning();
    testProductId = testProduct.id;

    const [testVariant] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `CLEANUP-TEST-${ts}`,
        title: "Test Variant",
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
        name: "Test Cleanup Warehouse",
        code: `test-cleanup-wh-${ts}`,
        type: "warehouse",
      })
      .returning();
    testLocationId = location.id;

    // Seed initial inventory — restock 50 units
    const restockRes = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "restock",
        quantity_delta: 50,
        reason: "Initial stock for cleanup tests",
      }),
    });
    expect(restockRes.status).toBe(201);
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

  it("should expire reservation with 1s TTL and restore balance", async () => {
    if (!superTokensAvailable) return;

    // Reserve 5 units with 1s TTL
    const reserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 5,
        ttl_ms: 1000,
        reservation_reason: "cleanup_test",
      }),
    });
    expect(reserveRes.status).toBe(201);
    const reserveBody = (await reserveRes.json()) as {
      reservation: { id: string; status: string };
    };
    expect(reserveBody.reservation.status).toBe("active");

    // Verify balance: available should be 45 (50 - 5), reserved should be 5
    const balanceBefore = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balanceBeforeBody = (await balanceBefore.json()) as {
      balances: Array<{ available: number; reserved: number; on_hand: number }>;
    };
    expect(balanceBeforeBody.balances[0].available).toBe(45);
    expect(balanceBeforeBody.balances[0].reserved).toBe(5);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Run the cleanup (simulates what the cron does)
    const released = await releaseExpiredReservations(dbConn.db);
    expect(released).toBeGreaterThanOrEqual(1);

    // Verify the reservation is now expired
    const getRes = await fetch(
      `${address}/api/admin/inventory/reservations/${reserveBody.reservation.id}`,
      { headers: adminHeaders },
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      reservation: { id: string; status: string };
    };
    expect(getBody.reservation.status).toBe("expired");

    // Balance should be restored: available should be 50, reserved should be 0
    const balanceAfter = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balanceAfterBody = (await balanceAfter.json()) as {
      balances: Array<{ available: number; reserved: number; on_hand: number }>;
    };
    expect(balanceAfterBody.balances[0].available).toBe(50);
    expect(balanceAfterBody.balances[0].reserved).toBe(0);
    expect(balanceAfterBody.balances[0].on_hand).toBe(50);
  }, 10000);
});
