import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "./db/schema/admin.js";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryReservation,
  inventoryMovement,
  inventoryLocation,
} from "./db/schema/inventory.js";
import { ROLE_CAPABILITIES, CAPABILITIES } from "./auth/admin.js";
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

describe("admin reservation view + override (T228)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  // Admin with super_admin (full capabilities)
  let adminHeaders: Record<string, string>;
  let adminUserId: string;

  // Non-admin user (customer — no admin record)
  let nonAdminHeaders: Record<string, string>;

  const ts = Date.now();
  const adminEmail = `t228-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";
  const nonAdminEmail = `t228-customer-${ts}@kanix.dev`;
  const nonAdminPassword = "CustomerPass123!";

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
        name: `t228_super_admin_${ts}`,
        description: "T228 test super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "T228 Admin",
        status: "active",
      })
      .returning();
    adminUserId = user.id;

    await dbConn.db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // Create non-admin user (just a customer — no admin_user row)
    await signUpUser(address, nonAdminEmail, nonAdminPassword);
    nonAdminHeaders = await signInAndGetHeaders(address, nonAdminEmail, nonAdminPassword);

    // Create test product + variant
    const [testProduct] = await dbConn.db
      .insert(product)
      .values({
        title: `T228 Reservation Product ${ts}`,
        slug: `t228-res-product-${ts}`,
        status: "active",
      })
      .returning();
    testProductId = testProduct.id;

    const [testVariant] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `T228-RES-${ts}`,
        title: "T228 Variant",
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
        name: "T228 Warehouse",
        code: `t228-wh-${ts}`,
        type: "warehouse",
      })
      .returning();
    testLocationId = location.id;

    // Seed initial inventory — restock 100 units
    const restockRes = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        adjustment_type: "restock",
        quantity_delta: 100,
        reason: "Initial stock for T228 reservation tests",
      }),
    });
    expect(restockRes.status).toBe(201);
  }, 30000);

  afterAll(async () => {
    try {
      await dbConn.db.delete(adminAuditLog).where(eq(adminAuditLog.actorAdminUserId, adminUserId));
      await dbConn.db
        .delete(inventoryMovement)
        .where(eq(inventoryMovement.variantId, testVariantId));
      await dbConn.db
        .delete(inventoryReservation)
        .where(eq(inventoryReservation.variantId, testVariantId));
      await dbConn.db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, testVariantId));
      await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, testLocationId));
      await dbConn.db.delete(productVariant).where(eq(productVariant.id, testVariantId));
      await dbConn.db.delete(product).where(eq(product.id, testProductId));
      await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
      await dbConn.db.delete(adminUser).where(eq(adminUser.id, adminUserId));
      await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
    } catch {
      // Best-effort cleanup
    }
    await stopTestServer(ts_);
  }, 15000);

  // Helper: create a reservation and return its id + response body
  async function createReservation(qty: number, ttlMs = 60000, reason = "checkout") {
    const res = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: qty,
        ttl_ms: ttlMs,
        reservation_reason: reason,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      reservation: {
        id: string;
        status: string;
        quantity: number;
        variantId: string;
        locationId: string;
        reservationReason: string;
        expiresAt: string;
      };
      movement: { movementType: string; quantityDelta: number };
    };
    return body;
  }

  // -----------------------------------------------------------------------
  // Core reservation lifecycle (existing tests, hardened)
  // -----------------------------------------------------------------------

  it("reserve → consume with concrete balance assertions", async () => {
    const { reservation, movement } = await createReservation(5);
    expect(reservation.status).toBe("active");
    expect(reservation.quantity).toBe(5);
    expect(reservation.variantId).toBe(testVariantId);
    expect(reservation.locationId).toBe(testLocationId);
    expect(reservation.reservationReason).toBe("checkout");
    expect(typeof reservation.expiresAt).toBe("string");
    expect(movement.movementType).toBe("reservation");
    expect(movement.quantityDelta).toBe(-5);

    // Check balance
    const balRes = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balBody = (await balRes.json()) as {
      balances: Array<{ available: number; reserved: number; onHand: number }>;
    };
    expect(balBody.balances[0].available).toBe(95);
    expect(balBody.balances[0].reserved).toBe(5);
    expect(balBody.balances[0].onHand).toBe(100);

    // Consume
    const consumeRes = await fetch(
      `${address}/api/admin/inventory/reservations/${reservation.id}/consume`,
      { method: "POST", headers: adminHeaders },
    );
    expect(consumeRes.status).toBe(200);
    const consumeBody = (await consumeRes.json()) as {
      reservation: { id: string; status: string };
      movement: { movementType: string; quantityDelta: number };
    };
    expect(consumeBody.reservation.status).toBe("consumed");
    expect(consumeBody.movement.movementType).toBe("consumption");
    expect(consumeBody.movement.quantityDelta).toBe(-5);

    // Balance after consume: on_hand=95, reserved=0, available=95
    const bal2 = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const bal2Body = (await bal2.json()) as {
      balances: Array<{ available: number; reserved: number; onHand: number }>;
    };
    expect(bal2Body.balances[0].onHand).toBe(95);
    expect(bal2Body.balances[0].reserved).toBe(0);
    expect(bal2Body.balances[0].available).toBe(95);
  });

  it("reserve → release restores inventory", async () => {
    const { reservation } = await createReservation(10);
    expect(reservation.status).toBe("active");

    // Balance: available=85, reserved=10
    const balBefore = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balBeforeBody = (await balBefore.json()) as {
      balances: Array<{ available: number; reserved: number }>;
    };
    expect(balBeforeBody.balances[0].available).toBe(85);
    expect(balBeforeBody.balances[0].reserved).toBe(10);

    // Release
    const releaseRes = await fetch(
      `${address}/api/admin/inventory/reservations/${reservation.id}/release`,
      { method: "POST", headers: adminHeaders },
    );
    expect(releaseRes.status).toBe(200);
    const releaseBody = (await releaseRes.json()) as {
      reservation: { status: string };
      movement: { movementType: string; quantityDelta: number };
    };
    expect(releaseBody.reservation.status).toBe("released");
    expect(releaseBody.movement.movementType).toBe("release");
    expect(releaseBody.movement.quantityDelta).toBe(10);

    // Balance restored
    const balAfter = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balAfterBody = (await balAfter.json()) as {
      balances: Array<{ available: number; reserved: number; onHand: number }>;
    };
    expect(balAfterBody.balances[0].available).toBe(95);
    expect(balAfterBody.balances[0].reserved).toBe(0);
    expect(balAfterBody.balances[0].onHand).toBe(95);
  });

  it("reserve → expire via TTL + cleanup", async () => {
    const { reservation } = await createReservation(3, 100);
    expect(reservation.status).toBe("active");

    // Wait for TTL
    await new Promise((resolve) => setTimeout(resolve, 200));

    const metrics = await releaseExpiredReservations(dbConn.db);
    expect(metrics.released).toBeGreaterThanOrEqual(1);

    // Verify expired
    const getRes = await fetch(`${address}/api/admin/inventory/reservations/${reservation.id}`, {
      headers: adminHeaders,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { reservation: { status: string } };
    expect(getBody.reservation.status).toBe("expired");

    // Balance restored
    const balRes = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balBody = (await balRes.json()) as {
      balances: Array<{ available: number; reserved: number }>;
    };
    expect(balBody.balances[0].available).toBe(95);
    expect(balBody.balances[0].reserved).toBe(0);
  });

  // -----------------------------------------------------------------------
  // List reservations with filters
  // -----------------------------------------------------------------------

  it("list active reservations filtered by variant_id", async () => {
    // Create two reservations
    const r1 = await createReservation(2, 60000, "list_test_1");
    const r2 = await createReservation(3, 60000, "list_test_2");

    const listRes = await fetch(
      `${address}/api/admin/inventory/reservations/list?variant_id=${testVariantId}&status=active`,
      { headers: adminHeaders },
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      reservations: Array<{ id: string; status: string; variantId: string; quantity: number }>;
    };
    expect(Array.isArray(listBody.reservations)).toBe(true);

    const activeForVariant = listBody.reservations.filter(
      (r) => r.variantId === testVariantId && r.status === "active",
    );
    expect(activeForVariant.length).toBeGreaterThanOrEqual(2);

    const ids = activeForVariant.map((r) => r.id);
    expect(ids).toContain(r1.reservation.id);
    expect(ids).toContain(r2.reservation.id);

    // Cleanup: release both
    await fetch(`${address}/api/admin/inventory/reservations/${r1.reservation.id}/release`, {
      method: "POST",
      headers: adminHeaders,
    });
    await fetch(`${address}/api/admin/inventory/reservations/${r2.reservation.id}/release`, {
      method: "POST",
      headers: adminHeaders,
    });
  });

  it("list reservations filtered by expires_before", async () => {
    // Create a reservation with short TTL (expires soon)
    const shortTtl = await createReservation(1, 5000, "expires_soon");
    // The expiresAt should be roughly now + 5s
    const cutoff = new Date(Date.now() + 10000).toISOString();

    const listRes = await fetch(
      `${address}/api/admin/inventory/reservations/list?expires_before=${encodeURIComponent(cutoff)}&status=active`,
      { headers: adminHeaders },
    );
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      reservations: Array<{ id: string; expiresAt: string }>;
    };
    const found = body.reservations.find((r) => r.id === shortTtl.reservation.id);
    expect(found).toBeDefined();
    expect(new Date(found!.expiresAt).getTime()).toBeLessThan(new Date(cutoff).getTime());

    // Cleanup
    await fetch(`${address}/api/admin/inventory/reservations/${shortTtl.reservation.id}/release`, {
      method: "POST",
      headers: adminHeaders,
    });
  });

  it("list reservations returns empty array with no matches", async () => {
    const fakeVariantId = "00000000-0000-0000-0000-000000000099";
    const listRes = await fetch(
      `${address}/api/admin/inventory/reservations/list?variant_id=${fakeVariantId}`,
      { headers: adminHeaders },
    );
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { reservations: unknown[] };
    expect(body.reservations).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Force-release endpoint with audit entry
  // -----------------------------------------------------------------------

  it("force-release reservation succeeds with audit entry", async () => {
    const { reservation } = await createReservation(4, 60000, "force_release_test");
    expect(reservation.status).toBe("active");

    // Force-release
    const forceRes = await fetch(
      `${address}/api/admin/inventory/reservations/${reservation.id}/force-release`,
      { method: "POST", headers: adminHeaders },
    );
    expect(forceRes.status).toBe(200);
    const forceBody = (await forceRes.json()) as {
      reservation: { id: string; status: string };
      movement: { movementType: string; quantityDelta: number };
    };
    expect(forceBody.reservation.status).toBe("released");
    expect(forceBody.reservation.id).toBe(reservation.id);
    expect(forceBody.movement.movementType).toBe("release");
    expect(forceBody.movement.quantityDelta).toBe(4);

    // Audit hook fires in onResponse (async after HTTP reply) — brief wait
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Verify audit log entry exists for force-release
    const auditEntries = await dbConn.db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.actorAdminUserId, adminUserId),
          eq(adminAuditLog.entityId, reservation.id),
        ),
      );
    const forceReleaseEntry = auditEntries.find((e) => {
      const afterJson = e.afterJson as Record<string, unknown> | null;
      return afterJson?.forceRelease === true;
    });
    expect(forceReleaseEntry).toBeDefined();
    expect(forceReleaseEntry!.entityType).toBe("inventory_reservation");
    expect(forceReleaseEntry!.action).toBe("UPDATE");
  });

  it("force-release on non-active reservation returns 422", async () => {
    // Create and consume a reservation
    const { reservation } = await createReservation(1, 60000, "force_release_consumed");
    await fetch(`${address}/api/admin/inventory/reservations/${reservation.id}/consume`, {
      method: "POST",
      headers: adminHeaders,
    });

    const forceRes = await fetch(
      `${address}/api/admin/inventory/reservations/${reservation.id}/force-release`,
      { method: "POST", headers: adminHeaders },
    );
    expect(forceRes.status).toBe(422);
    const body = (await forceRes.json()) as { error: string };
    expect(body.error).toBe("ERR_INVALID_STATUS_TRANSITION");
  });

  it("force-release on non-existent reservation returns 404", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const forceRes = await fetch(
      `${address}/api/admin/inventory/reservations/${fakeId}/force-release`,
      { method: "POST", headers: adminHeaders },
    );
    expect(forceRes.status).toBe(404);
    const body = (await forceRes.json()) as { error: string };
    expect(body.error).toBe("ERR_RESERVATION_NOT_FOUND");
  });

  // -----------------------------------------------------------------------
  // Stats endpoint
  // -----------------------------------------------------------------------

  it("stats endpoint returns correct counts per status", async () => {
    // Capture baseline stats for our variant
    const baselineRes = await fetch(
      `${address}/api/admin/inventory/reservations/stats?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    expect(baselineRes.status).toBe(200);
    const baseline = (await baselineRes.json()) as {
      stats: { active: number; consumed: number; released: number; expired: number };
    };

    // Create 3 reservations: leave 1 active, consume 1, release 1
    const r1 = await createReservation(1, 60000, "stats_active");
    const r2 = await createReservation(1, 60000, "stats_consume");
    const r3 = await createReservation(1, 60000, "stats_release");

    await fetch(`${address}/api/admin/inventory/reservations/${r2.reservation.id}/consume`, {
      method: "POST",
      headers: adminHeaders,
    });
    await fetch(`${address}/api/admin/inventory/reservations/${r3.reservation.id}/release`, {
      method: "POST",
      headers: adminHeaders,
    });

    const statsRes = await fetch(
      `${address}/api/admin/inventory/reservations/stats?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as {
      stats: { active: number; consumed: number; released: number; expired: number };
    };

    // Delta-based: compare against baseline
    expect(statsBody.stats.active - baseline.stats.active).toBeGreaterThanOrEqual(1);
    expect(statsBody.stats.consumed - baseline.stats.consumed).toBeGreaterThanOrEqual(1);
    expect(statsBody.stats.released - baseline.stats.released).toBeGreaterThanOrEqual(1);

    // All four fields present and numeric
    expect(typeof statsBody.stats.active).toBe("number");
    expect(typeof statsBody.stats.consumed).toBe("number");
    expect(typeof statsBody.stats.released).toBe("number");
    expect(typeof statsBody.stats.expired).toBe("number");

    // Cleanup: release the still-active one
    await fetch(`${address}/api/admin/inventory/reservations/${r1.reservation.id}/release`, {
      method: "POST",
      headers: adminHeaders,
    });
  });

  // -----------------------------------------------------------------------
  // Non-admin access returns 403
  // -----------------------------------------------------------------------

  it("non-admin user gets 403 on reservation list", async () => {
    const res = await fetch(`${address}/api/admin/inventory/reservations/list`, {
      headers: nonAdminHeaders,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_FORBIDDEN");
  });

  it("non-admin user gets 403 on reservation stats", async () => {
    const res = await fetch(`${address}/api/admin/inventory/reservations/stats`, {
      headers: nonAdminHeaders,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_FORBIDDEN");
  });

  it("non-admin user gets 403 on create reservation", async () => {
    const res = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...nonAdminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: testVariantId,
        location_id: testLocationId,
        quantity: 1,
        ttl_ms: 60000,
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_FORBIDDEN");
  });

  it("non-admin user gets 403 on force-release", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000001";
    const res = await fetch(`${address}/api/admin/inventory/reservations/${fakeId}/force-release`, {
      method: "POST",
      headers: nonAdminHeaders,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_FORBIDDEN");
  });

  it("non-admin user gets 403 on get reservation by ID", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000001";
    const res = await fetch(`${address}/api/admin/inventory/reservations/${fakeId}`, {
      headers: nonAdminHeaders,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_FORBIDDEN");
  });

  // -----------------------------------------------------------------------
  // Error-path validation (retained + hardened)
  // -----------------------------------------------------------------------

  it("reject consuming already-consumed reservation", async () => {
    const { reservation } = await createReservation(2, 60000, "double_consume");

    const consume1 = await fetch(
      `${address}/api/admin/inventory/reservations/${reservation.id}/consume`,
      { method: "POST", headers: adminHeaders },
    );
    expect(consume1.status).toBe(200);

    const consume2 = await fetch(
      `${address}/api/admin/inventory/reservations/${reservation.id}/consume`,
      { method: "POST", headers: adminHeaders },
    );
    expect(consume2.status).toBe(422);
    const body = (await consume2.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_INVALID_STATUS_TRANSITION");
    expect(body.message).toContain("consumed");
  });

  it("reject releasing a consumed reservation", async () => {
    const { reservation } = await createReservation(1, 60000, "release_consumed");

    await fetch(`${address}/api/admin/inventory/reservations/${reservation.id}/consume`, {
      method: "POST",
      headers: adminHeaders,
    });

    const releaseRes = await fetch(
      `${address}/api/admin/inventory/reservations/${reservation.id}/release`,
      { method: "POST", headers: adminHeaders },
    );
    expect(releaseRes.status).toBe(422);
    const body = (await releaseRes.json()) as { error: string };
    expect(body.error).toBe("ERR_INVALID_STATUS_TRANSITION");
  });

  it("validate required fields on reserve", async () => {
    const res = await fetch(`${address}/api/admin/inventory/reservations`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ variant_id: testVariantId }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("Missing required fields");
  });

  it("reject non-positive quantity", async () => {
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
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("positive integer");
  });

  it("return 404 for non-existent reservation", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${address}/api/admin/inventory/reservations/${fakeId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_RESERVATION_NOT_FOUND");
  });

  it("movement ledger tracks all operation types", async () => {
    const movements = await dbConn.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, testVariantId));

    const types = new Set(movements.map((m) => m.movementType));
    expect(types.has("reservation")).toBe(true);
    expect(types.has("consumption")).toBe(true);
    expect(types.has("release")).toBe(true);
  });
});
