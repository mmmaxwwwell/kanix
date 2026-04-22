/**
 * Flow test: out-of-stock cart + kit rejection [mirrors T104h, FR-010]
 *
 * Walks:
 *   1. Drive variant available→0 via POST /api/admin/inventory/adjustments
 *   2. Assert public catalog returns inStock: false
 *   3. POST /api/cart/:id/items returns 400 with ERR_INVENTORY_INSUFFICIENT
 *   4. Kit containing the variant rejected at checkout (ERR_CART_STALE)
 *   5. After +N restock, variant orderable again
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection } from "../db/connection.js";
import { eq, and } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import {
  productClass,
  productClassMembership,
  kitDefinition,
  kitClassRequirement,
} from "../db/schema/product-class.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryAdjustment,
  inventoryMovement,
  inventoryReservation,
} from "../db/schema/inventory.js";
import { adminUser, adminRole, adminUserRole, adminAuditLog } from "../db/schema/admin.js";
import { ROLE_CAPABILITIES } from "../auth/admin.js";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const run = Date.now();
const WEBHOOK_SECRET = "whsec_oos_flow_test";
const adminEmail = `flow-oos-admin-${run}@kanix.dev`;
const adminPassword = "AdminPassword123!";

const INITIAL_STOCK = 10;

const VALID_ADDRESS = {
  full_name: "OOS Flow Tester",
  line1: "42 Stockout Drive",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
};

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createStubTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 100, calculationId: `txcalc_oos_flow_${Date.now()}` };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_oos_flow_${piCounter}_${Date.now()}`,
        clientSecret: `pi_oos_flow_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_oos_flow_${Date.now()}`, status: "succeeded" };
    },
  };
}

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
// Tests
// ---------------------------------------------------------------------------

describe("flow: out-of-stock cart + kit rejection (T275, mirrors T104h, FR-010)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;
  let adminRoleId: string;

  // Seed data IDs
  let productId = "";
  let variantId = "";
  let variantSku = "";
  let locationId = "";

  // Kit-related IDs
  let classAId = "";
  let classBId = "";
  let productBId = "";
  let variantBId = "";
  let kitDefId = "";

  beforeAll(async () => {
    ts_ = await createTestServer({
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // Create admin user with super_admin role
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `flow_oos_super_admin_${run}`,
        description: "Flow test OOS super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    adminRoleId = role.id;

    const [user] = await db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Flow OOS Admin",
        status: "active",
      })
      .returning();
    adminUserId = user.id;

    await db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // --- Class A (primary product class) ---
    const [clsA] = await db
      .insert(productClass)
      .values({ name: `OOS Class A ${run}`, slug: `oos-class-a-${run}` })
      .returning();
    classAId = clsA.id;

    // --- Class B (second class for kit) ---
    const [clsB] = await db
      .insert(productClass)
      .values({ name: `OOS Class B ${run}`, slug: `oos-class-b-${run}` })
      .returning();
    classBId = clsB.id;

    // --- Product A (will go OOS) in Class A ---
    const [prodA] = await db
      .insert(product)
      .values({
        slug: `oos-prod-a-${run}`,
        title: `OOS Product A ${run}`,
        status: "active",
      })
      .returning();
    productId = prodA.id;

    await db.insert(productClassMembership).values({
      productId: prodA.id,
      productClassId: classAId,
    });

    variantSku = `OOS-VA-${run}`;
    const [vA] = await db
      .insert(productVariant)
      .values({
        productId: prodA.id,
        sku: variantSku,
        title: `OOS Variant A ${run}`,
        priceMinor: 2500,
        status: "active",
        weight: "10",
      })
      .returning();
    variantId = vA.id;

    // --- Product B (always in stock) in Class B ---
    const [prodB] = await db
      .insert(product)
      .values({
        slug: `oos-prod-b-${run}`,
        title: `OOS Product B ${run}`,
        status: "active",
      })
      .returning();
    productBId = prodB.id;

    await db.insert(productClassMembership).values({
      productId: prodB.id,
      productClassId: classBId,
    });

    const [vB] = await db
      .insert(productVariant)
      .values({
        productId: prodB.id,
        sku: `OOS-VB-${run}`,
        title: `OOS Variant B ${run}`,
        priceMinor: 1800,
        status: "active",
        weight: "8",
      })
      .returning();
    variantBId = vB.id;

    // --- Inventory: reuse existing location or create one ---
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const existingLocs = await db.select().from(inventoryLocation).limit(1);
      if (existingLocs.length > 0) {
        locationId = existingLocs[0].id;
      } else {
        const [loc] = await db
          .insert(inventoryLocation)
          .values({
            name: `OOS Warehouse ${run}`,
            code: `OOS-WH-${run}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    // Variant A: starts with INITIAL_STOCK
    await db.insert(inventoryBalance).values({
      variantId,
      locationId,
      onHand: INITIAL_STOCK,
      reserved: 0,
      available: INITIAL_STOCK,
    });

    // Variant B: plenty of stock
    await db.insert(inventoryBalance).values({
      variantId: variantBId,
      locationId,
      onHand: 100,
      reserved: 0,
      available: 100,
    });

    // --- Kit definition: requires one from each class ---
    const [kit] = await db
      .insert(kitDefinition)
      .values({
        slug: `oos-kit-${run}`,
        title: `OOS Kit ${run}`,
        description: "Kit for out-of-stock flow test",
        priceMinor: 3500,
        status: "active",
      })
      .returning();
    kitDefId = kit.id;

    await db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: classAId, quantity: 1 },
      { kitDefinitionId: kitDefId, productClassId: classBId, quantity: 1 },
    ]);
  }, 30_000);

  afterAll(async () => {
    try {
      const db = dbConn.db;
      // Clean up in dependency order
      await db.delete(kitClassRequirement).where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
      await db.delete(kitDefinition).where(eq(kitDefinition.id, kitDefId));
      await db.delete(inventoryMovement).where(eq(inventoryMovement.variantId, variantId));
      await db.delete(inventoryMovement).where(eq(inventoryMovement.variantId, variantBId));
      await db.delete(inventoryReservation).where(eq(inventoryReservation.variantId, variantId));
      await db.delete(inventoryReservation).where(eq(inventoryReservation.variantId, variantBId));
      await db.delete(inventoryAdjustment).where(eq(inventoryAdjustment.variantId, variantId));
      await db.delete(inventoryAdjustment).where(eq(inventoryAdjustment.variantId, variantBId));
      await db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, variantId));
      await db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, variantBId));
      await db
        .delete(productClassMembership)
        .where(eq(productClassMembership.productId, productId));
      await db
        .delete(productClassMembership)
        .where(eq(productClassMembership.productId, productBId));
      await db.delete(productVariant).where(eq(productVariant.id, variantId));
      await db.delete(productVariant).where(eq(productVariant.id, variantBId));
      await db.delete(product).where(eq(product.id, productId));
      await db.delete(product).where(eq(product.id, productBId));
      await db.delete(productClass).where(eq(productClass.id, classAId));
      await db.delete(productClass).where(eq(productClass.id, classBId));
      await db
        .delete(adminAuditLog)
        .where(eq(adminAuditLog.actorAdminUserId, adminUserId));
      await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
      await db.delete(adminUser).where(eq(adminUser.id, adminUserId));
      await db.delete(adminRole).where(eq(adminRole.id, adminRoleId));
    } catch {
      // Best-effort cleanup
    }
    await stopTestServer(ts_);
  }, 15_000);

  // -------------------------------------------------------------------------
  // Helper: make an inventory adjustment via the admin API
  // -------------------------------------------------------------------------
  async function makeAdjustment(
    targetVariantId: string,
    adjustmentType: string,
    quantityDelta: number,
    reason: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${address}/api/admin/inventory/adjustments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: targetVariantId,
        location_id: locationId,
        adjustment_type: adjustmentType,
        quantity_delta: quantityDelta,
        reason,
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  }

  // =========================================================================
  // Step 1: Verify initial state — variant A is in stock
  // =========================================================================

  it("step 1: variant starts in stock with correct balance", async () => {
    const [balance] = await dbConn.db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, variantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );
    expect(balance.onHand).toBe(INITIAL_STOCK);
    expect(balance.reserved).toBe(0);
    expect(balance.available).toBe(INITIAL_STOCK);
  });

  // =========================================================================
  // Step 2: Drive variant available→0 via admin inventory adjustment
  // =========================================================================

  it("step 2: shrinkage adjustment drives variant available to 0", async () => {
    const result = await makeAdjustment(
      variantId,
      "shrinkage",
      -INITIAL_STOCK,
      "Flow test: deplete stock to zero",
    );
    expect(result.status).toBe(201);

    // Verify balance is now 0
    const [balance] = await dbConn.db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, variantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );
    expect(balance.onHand).toBe(0);
    expect(balance.available).toBe(0);
    expect(balance.reserved).toBe(0);
  });

  // =========================================================================
  // Step 3: Public catalog returns inStock: false for the OOS variant
  // =========================================================================

  it("step 3: public catalog shows variant as inStock: false", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/products/oos-prod-a-${run}`,
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.product).toBeDefined();
    expect(body.product.slug).toBe(`oos-prod-a-${run}`);

    // Find our variant in the product's variants
    const variant = body.product.variants.find(
      (v: { id: string }) => v.id === variantId,
    );
    expect(variant).toBeDefined();
    expect(variant.inStock).toBe(false);
    expect(variant.available).toBe(0);
  });

  // =========================================================================
  // Step 4: Adding OOS variant to cart returns 400 ERR_INVENTORY_INSUFFICIENT
  // =========================================================================

  it("step 4: POST /api/cart/items for OOS variant returns 400 ERR_INVENTORY_INSUFFICIENT", async () => {
    // Create a fresh cart
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.statusCode).toBe(201);
    const cartToken = JSON.parse(cartRes.body).cart.token;

    // Try to add OOS variant
    const addRes = await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
    });

    expect(addRes.statusCode).toBe(400);
    const body = JSON.parse(addRes.body);
    expect(body.error).toBe("ERR_INVENTORY_INSUFFICIENT");
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // Step 5: Kit containing OOS variant rejected at checkout
  // =========================================================================

  it("step 5: kit with OOS variant is rejected at checkout with ERR_CART_STALE", async () => {
    // First, temporarily restock variant A so we can add it to the kit cart
    // (the cart add endpoint checks stock at add-time)
    await dbConn.db
      .update(inventoryBalance)
      .set({ onHand: 1, available: 1 })
      .where(
        and(
          eq(inventoryBalance.variantId, variantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );

    // Create cart and add kit
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.statusCode).toBe(201);
    const cartToken = JSON.parse(cartRes.body).cart.token;

    const kitAddRes = await app.inject({
      method: "POST",
      url: "/api/cart/kits",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [
          { product_class_id: classAId, variant_id: variantId },
          { product_class_id: classBId, variant_id: variantBId },
        ],
      }),
    });
    expect(kitAddRes.statusCode).toBeLessThan(300);

    // Now drive variant A back to 0 — simulate stock depleted after adding to cart
    await dbConn.db
      .update(inventoryBalance)
      .set({ onHand: 0, available: 0 })
      .where(
        and(
          eq(inventoryBalance.variantId, variantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );

    // Attempt checkout — should fail with ERR_CART_STALE since variant is now OOS
    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `oos-kit-buyer-${run}@kanix.dev`,
        shipping_address: VALID_ADDRESS,
      }),
    });

    expect(checkoutRes.statusCode).toBe(400);
    const checkoutBody = JSON.parse(checkoutRes.body);
    expect(checkoutBody.error).toBe("ERR_CART_STALE");
    expect(checkoutBody.stale_items).toBeInstanceOf(Array);
    expect(checkoutBody.stale_items.length).toBeGreaterThanOrEqual(1);

    // The stale item should reference our variant
    const staleItem = checkoutBody.stale_items.find(
      (s: { variant_id: string }) => s.variant_id === variantId,
    );
    expect(staleItem).toBeDefined();
    expect(staleItem.insufficient_stock).toBe(true);
  });

  // =========================================================================
  // Step 6: Restock variant — becomes orderable again
  // =========================================================================

  it("step 6: after restock, variant is orderable again", async () => {
    // Restock via admin adjustment
    const restockResult = await makeAdjustment(
      variantId,
      "restock",
      20,
      "Flow test: restock after OOS",
    );
    expect(restockResult.status).toBe(201);

    // Verify balance updated
    const [balance] = await dbConn.db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, variantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );
    expect(balance.onHand).toBe(20);
    expect(balance.available).toBe(20);

    // Public catalog should now show inStock: true
    const catalogRes = await app.inject({
      method: "GET",
      url: `/api/products/oos-prod-a-${run}`,
    });
    expect(catalogRes.statusCode).toBe(200);
    const catalogBody = JSON.parse(catalogRes.body);
    const variant = catalogBody.product.variants.find(
      (v: { id: string }) => v.id === variantId,
    );
    expect(variant).toBeDefined();
    expect(variant.inStock).toBe(true);
    expect(variant.available).toBe(20);

    // Should be able to add to cart successfully
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.statusCode).toBe(201);
    const cartToken = JSON.parse(cartRes.body).cart.token;

    const addRes = await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
    });
    expect(addRes.statusCode).toBe(201);

    const addBody = JSON.parse(addRes.body);
    expect(addBody.item).toBeDefined();
    expect(addBody.item.variantId).toBe(variantId);
    expect(addBody.item.quantity).toBe(1);
  });
});
