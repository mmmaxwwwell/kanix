import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
} from "./db/schema/inventory.js";
import { adminAuditLog } from "./db/schema/admin.js";
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

describe("admin inventory balance + adjustment API (T226)", () => {
  let ts_: TestServer;

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
  let testVariant2Id: string;
  let testLocationId: string;
  let testRoleId: string;

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

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

    // Create test product + variants
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

    // Second variant for bulk tests
    const [testVariant2] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `INV-TEST2-${ts}`,
        title: "Test Variant 2",
        status: "active",
        priceMinor: 1999,
        currency: "USD",
      })
      .returning();
    testVariant2Id = testVariant2.id;

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
    try {
      // Cleanup in reverse dependency order
      await dbConn.db
        .delete(inventoryMovement)
        .where(eq(inventoryMovement.variantId, testVariantId));
      await dbConn.db
        .delete(inventoryMovement)
        .where(eq(inventoryMovement.variantId, testVariant2Id));
      await dbConn.db
        .delete(inventoryAdjustment)
        .where(eq(inventoryAdjustment.variantId, testVariantId));
      await dbConn.db
        .delete(inventoryAdjustment)
        .where(eq(inventoryAdjustment.variantId, testVariant2Id));
      await dbConn.db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, testVariantId));
      await dbConn.db
        .delete(inventoryBalance)
        .where(eq(inventoryBalance.variantId, testVariant2Id));
      await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, testLocationId));
      await dbConn.db.delete(productVariant).where(eq(productVariant.id, testVariantId));
      await dbConn.db.delete(productVariant).where(eq(productVariant.id, testVariant2Id));
      await dbConn.db.delete(product).where(eq(product.id, testProductId));
      // Cleanup admin records
      await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
      await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUserId));
      await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
      // Cleanup audit logs
      await dbConn.db.delete(adminAuditLog).where(eq(adminAuditLog.actorAdminUserId, adminUserId));
    } catch {
      // Best-effort cleanup
    }
    await stopTestServer(ts_);
  }, 15000);

  // ---------------------------------------------------------------------------
  // Positive adjustment (restock)
  // ---------------------------------------------------------------------------

  it("restock +100 increases on_hand and available with correct response shape", async () => {
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
      adjustment: {
        id: string;
        adjustmentType: string;
        quantityDelta: number;
        reason: string;
        variantId: string;
        locationId: string;
      };
      movement: { id: string; movementType: string; quantityDelta: number; referenceType: string };
      balance: { onHand: number; reserved: number; available: number; safetyStock: number };
      low_stock: boolean;
    };
    // Adjustment fields
    expect(body.adjustment.adjustmentType).toBe("restock");
    expect(body.adjustment.quantityDelta).toBe(100);
    expect(body.adjustment.reason).toBe("Initial stock");
    expect(body.adjustment.variantId).toBe(testVariantId);
    expect(body.adjustment.locationId).toBe(testLocationId);
    expect(typeof body.adjustment.id).toBe("string");
    // Movement fields
    expect(body.movement.movementType).toBe("adjustment");
    expect(body.movement.quantityDelta).toBe(100);
    expect(body.movement.referenceType).toBe("adjustment");
    expect(typeof body.movement.id).toBe("string");
    // Balance fields
    expect(body.balance.onHand).toBe(100);
    expect(body.balance.available).toBe(100);
    expect(body.balance.reserved).toBe(0);
    // Low stock
    expect(body.low_stock).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Negative adjustment (shrinkage) with required reason
  // ---------------------------------------------------------------------------

  it("shrinkage -5 decreases balance with audit reason", async () => {
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
      adjustment: {
        adjustmentType: string;
        quantityDelta: number;
        reason: string;
        notes: string | null;
      };
      balance: { onHand: number; available: number };
    };
    expect(body.adjustment.adjustmentType).toBe("shrinkage");
    expect(body.adjustment.quantityDelta).toBe(-5);
    expect(body.adjustment.reason).toBe("Missing units during audit");
    expect(body.adjustment.notes).toBe("Found during weekly count");
    expect(body.balance.onHand).toBe(95);
    expect(body.balance.available).toBe(95);
  });

  it("rejects negative adjustment without reason", async () => {
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "shrinkage",
        quantity_delta: -1,
        // reason intentionally omitted
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("reason");
  });

  // ---------------------------------------------------------------------------
  // Balance filtering
  // ---------------------------------------------------------------------------

  it("lists balances filtered by variant_id with concrete field checks", async () => {
    const res = await fetch(`${address}/api/admin/inventory/balances?variant_id=${testVariantId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      balances: Array<{
        variantId: string;
        locationId: string;
        onHand: number;
        available: number;
        reserved: number;
        safetyStock: number;
      }>;
    };
    expect(body.balances.length).toBeGreaterThanOrEqual(1);
    const match = body.balances.find((b) => b.variantId === testVariantId);
    expect(match).toBeDefined();
    expect(match!.locationId).toBe(testLocationId);
    expect(match!.onHand).toBe(95);
    expect(match!.available).toBe(95);
    expect(match!.reserved).toBe(0);
  });

  it("lists balances filtered by location_id", async () => {
    const res = await fetch(
      `${address}/api/admin/inventory/balances?location_id=${testLocationId}`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      balances: Array<{ variantId: string; locationId: string }>;
    };
    expect(body.balances.length).toBeGreaterThanOrEqual(1);
    const match = body.balances.find((b) => b.locationId === testLocationId);
    expect(match).toBeDefined();
    expect(match!.locationId).toBe(testLocationId);
  });

  // ---------------------------------------------------------------------------
  // Low stock detection
  // ---------------------------------------------------------------------------

  it("detects low stock when available < safety_stock after adjustment", async () => {
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
    const body = (await res.json()) as {
      low_stock: boolean;
      balance: { available: number; safetyStock: number };
    };
    expect(body.low_stock).toBe(true);
    expect(body.balance.available).toBe(94);
    expect(body.balance.safetyStock).toBe(100);
  });

  it("returns low_stock_only balances via filter with correct fields", async () => {
    const res = await fetch(`${address}/api/admin/inventory/balances?low_stock_only=true`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      balances: Array<{ variantId: string; available: number; safetyStock: number }>;
    };
    // Our test variant has available=94, safety_stock=100, so it qualifies
    const match = body.balances.find((b) => b.variantId === testVariantId);
    expect(match).toBeDefined();
    expect(match!.available).toBeLessThanOrEqual(match!.safetyStock);
    expect(match!.available).toBe(94);
    expect(match!.safetyStock).toBe(100);
  });

  // ---------------------------------------------------------------------------
  // Negative balance prevention
  // ---------------------------------------------------------------------------

  it("prevents adjustment that would drive balance negative (returns 422)", async () => {
    // Current available is 94 — try to remove 200
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
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_INVENTORY_INSUFFICIENT");
    expect(body.message).toContain("negative");
  });

  // ---------------------------------------------------------------------------
  // Audit log
  // ---------------------------------------------------------------------------

  it("creates audit log entries for adjustments with correct entity type", async () => {
    const logs = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.actorAdminUserId, adminUserId),
          eq(adminAuditLog.entityType, "inventory_adjustment"),
        ),
      );
    // We've had 3 successful adjustments: restock +100, shrinkage -5, damage -1
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const log of logs) {
      expect(log.action).toBe("CREATE");
      expect(log.actorAdminUserId).toBe(adminUserId);
      expect(log.entityType).toBe("inventory_adjustment");
      expect(typeof log.entityId).toBe("string");
      expect(log.entityId.length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Movement ledger
  // ---------------------------------------------------------------------------

  it("creates inventory_movement ledger entries for each adjustment", async () => {
    const movements = await dbConn.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, testVariantId));
    // We had 3 successful adjustments: restock +100, shrinkage -5, damage -1
    expect(movements.length).toBeGreaterThanOrEqual(3);
    for (const m of movements) {
      expect(m.movementType).toBe("adjustment");
      expect(m.referenceType).toBe("adjustment");
      expect(typeof m.referenceId).toBe("string");
      expect(m.variantId).toBe(testVariantId);
      expect(m.locationId).toBe(testLocationId);
    }
  });

  // ---------------------------------------------------------------------------
  // Validation error paths
  // ---------------------------------------------------------------------------

  it("rejects invalid adjustment_type with 400", async () => {
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
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("adjustment_type");
  });

  it("rejects zero quantity_delta with 400", async () => {
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
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("quantity_delta");
  });

  it("rejects missing required fields with 400", async () => {
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ variant_id: testVariantId }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  it("returns original result for duplicate idempotency_key header (T054c)", async () => {
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
      adjustment: { id: string; idempotencyKey: string | null };
      balance: { onHand: number };
    };
    expect(body1.adjustment.idempotencyKey).toBe(idempotencyKey);

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
      adjustment: { id: string; idempotencyKey: string | null };
      balance: { onHand: number };
    };

    // Same adjustment returned
    expect(body2.adjustment.id).toBe(body1.adjustment.id);
    expect(body2.adjustment.idempotencyKey).toBe(idempotencyKey);

    // Verify only one adjustment record exists with this key
    const adjustments = await dbConn.db
      .select()
      .from(inventoryAdjustment)
      .where(eq(inventoryAdjustment.idempotencyKey, idempotencyKey));
    expect(adjustments.length).toBe(1);
  });

  it("allows different idempotency keys to create separate adjustments", async () => {
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

  // ---------------------------------------------------------------------------
  // Adjustment history queryable per variant
  // ---------------------------------------------------------------------------

  it("returns adjustment history for a variant ordered by creation time", async () => {
    const res = await fetch(
      `${address}/api/admin/inventory/adjustments?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      adjustments: Array<{
        id: string;
        variantId: string;
        adjustmentType: string;
        quantityDelta: number;
        reason: string;
        actorAdminUserId: string;
        createdAt: string;
      }>;
    };
    // We've done: restock +100, shrinkage -5, damage -1, restock +10 (idem), restock +5, restock +5
    expect(body.adjustments.length).toBeGreaterThanOrEqual(3);
    for (const adj of body.adjustments) {
      expect(adj.variantId).toBe(testVariantId);
      expect(typeof adj.id).toBe("string");
      expect(typeof adj.adjustmentType).toBe("string");
      expect(typeof adj.quantityDelta).toBe("number");
      expect(typeof adj.reason).toBe("string");
      expect(adj.reason.length).toBeGreaterThan(0);
      expect(typeof adj.createdAt).toBe("string");
    }
    // Most recent first (descending order)
    const dates = body.adjustments.map((a) => new Date(a.createdAt).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it("returns empty adjustments array when variant has no history", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${address}/api/admin/inventory/adjustments?variant_id=${fakeId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { adjustments: unknown[] };
    expect(body.adjustments).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Bulk adjustment endpoint
  // ---------------------------------------------------------------------------

  it("processes bulk adjustments for multiple variants", async () => {
    const res = await fetch(`${address}/api/admin/inventory/adjustments/bulk`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        adjustments: [
          {
            variant_id: testVariant2Id,
            location_id: testLocationId,
            adjustment_type: "restock",
            quantity_delta: 50,
            reason: "Bulk restock variant 2",
          },
          {
            variant_id: testVariantId,
            location_id: testLocationId,
            adjustment_type: "restock",
            quantity_delta: 10,
            reason: "Bulk restock variant 1",
          },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      results: Array<{
        index: number;
        adjustment: { id: string; variantId: string; quantityDelta: number };
        balance: { onHand: number; available: number };
      }>;
      errors: Array<{ index: number; error: string }>;
    };
    expect(body.results.length).toBe(2);
    expect(body.errors.length).toBe(0);
    // First result is variant2 with 50
    expect(body.results[0].index).toBe(0);
    expect(body.results[0].adjustment.variantId).toBe(testVariant2Id);
    expect(body.results[0].balance.onHand).toBe(50);
    // Second result is variant1 with +10 on top of existing
    expect(body.results[1].index).toBe(1);
    expect(body.results[1].adjustment.variantId).toBe(testVariantId);
  });

  it("bulk endpoint returns errors for invalid items alongside successes", async () => {
    const res = await fetch(`${address}/api/admin/inventory/adjustments/bulk`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        adjustments: [
          {
            variant_id: testVariantId,
            location_id: testLocationId,
            adjustment_type: "restock",
            quantity_delta: 5,
            reason: "Valid item",
          },
          {
            variant_id: testVariantId,
            location_id: testLocationId,
            adjustment_type: "invalid_type",
            quantity_delta: 5,
            reason: "Bad type",
          },
          {
            variant_id: testVariantId,
            location_id: testLocationId,
            adjustment_type: "shrinkage",
            quantity_delta: -99999,
            reason: "Would go negative",
          },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      results: Array<{ index: number }>;
      errors: Array<{ index: number; error: string; message: string }>;
    };
    // First item succeeds
    expect(body.results.length).toBe(1);
    expect(body.results[0].index).toBe(0);
    // Second item fails validation, third fails insufficient balance
    expect(body.errors.length).toBe(2);
    expect(body.errors[0].index).toBe(1);
    expect(body.errors[0].error).toBe("ERR_VALIDATION");
    expect(body.errors[1].index).toBe(2);
    expect(body.errors[1].error).toBe("ERR_INVENTORY_INSUFFICIENT");
  });

  it("bulk endpoint rejects empty array", async () => {
    const res = await fetch(`${address}/api/admin/inventory/adjustments/bulk`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ adjustments: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_VALIDATION");
  });
});
