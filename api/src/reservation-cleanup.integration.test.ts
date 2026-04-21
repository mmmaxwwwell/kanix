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

/** Helper to force-expire a reservation by setting expiresAt in the past, then running cleanup. */
async function forceExpireReservation(
  dbConn: DatabaseConnection,
  reservationId: string,
): Promise<void> {
  await dbConn.db
    .update(inventoryReservation)
    .set({ expiresAt: new Date(Date.now() - 10000) })
    .where(eq(inventoryReservation.id, reservationId));
  await releaseExpiredReservations(dbConn.db);
}

describe("reservation cleanup cron (T042)", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
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
    // Harness disables the built-in cron by default (interval 0) — we call
    // releaseExpiredReservations manually in tests.
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

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
    await stopTestServer(ts_);
  }, 15000);

  it("should expire reservation with 1s TTL and restore balance", async () => {
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
    const metrics = await releaseExpiredReservations(dbConn.db);
    expect(metrics.released).toBeGreaterThanOrEqual(1);
    expect(typeof metrics.kept).toBe("number");

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
  }, 10000);

  it("released inventory is available for new reservations", async () => {
    // Reserve 10 units with 1s TTL
    const reserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 10,
        ttl_ms: 1000,
        reservation_reason: "re_reservation_test_expired",
      }),
    });
    expect(reserveRes.status).toBe(201);
    const expiredBody = (await reserveRes.json()) as {
      reservation: { id: string };
    };

    // Wait for TTL to expire and run cleanup
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const metrics = await releaseExpiredReservations(dbConn.db);
    expect(metrics.released).toBeGreaterThanOrEqual(1);

    // Now create a new reservation using the freed stock — should succeed
    const newReserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 10,
        ttl_ms: 60000,
        reservation_reason: "re_reservation_test_new",
      }),
    });
    expect(newReserveRes.status).toBe(201);
    const newBody = (await newReserveRes.json()) as {
      reservation: { id: string; status: string; quantity: number };
    };
    expect(newBody.reservation.status).toBe("active");
    expect(newBody.reservation.quantity).toBe(10);

    // Verify balance reflects the new reservation
    const balanceRes = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balanceBody = (await balanceRes.json()) as {
      balances: Array<{ available: number; reserved: number }>;
    };
    expect(balanceBody.balances[0].reserved).toBe(10);
    expect(balanceBody.balances[0].available).toBe(40);

    // Clean up: force-expire the active reservation so balance is restored
    await forceExpireReservation(dbConn, newBody.reservation.id);
  }, 15000);

  it("cleanup is idempotent — second run releases zero", async () => {
    // Reserve 3 units with 1s TTL
    const reserveRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 3,
        ttl_ms: 1000,
        reservation_reason: "idempotency_test",
      }),
    });
    expect(reserveRes.status).toBe(201);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // First cleanup run
    const firstRun = await releaseExpiredReservations(dbConn.db);
    expect(firstRun.released).toBeGreaterThanOrEqual(1);

    // Second cleanup run — nothing left to release
    const secondRun = await releaseExpiredReservations(dbConn.db);
    expect(secondRun.released).toBe(0);

    // Balance should be fully restored
    const balanceRes = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balanceBody = (await balanceRes.json()) as {
      balances: Array<{ available: number; reserved: number }>;
    };
    expect(balanceBody.balances[0].available).toBe(50);
    expect(balanceBody.balances[0].reserved).toBe(0);
  }, 10000);

  it("cleanup returns correct metrics (released + kept counts)", async () => {
    // Create two reservations: one expired (1s TTL), one still active (60s TTL)
    const expiredRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 2,
        ttl_ms: 1000,
        reservation_reason: "metrics_test_expired",
      }),
    });
    expect(expiredRes.status).toBe(201);

    const activeRes = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 3,
        ttl_ms: 60000,
        reservation_reason: "metrics_test_active",
      }),
    });
    expect(activeRes.status).toBe(201);
    const activeBody = (await activeRes.json()) as {
      reservation: { id: string };
    };

    // Wait for the short-TTL reservation to expire
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Run cleanup — should release the expired one and report the active one as kept
    const metrics = await releaseExpiredReservations(dbConn.db);
    expect(metrics.released).toBeGreaterThanOrEqual(1);
    expect(metrics.kept).toBeGreaterThanOrEqual(1);

    // Clean up the active reservation for subsequent tests
    await forceExpireReservation(dbConn, activeBody.reservation.id);
  }, 10000);
});
