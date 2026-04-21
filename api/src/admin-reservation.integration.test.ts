import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
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

describe("inventory reservation system (T041)", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;

  const ts = Date.now();
  const adminEmail = `test-reservation-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  let testProductId: string;
  let testVariantId: string;
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
        name: `test_reservation_super_admin_${ts}`,
        description: "Test reservation super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Reservation Admin",
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
        title: `Reservation Test Product ${ts}`,
        slug: `res-test-product-${ts}`,
        status: "active",
      })
      .returning();
    testProductId = testProduct.id;

    const [testVariant] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `RES-TEST-${ts}`,
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
        name: "Test Reservation Warehouse",
        code: `test-res-wh-${ts}`,
        type: "warehouse",
      })
      .returning();
    testLocationId = location.id;

    // Seed initial inventory via the adjustments API — restock 100 units
    const restockRes = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "restock",
        quantity_delta: 100,
        reason: "Initial stock for reservation tests",
      }),
    });
    expect(restockRes.status).toBe(201);
  }, 30000);

  afterAll(async () => {
          try {
        // Cleanup in reverse dependency order
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
    await stopTestServer(ts_);
  }, 15000);

  it("should reserve → consume", async () => {
    // Reserve 5 units with 60s TTL
    const reserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 5,
        ttl_ms: 60000,
        reservation_reason: "checkout",
      }),
    });
    expect(reserveRes.status).toBe(201);
    const reserveBody = (await reserveRes.json()) as {
      reservation: { id: string; status: string; quantity: number };
      movement: { movement_type: string; quantity_delta: number };
    };
    expect(reserveBody.reservation.status).toBe("active");
    expect(reserveBody.reservation.quantity).toBe(5);
    expect(reserveBody.movement.movement_type).toBe("reservation");
    expect(reserveBody.movement.quantity_delta).toBe(-5);

    // Check balance: available should be 95, reserved should be 5
    const balanceRes = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balanceBody = (await balanceRes.json()) as {
      balances: Array<{ available: number; reserved: number; on_hand: number }>;
    };
    expect(balanceBody.balances[0].available).toBe(95);
    expect(balanceBody.balances[0].reserved).toBe(5);
    expect(balanceBody.balances[0].on_hand).toBe(100);

    // Consume the reservation
    const consumeRes = await fetch(
      `${address}/api/admin/inventory/reservations/${reserveBody.reservation.id}/consume`,
      {
        method: "POST",
        headers: adminHeaders,
      },
    );
    expect(consumeRes.status).toBe(200);
    const consumeBody = (await consumeRes.json()) as {
      reservation: { id: string; status: string };
      movement: { movement_type: string; quantity_delta: number };
    };
    expect(consumeBody.reservation.status).toBe("consumed");
    expect(consumeBody.movement.movement_type).toBe("consumption");
    expect(consumeBody.movement.quantity_delta).toBe(-5);

    // Check balance: on_hand should be 95, reserved should be 0, available should be 95
    const balanceRes2 = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balanceBody2 = (await balanceRes2.json()) as {
      balances: Array<{ available: number; reserved: number; on_hand: number }>;
    };
    expect(balanceBody2.balances[0].on_hand).toBe(95);
    expect(balanceBody2.balances[0].reserved).toBe(0);
    expect(balanceBody2.balances[0].available).toBe(95);
  });

  it("should reserve → release", async () => {
    // Reserve 10 units
    const reserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 10,
        ttl_ms: 60000,
        reservation_reason: "checkout",
      }),
    });
    expect(reserveRes.status).toBe(201);
    const reserveBody = (await reserveRes.json()) as {
      reservation: { id: string; status: string };
    };
    expect(reserveBody.reservation.status).toBe("active");

    // Check balance: available should be 85 (95 - 10), reserved should be 10
    const balanceBefore = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balanceBeforeBody = (await balanceBefore.json()) as {
      balances: Array<{ available: number; reserved: number; on_hand: number }>;
    };
    expect(balanceBeforeBody.balances[0].available).toBe(85);
    expect(balanceBeforeBody.balances[0].reserved).toBe(10);

    // Release the reservation
    const releaseRes = await fetch(
      `${address}/api/admin/inventory/reservations/${reserveBody.reservation.id}/release`,
      {
        method: "POST",
        headers: adminHeaders,
      },
    );
    expect(releaseRes.status).toBe(200);
    const releaseBody = (await releaseRes.json()) as {
      reservation: { id: string; status: string };
      movement: { movement_type: string; quantity_delta: number };
    };
    expect(releaseBody.reservation.status).toBe("released");
    expect(releaseBody.movement.movement_type).toBe("release");
    expect(releaseBody.movement.quantity_delta).toBe(10);

    // Check balance: available should be back to 95, reserved should be 0
    const balanceAfter = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balanceAfterBody = (await balanceAfter.json()) as {
      balances: Array<{ available: number; reserved: number; on_hand: number }>;
    };
    expect(balanceAfterBody.balances[0].available).toBe(95);
    expect(balanceAfterBody.balances[0].reserved).toBe(0);
    expect(balanceAfterBody.balances[0].on_hand).toBe(95);
  });

  it("should reserve → expire (TTL)", async () => {
    // Reserve 3 units with very short TTL (100ms)
    const reserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 3,
        ttl_ms: 100,
        reservation_reason: "checkout",
      }),
    });
    expect(reserveRes.status).toBe(201);
    const reserveBody = (await reserveRes.json()) as {
      reservation: { id: string; status: string };
    };
    expect(reserveBody.reservation.status).toBe("active");

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Run the expiry sweep
    const metrics = await releaseExpiredReservations(dbConn.db);
    expect(metrics.released).toBeGreaterThanOrEqual(1);

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

    // Balance should be restored: available should be 95, reserved should be 0
    const balanceRes = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balanceBody = (await balanceRes.json()) as {
      balances: Array<{ available: number; reserved: number }>;
    };
    expect(balanceBody.balances[0].available).toBe(95);
    expect(balanceBody.balances[0].reserved).toBe(0);
  });

  it("should fail concurrent reserve for last unit (one succeeds, one fails)", async () => {
    // First, set available to exactly 1 by adjusting
    // Current state: on_hand=95, available=95
    // Shrink by 94 to leave just 1 available
    const shrinkRes = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "shrinkage",
        quantity_delta: -94,
        reason: "Set up for concurrency test",
      }),
    });
    expect(shrinkRes.status).toBe(201);

    // Verify we have exactly 1 available
    const balanceCheck = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balanceCheckBody = (await balanceCheck.json()) as {
      balances: Array<{ available: number }>;
    };
    expect(balanceCheckBody.balances[0].available).toBe(1);

    // Attempt two concurrent reservations for 1 unit each
    const [res1, res2] = await Promise.all([
      fetch(`${address}/api/admin/inventory/reservations`, {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          variant_id: testVariantId,
          location_id: testLocationId,
          quantity: 1,
          ttl_ms: 60000,
          reservation_reason: "concurrent_test_1",
        }),
      }),
      fetch(`${address}/api/admin/inventory/reservations`, {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          variant_id: testVariantId,
          location_id: testLocationId,
          quantity: 1,
          ttl_ms: 60000,
          reservation_reason: "concurrent_test_2",
        }),
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // One should succeed (201) and one should fail (422)
    expect(statuses).toEqual([201, 422]);

    // The failing one should have ERR_INVENTORY_INSUFFICIENT
    const failedRes = res1.status === 422 ? res1 : res2;
    const failedBody = (await failedRes.json()) as { error: string };
    expect(failedBody.error).toBe("ERR_INVENTORY_INSUFFICIENT");
  });

  it("should reject consuming an already consumed reservation", async () => {
    // Reserve → consume → try consume again
    // Restock first to have some available
    await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "restock",
        quantity_delta: 10,
        reason: "Restock for double-consume test",
      }),
    });

    const reserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 2,
        ttl_ms: 60000,
        reservation_reason: "checkout",
      }),
    });
    expect(reserveRes.status).toBe(201);
    const { reservation } = (await reserveRes.json()) as {
      reservation: { id: string };
    };

    // First consume succeeds
    const consume1 = await fetch(
      `${address}/api/admin/inventory/reservations/${reservation.id}/consume`,
      { method: "POST", headers: adminHeaders },
    );
    expect(consume1.status).toBe(200);

    // Second consume fails
    const consume2 = await fetch(
      `${address}/api/admin/inventory/reservations/${reservation.id}/consume`,
      { method: "POST", headers: adminHeaders },
    );
    expect(consume2.status).toBe(422);
    const consume2Body = (await consume2.json()) as { error: string };
    expect(consume2Body.error).toBe("ERR_INVALID_STATUS_TRANSITION");
  });

  it("should reject releasing a consumed reservation", async () => {
    // We already have a consumed reservation from the previous test
    // Let's create a fresh one and consume it, then try to release
    const reserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 1,
        ttl_ms: 60000,
        reservation_reason: "checkout",
      }),
    });
    expect(reserveRes.status).toBe(201);
    const { reservation } = (await reserveRes.json()) as {
      reservation: { id: string };
    };

    await fetch(`${address}/api/admin/inventory/reservations/${reservation.id}/consume`, {
      method: "POST",
      headers: adminHeaders,
    });

    const releaseRes = await fetch(
      `${address}/api/admin/inventory/reservations/${reservation.id}/release`,
      { method: "POST", headers: adminHeaders },
    );
    expect(releaseRes.status).toBe(422);
    const releaseBody = (await releaseRes.json()) as { error: string };
    expect(releaseBody.error).toBe("ERR_INVALID_STATUS_TRANSITION");
  });

  it("should create inventory_movement entries for all reservation operations", async () => {
    const movements = await dbConn.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, testVariantId));

    // We should have movements for: adjustments + reservations + consumptions + releases + expires
    const types = movements.map((m) => m.movementType);
    expect(types).toContain("reservation");
    expect(types).toContain("consumption");
    expect(types).toContain("release");
  });

  it("should validate required fields on reserve", async () => {
    const res = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ variant_id: testVariantId }),
    });
    expect(res.status).toBe(400);
  });

  it("should reject non-positive quantity", async () => {
    const res = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 0,
        ttl_ms: 60000,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("should return 404 for non-existent reservation", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${address}/api/admin/inventory/reservations/${fakeId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });
});
