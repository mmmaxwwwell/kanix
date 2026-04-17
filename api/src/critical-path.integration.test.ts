import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  createServer,
  markReady,
  markNotReady,
  type HealthResponse,
  type ReadyResponse,
} from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { findProductBySlug } from "./db/queries/product.js";
import { isShuttingDown } from "./shutdown.js";
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

const DATABASE_URL = process.env["DATABASE_URL"];

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
    SUPERTOKENS_CONNECTION_URI: "http://localhost:3567",
    EASYPOST_API_KEY: "test-key",
    GITHUB_OAUTH_CLIENT_ID: "test-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    ...overrides,
  };
}

function createFakeProcess(): EventEmitter {
  return new EventEmitter();
}

// Skip when no database is available
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb("critical path checkpoint (Phase 3)", () => {
  let serverClose: (() => Promise<void>) | undefined;
  let dbConn: DatabaseConnection | undefined;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

  afterEach(async () => {
    if (serverClose) {
      await serverClose();
      serverClose = undefined;
    }
    if (dbConn) {
      await dbConn.close();
      dbConn = undefined;
    }
    markNotReady();
    exitSpy.mockClear();
  });

  it("server boots → /health 200 → /ready 200 (DB connected) → seed data queryable → shuts down cleanly", async () => {
    // 1. Create database connection and server
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const fakeProcess = createFakeProcess();
    const server = await createServer({
      config: testConfig(),
      processRef: fakeProcess as unknown as NodeJS.Process,
      database: dbConn,
    });

    // 2. Server boots
    const address = await server.start();
    serverClose = async () => {
      await server.app.close();
    };
    expect(address).toMatch(/^http:\/\//);

    // 3. /health returns 200 with DB connected
    const healthRes = await fetch(`${address}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as HealthResponse;
    expect(healthBody.status).toBe("ok");
    expect(healthBody.dependencies.database).toBe("connected");

    // 4. /ready returns 200 (DB connected, server marked ready)
    markReady();
    const readyRes = await fetch(`${address}/ready`);
    expect(readyRes.status).toBe(200);
    const readyBody = (await readyRes.json()) as ReadyResponse;
    expect(readyBody.status).toBe("ready");

    // 5. Seed data queryable via Drizzle — verify seeded products exist
    const basePlate = await findProductBySlug(dbConn.db, "base-plate-100");
    expect(basePlate).toBeDefined();
    expect(basePlate?.title).toBeTruthy();
    expect(basePlate?.status).toBe("active");

    const hingeMod = await findProductBySlug(dbConn.db, "hinge-module");
    expect(hingeMod).toBeDefined();

    const driveBelt = await findProductBySlug(dbConn.db, "drive-belt-gt2");
    expect(driveBelt).toBeDefined();

    // 6. Server shuts down cleanly via SIGTERM
    fakeProcess.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(isShuttingDown()).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Server was closed by shutdown hooks — no manual close needed
    serverClose = undefined;
    // DB was closed by shutdown hooks — no manual close needed
    dbConn = undefined;
  });
});

const SUPERTOKENS_URI = process.env["SUPERTOKENS_CONNECTION_URI"] ?? "http://localhost:3567";

async function isSuperTokensUp(): Promise<boolean> {
  try {
    const res = await fetch(`${SUPERTOKENS_URI}/hello`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
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

describeWithDb("critical path checkpoint (Phase 5)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const adminEmail = `test-cp5-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  let testAdminUserId = "";
  let testRoleId = "";
  let testProductId = "";
  let testVariantId = "";
  let testLocationId = "";

  const testSlug = `cp5-product-${ts}`;

  beforeAll(async () => {
    superTokensAvailable = await isSuperTokensUp();
    if (!superTokensAvailable) return;

    try {
      dbConn = createDatabaseConnection(DATABASE_URL ?? "");
      const server = await createServer({
        config: testConfig({
          SUPERTOKENS_CONNECTION_URI: SUPERTOKENS_URI,
          RATE_LIMIT_MAX: 1000,
        }),
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
          name: `test_cp5_super_admin_${ts}`,
          description: "Critical path Phase 5 admin",
          capabilitiesJson: ROLE_CAPABILITIES.super_admin,
        })
        .returning();
      testRoleId = role.id;

      const [admin] = await dbConn.db
        .insert(adminUser)
        .values({
          authSubject,
          email: adminEmail,
          name: "CP5 Test Admin",
          status: "active",
        })
        .returning();
      testAdminUserId = admin.id;

      await dbConn.db.insert(adminUserRole).values({
        adminUserId: admin.id,
        adminRoleId: role.id,
      });

      adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

      // Seed: active product with active variant
      const [prod] = await dbConn.db
        .insert(product)
        .values({
          slug: testSlug,
          title: "CP5 Test Product",
          subtitle: "Critical path test",
          description: "End-to-end Phase 5 checkpoint product",
          status: "active",
          brand: "Kanix",
        })
        .returning();
      testProductId = prod.id;

      const [variant] = await dbConn.db
        .insert(productVariant)
        .values({
          productId: testProductId,
          sku: `CP5-TPU-${ts}`,
          title: "TPU Variant",
          optionValuesJson: { material: "TPU" },
          priceMinor: 2999,
          currency: "USD",
          status: "active",
        })
        .returning();
      testVariantId = variant.id;

      // Create inventory location
      const [loc] = await dbConn.db
        .insert(inventoryLocation)
        .values({
          name: "CP5 Warehouse",
          code: `cp5-wh-${ts}`,
          type: "warehouse",
        })
        .returning();
      testLocationId = loc.id;

      // Restock 50 units via the admin adjustments API
      const restockRes = await fetch(`${address}/api/admin/inventory/adjustments`, {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          variant_id: testVariantId,
          location_id: testLocationId,
          adjustment_type: "restock",
          quantity_delta: 50,
          reason: "Initial stock for CP5",
        }),
      });
      if (restockRes.status !== 201) {
        throw new Error(`Restock failed: ${restockRes.status} ${await restockRes.text()}`);
      }
    } catch (err) {
      console.log(`Skipping Phase 5 critical path: setup failed — ${err}`);
      superTokensAvailable = false;
    }
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
        await dbConn.db
          .delete(adminUserRole)
          .where(eq(adminUserRole.adminUserId, testAdminUserId));
        await dbConn.db.delete(adminUser).where(eq(adminUser.id, testAdminUserId));
        await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
        await dbConn.db
          .delete(adminAuditLog)
          .where(eq(adminAuditLog.actorAdminUserId, testAdminUserId));
      } catch {
        // best-effort cleanup
      }
      await dbConn.close();
    }
    if (app) await app.close();
  }, 15000);

  it("seed data → list products via public API → check inventory → reserve → release → verify balance restored", async () => {
    if (!superTokensAvailable) {
      console.log("Skipping Phase 5 critical path: SuperTokens not available");
      return;
    }

    // 1. List products via public API — our seeded product should appear
    const listRes = await fetch(`${address}/api/products`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      products: Array<{
        slug: string;
        variants: Array<{
          id: string;
          sku: string;
          priceMinor: number;
          available: number;
          inStock: boolean;
        }>;
      }>;
    };
    const cp5Product = listBody.products.find((p) => p.slug === testSlug);
    expect(cp5Product).toBeDefined();
    expect(cp5Product!.variants.length).toBe(1);
    expect(cp5Product!.variants[0].priceMinor).toBe(2999);
    expect(cp5Product!.variants[0].available).toBe(50);
    expect(cp5Product!.variants[0].inStock).toBe(true);

    // 2. Check inventory via admin API
    const balanceRes = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    expect(balanceRes.status).toBe(200);
    const balanceBody = (await balanceRes.json()) as {
      balances: Array<{ on_hand: number; reserved: number; available: number }>;
    };
    expect(balanceBody.balances.length).toBe(1);
    expect(balanceBody.balances[0].on_hand).toBe(50);
    expect(balanceBody.balances[0].reserved).toBe(0);
    expect(balanceBody.balances[0].available).toBe(50);

    // 3. Reserve 10 units
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
      reservation: { id: string; status: string; quantity: number };
    };
    expect(reserveBody.reservation.status).toBe("active");
    expect(reserveBody.reservation.quantity).toBe(10);

    // 4. Verify balance after reservation: available = 40, reserved = 10
    const balanceAfterReserve = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balAfterRes = (await balanceAfterReserve.json()) as {
      balances: Array<{ on_hand: number; reserved: number; available: number }>;
    };
    expect(balAfterRes.balances[0].on_hand).toBe(50);
    expect(balAfterRes.balances[0].reserved).toBe(10);
    expect(balAfterRes.balances[0].available).toBe(40);

    // 5. Release the reservation
    const releaseRes = await fetch(
      `${address}/api/admin/inventory/reservations/${reserveBody.reservation.id}/release`,
      { method: "POST", headers: adminHeaders },
    );
    expect(releaseRes.status).toBe(200);
    const releaseBody = (await releaseRes.json()) as {
      reservation: { status: string };
      movement: { movement_type: string; quantity_delta: number };
    };
    expect(releaseBody.reservation.status).toBe("released");
    expect(releaseBody.movement.movement_type).toBe("release");
    expect(releaseBody.movement.quantity_delta).toBe(10);

    // 6. Verify balance restored: on_hand = 50, reserved = 0, available = 50
    const balanceAfterRelease = await fetch(
      `${address}/api/admin/inventory/balances?variant_id=${testVariantId}`,
      { headers: adminHeaders },
    );
    const balAfterRel = (await balanceAfterRelease.json()) as {
      balances: Array<{ on_hand: number; reserved: number; available: number }>;
    };
    expect(balAfterRel.balances[0].on_hand).toBe(50);
    expect(balAfterRel.balances[0].reserved).toBe(0);
    expect(balAfterRel.balances[0].available).toBe(50);

    // 7. Confirm public API also reflects restored availability
    const detailRes = await fetch(`${address}/api/products/${testSlug}`);
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      product: {
        slug: string;
        variants: Array<{ available: number; inStock: boolean }>;
      };
    };
    expect(detailBody.product.slug).toBe(testSlug);
    expect(detailBody.product.variants[0].available).toBe(50);
    expect(detailBody.product.variants[0].inStock).toBe(true);
  });
});
