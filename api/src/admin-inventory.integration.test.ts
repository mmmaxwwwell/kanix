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
} from "./db/schema/inventory.js";
import { adminAuditLog } from "./db/schema/admin.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { assertSuperTokensUp, getSuperTokensUri, requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();
const SUPERTOKENS_URI = getSuperTokensUri();

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: DATABASE_URL,
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

describe("admin inventory balance + adjustment API (T040)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;

  const ts = Date.now();
  const adminEmail = `test-inventory-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  // Track IDs for cleanup
  let testProductId: string;
  let testVariantId: string;
  let testLocationId: string;
  let testRoleId: string;

  beforeAll(async () => {
    await assertSuperTokensUp();

    dbConn = createDatabaseConnection(DATABASE_URL);
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
        name: `test_inventory_super_admin_${ts}`,
        description: "Test inventory super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Inventory Admin",
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
        title: `Inventory Test Product ${ts}`,
        slug: `inv-test-product-${ts}`,
        status: "active",
      })
      .returning();
    testProductId = testProduct.id;

    const [testVariant] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `INV-TEST-${ts}`,
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
        name: "Test Warehouse",
        code: `test-wh-${ts}`,
        type: "warehouse",
      })
      .returning();
    testLocationId = location.id;
  }, 30000);

  afterAll(async () => {
    markNotReady();
    if (dbConn) {
      try {
        // Cleanup in reverse dependency order
        await dbConn.db
          .delete(inventoryMovement)
          .where(eq(inventoryMovement.variantId, testVariantId));
        await dbConn.db
          .delete(inventoryAdjustment)
          .where(eq(inventoryAdjustment.variantId, testVariantId));
        await dbConn.db
          .delete(inventoryBalance)
          .where(eq(inventoryBalance.variantId, testVariantId));
        await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, testLocationId));
        await dbConn.db.delete(productVariant).where(eq(productVariant.id, testVariantId));
        await dbConn.db.delete(product).where(eq(product.id, testProductId));
        // Cleanup admin records
        await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
        await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUserId));
        await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
        // Cleanup audit logs
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

  it("should list balances (initially empty)", async () => {
    const res = await fetch(`${address}/api/admin/inventory/balances`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balances: unknown[] };
    expect(body.balances).toBeDefined();
    expect(Array.isArray(body.balances)).toBe(true);
  });

  it("should restock +100 and verify balance", async () => {
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "restock",
        quantity_delta: 100,
        reason: "Initial stock",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      adjustment: { adjustment_type: string; quantity_delta: number };
      movement: { movement_type: string };
      balance: { on_hand: number; available: number };
      low_stock: boolean;
    };
    expect(body.adjustment.adjustment_type).toBe("restock");
    expect(body.adjustment.quantity_delta).toBe(100);
    expect(body.movement.movement_type).toBe("adjustment");
    expect(body.balance.on_hand).toBe(100);
    expect(body.balance.available).toBe(100);
  });

  it("should shrinkage -5 and verify balance", async () => {
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "shrinkage",
        quantity_delta: -5,
        reason: "Missing units during audit",
        notes: "Found during weekly count",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      balance: { on_hand: number; available: number };
    };
    expect(body.balance.on_hand).toBe(95);
    expect(body.balance.available).toBe(95);
  });

  it("should filter balances by variant_id", async () => {
    const res = await fetch(`${address}/api/admin/inventory/balances?variant_id=${testVariantId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balances: Array<{ variant_id: string }> };
    expect(body.balances.length).toBeGreaterThanOrEqual(1);
    expect(body.balances[0].variant_id).toBe(testVariantId);
  });

  it("should filter balances by location_id", async () => {
    const res = await fetch(
      `${address}/api/admin/inventory/balances?location_id=${testLocationId}`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balances: Array<{ location_id: string }> };
    expect(body.balances.length).toBeGreaterThanOrEqual(1);
    expect(body.balances[0].location_id).toBe(testLocationId);
  });

  it("should detect low stock when available < safety_stock", async () => {
    // Set safety_stock to 100 — current available is 95, so it's already low
    await dbConn.db
      .update(inventoryBalance)
      .set({ safetyStock: 100 })
      .where(
        and(
          eq(inventoryBalance.variantId, testVariantId),
          eq(inventoryBalance.locationId, testLocationId),
        ),
      );

    // Make a damage adjustment (-1) and check low_stock flag
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "damage",
        quantity_delta: -1,
        reason: "Damaged unit",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { low_stock: boolean; balance: { available: number } };
    expect(body.low_stock).toBe(true);
    expect(body.balance.available).toBe(94);
  });

  it("should return low_stock_only balances via filter", async () => {
    const res = await fetch(`${address}/api/admin/inventory/balances?low_stock_only=true`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      balances: Array<{ variant_id: string; available: number; safety_stock: number }>;
    };
    // Our test variant has available=94, safety_stock=100, so it qualifies
    const match = body.balances.find((b) => b.variant_id === testVariantId);
    expect(match).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(match!.available).toBeLessThanOrEqual(match!.safety_stock);
  });

  it("should prevent negative available (CHECK constraint)", async () => {
    // Try to remove more than available (94 units)
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "shrinkage",
        quantity_delta: -200,
        reason: "Should fail",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_INVENTORY_INSUFFICIENT");
  });

  it("should create audit log entry for adjustment", async () => {
    // The previous successful adjustments should have audit log entries
    const logs = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.actorAdminUserId, adminUserId),
          eq(adminAuditLog.entityType, "inventory_adjustment"),
        ),
      );
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("should create inventory_movement ledger entries", async () => {
    const movements = await dbConn.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, testVariantId));
    // We had 3 successful adjustments: restock +100, shrinkage -5, damage -1
    expect(movements.length).toBeGreaterThanOrEqual(3);
    for (const m of movements) {
      expect(m.movementType).toBe("adjustment");
      expect(m.referenceType).toBe("adjustment");
    }
  });

  it("should reject invalid adjustment_type", async () => {
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "invalid",
        quantity_delta: 1,
        reason: "Test",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("should reject zero quantity_delta", async () => {
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "restock",
        quantity_delta: 0,
        reason: "Test",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("should reject missing required fields", async () => {
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ variant_id: testVariantId }),
    });
    expect(res.status).toBe(400);
  });

  it("should return original result for duplicate idempotency_key header (T054c)", async () => {
    const idempotencyKey = `idem-test-${Date.now()}`;
    const adjustmentBody = {
      variant_id: testVariantId,
      location_id: testLocationId,
      adjustment_type: "restock",
      quantity_delta: 10,
      reason: "Idempotency test restock",
    };

    // First request — should create the adjustment
    const res1 = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json",
        idempotency_key: idempotencyKey,
      },
      body: JSON.stringify(adjustmentBody),
    });
    expect(res1.status).toBe(201);
    const body1 = (await res1.json()) as {
      adjustment: { id: string; idempotency_key: string };
      balance: { on_hand: number };
    };
    expect(body1.adjustment.idempotency_key).toBe(idempotencyKey);

    // Second request with same key — should return original without creating another
    const res2 = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: {
        ...adminHeaders,
        "Content-Type": "application/json",
        idempotency_key: idempotencyKey,
      },
      body: JSON.stringify(adjustmentBody),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      adjustment: { id: string; idempotency_key: string };
      balance: { on_hand: number };
    };

    // Same adjustment returned
    expect(body2.adjustment.id).toBe(body1.adjustment.id);
    expect(body2.adjustment.idempotency_key).toBe(idempotencyKey);

    // Verify only one adjustment record exists with this key
    const adjustments = await dbConn.db
      .select()
      .from(inventoryAdjustment)
      .where(eq(inventoryAdjustment.idempotencyKey, idempotencyKey));
    expect(adjustments.length).toBe(1);
  });

  it("should allow different idempotency keys to create separate adjustments", async () => {
    const key1 = `idem-diff-a-${Date.now()}`;
    const key2 = `idem-diff-b-${Date.now()}`;
    const adjustmentBody = {
      variant_id: testVariantId,
      location_id: testLocationId,
      adjustment_type: "restock",
      quantity_delta: 5,
      reason: "Different key test",
    };

    const res1 = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json", idempotency_key: key1 },
      body: JSON.stringify(adjustmentBody),
    });
    expect(res1.status).toBe(201);

    const res2 = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json", idempotency_key: key2 },
      body: JSON.stringify(adjustmentBody),
    });
    expect(res2.status).toBe(201);

    const body1 = (await res1.json()) as { adjustment: { id: string } };
    const body2 = (await res2.json()) as { adjustment: { id: string } };
    expect(body1.adjustment.id).not.toBe(body2.adjustment.id);
  });
});
