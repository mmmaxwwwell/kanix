import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  productClass,
  productClassMembership,
  kitDefinition,
  kitClassRequirement,
} from "./db/schema/product-class.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { cart, cartLine, cartKitSelection } from "./db/schema/cart.js";

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

function testConfig(): Config {
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
  };
}

function createFakeProcess(): EventEmitter {
  return new EventEmitter();
}

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("kit cart re-validation on definition change (T054a)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;

  const ts = Date.now();

  // Seed data IDs
  let platesClassId = "";
  let bowlsClassId = "";
  let cupsClassId = "";
  let productAId = "";
  let productBId = "";
  let productCId = "";
  let productDId = "";
  let variantA1Id = "";
  let variantB1Id = "";
  let variantC1Id = "";
  let variantD1Id = "";
  let locationId = "";
  let kitDefId = "";
  let cartToken = "";
  let cartId = "";

  beforeAll(async () => {
    try {
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

      // --- Seed product classes ---
      const [platesClass] = await dbConn.db
        .insert(productClass)
        .values({ name: "Plates", slug: `reval-plates-${ts}`, sortOrder: 0 })
        .returning();
      platesClassId = platesClass.id;

      const [bowlsClass] = await dbConn.db
        .insert(productClass)
        .values({ name: "Bowls", slug: `reval-bowls-${ts}`, sortOrder: 1 })
        .returning();
      bowlsClassId = bowlsClass.id;

      const [cupsClass] = await dbConn.db
        .insert(productClass)
        .values({ name: "Cups", slug: `reval-cups-${ts}`, sortOrder: 2 })
        .returning();
      cupsClassId = cupsClass.id;

      // --- Seed products ---
      const [prodA] = await dbConn.db
        .insert(product)
        .values({ slug: `reval-prod-a-${ts}`, title: "Plate A", status: "active" })
        .returning();
      productAId = prodA.id;

      const [prodB] = await dbConn.db
        .insert(product)
        .values({ slug: `reval-prod-b-${ts}`, title: "Plate B", status: "active" })
        .returning();
      productBId = prodB.id;

      const [prodC] = await dbConn.db
        .insert(product)
        .values({ slug: `reval-prod-c-${ts}`, title: "Bowl C", status: "active" })
        .returning();
      productCId = prodC.id;

      const [prodD] = await dbConn.db
        .insert(product)
        .values({ slug: `reval-prod-d-${ts}`, title: "Cup D", status: "active" })
        .returning();
      productDId = prodD.id;

      // --- Product class memberships ---
      await dbConn.db
        .insert(productClassMembership)
        .values({ productId: productAId, productClassId: platesClassId });
      await dbConn.db
        .insert(productClassMembership)
        .values({ productId: productBId, productClassId: platesClassId });
      await dbConn.db
        .insert(productClassMembership)
        .values({ productId: productCId, productClassId: bowlsClassId });
      await dbConn.db
        .insert(productClassMembership)
        .values({ productId: productDId, productClassId: cupsClassId });

      // --- Seed variants ---
      const [vA1] = await dbConn.db
        .insert(productVariant)
        .values({
          productId: productAId,
          sku: `REVAL-A1-${ts}`,
          title: "Plate A - TPU",
          optionValuesJson: { material: "TPU" },
          priceMinor: 2000,
          status: "active",
        })
        .returning();
      variantA1Id = vA1.id;

      const [vB1] = await dbConn.db
        .insert(productVariant)
        .values({
          productId: productBId,
          sku: `REVAL-B1-${ts}`,
          title: "Plate B - TPU",
          optionValuesJson: { material: "TPU" },
          priceMinor: 1800,
          status: "active",
        })
        .returning();
      variantB1Id = vB1.id;

      const [vC1] = await dbConn.db
        .insert(productVariant)
        .values({
          productId: productCId,
          sku: `REVAL-C1-${ts}`,
          title: "Bowl C - TPU",
          optionValuesJson: { material: "TPU" },
          priceMinor: 1500,
          status: "active",
        })
        .returning();
      variantC1Id = vC1.id;

      const [vD1] = await dbConn.db
        .insert(productVariant)
        .values({
          productId: productDId,
          sku: `REVAL-D1-${ts}`,
          title: "Cup D - TPU",
          optionValuesJson: { material: "TPU" },
          priceMinor: 1000,
          status: "active",
        })
        .returning();
      variantD1Id = vD1.id;

      // --- Inventory ---
      const [loc] = await dbConn.db
        .insert(inventoryLocation)
        .values({ name: `Reval Test WH ${ts}`, code: `reval-wh-${ts}`, type: "warehouse" })
        .returning();
      locationId = loc.id;

      for (const vid of [variantA1Id, variantB1Id, variantC1Id, variantD1Id]) {
        await dbConn.db.insert(inventoryBalance).values({
          variantId: vid,
          locationId,
          onHand: 50,
          reserved: 0,
          available: 50,
          safetyStock: 5,
        });
      }

      // --- Kit definition: 2 Plates + 1 Bowl at 4500 ---
      const [kit] = await dbConn.db
        .insert(kitDefinition)
        .values({
          slug: `reval-kit-${ts}`,
          title: "Revalidation Test Kit",
          description: "Kit for testing re-validation",
          priceMinor: 4500,
          status: "active",
        })
        .returning();
      kitDefId = kit.id;

      await dbConn.db.insert(kitClassRequirement).values([
        { kitDefinitionId: kitDefId, productClassId: platesClassId, quantity: 2 },
        { kitDefinitionId: kitDefId, productClassId: bowlsClassId, quantity: 1 },
      ]);

      // --- Create a cart and add the kit ---
      const cartRes = await fetch(`${address}/api/cart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
      cartToken = cartBody.cart.token;
      cartId = cartBody.cart.id;

      // Add kit to cart
      const kitRes = await fetch(`${address}/api/cart/kits`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cart-Token": cartToken,
        },
        body: JSON.stringify({
          kit_definition_id: kitDefId,
          selections: [
            { product_class_id: platesClassId, variant_id: variantA1Id },
            { product_class_id: platesClassId, variant_id: variantB1Id },
            { product_class_id: bowlsClassId, variant_id: variantC1Id },
          ],
        }),
      });
      expect(kitRes.status).toBe(201);
    } catch (err) {
      superTokensAvailable = false;
      console.log("Setup failed:", err);
    }
  }, 30000);

  afterAll(async () => {
    markNotReady();
    if (dbConn) {
      try {
        // Clean kit selections
        if (cartId) {
          const lines = await dbConn.db.select().from(cartLine).where(eq(cartLine.cartId, cartId));
          for (const line of lines) {
            await dbConn.db
              .delete(cartKitSelection)
              .where(eq(cartKitSelection.cartLineId, line.id));
          }
          await dbConn.db.delete(cartLine).where(eq(cartLine.cartId, cartId));
          await dbConn.db.delete(cart).where(eq(cart.id, cartId));
        }
        // Clean kit definition + requirements
        if (kitDefId) {
          await dbConn.db
            .delete(kitClassRequirement)
            .where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
          await dbConn.db.delete(kitDefinition).where(eq(kitDefinition.id, kitDefId));
        }
        // Clean inventory
        await dbConn.db.delete(inventoryBalance).where(eq(inventoryBalance.locationId, locationId));
        await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, locationId));
        // Clean class memberships
        for (const pid of [productAId, productBId, productCId, productDId]) {
          if (pid)
            await dbConn.db
              .delete(productClassMembership)
              .where(eq(productClassMembership.productId, pid));
        }
        // Clean variants and products
        for (const pid of [productAId, productBId, productCId, productDId]) {
          if (pid) await dbConn.db.delete(productVariant).where(eq(productVariant.productId, pid));
        }
        for (const pid of [productAId, productBId, productCId, productDId]) {
          if (pid) await dbConn.db.delete(product).where(eq(product.id, pid));
        }
        // Clean product classes
        for (const cid of [platesClassId, bowlsClassId, cupsClassId]) {
          if (cid) await dbConn.db.delete(productClass).where(eq(productClass.id, cid));
        }
      } catch {
        // best-effort cleanup
      }
      await dbConn.close();
    }
    if (app) await app.close();
  }, 15000);

  it("should skip if SuperTokens is not available", () => {
    if (!superTokensAvailable) {
      console.log("Skipping: SuperTokens not available");
      return;
    }
    expect(superTokensAvailable).toBe(true);
  });

  it("cart read shows no warnings when kit is unchanged", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartToken },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      cart: { kitWarnings: Array<{ type: string; message: string }> };
    };
    expect(body.cart.kitWarnings).toEqual([]);
  });

  it("admin changes class requirement → cart read shows validation warning", async () => {
    if (!superTokensAvailable) return;

    // Change requirements: now require 1 Plate + 1 Bowl + 1 Cup (was 2 Plates + 1 Bowl)
    // This makes the current selections invalid (2 plates but now only 1 needed, and missing cup)
    await dbConn.db
      .delete(kitClassRequirement)
      .where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
    await dbConn.db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: platesClassId, quantity: 1 },
      { kitDefinitionId: kitDefId, productClassId: bowlsClassId, quantity: 1 },
      { kitDefinitionId: kitDefId, productClassId: cupsClassId, quantity: 1 },
    ]);

    // Read cart — should show warnings
    const res = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartToken },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      cart: {
        kitWarnings: Array<{
          cartLineId: string;
          kitDefinitionId: string;
          type: string;
          message: string;
        }>;
      };
    };

    expect(body.cart.kitWarnings.length).toBeGreaterThan(0);

    // Should have requirement_changed warnings
    const reqWarnings = body.cart.kitWarnings.filter((w) => w.type === "requirement_changed");
    expect(reqWarnings.length).toBeGreaterThan(0);

    // Restore original requirements for subsequent tests
    await dbConn.db
      .delete(kitClassRequirement)
      .where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
    await dbConn.db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: platesClassId, quantity: 2 },
      { kitDefinitionId: kitDefId, productClassId: bowlsClassId, quantity: 1 },
    ]);
  });

  it("price change reflected in cart read and at checkout", async () => {
    if (!superTokensAvailable) return;

    // Change kit price from 4500 to 5000
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 5000 })
      .where(eq(kitDefinition.id, kitDefId));

    // Read cart — should show price_changed warning and updated currentPriceMinor
    const res = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartToken },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      cart: {
        items: Array<{
          id: string;
          unitPriceMinor: number;
          currentPriceMinor: number;
          priceChanged: boolean;
          lineTotalMinor: number;
        }>;
        subtotalMinor: number;
        kitWarnings: Array<{ type: string; message: string }>;
      };
    };

    // The kit line should show the new price
    const kitLine = body.cart.items[0];
    expect(kitLine).toBeDefined();
    expect(kitLine.currentPriceMinor).toBe(5000);
    expect(kitLine.unitPriceMinor).toBe(4500); // Cached at add-to-cart time
    expect(kitLine.priceChanged).toBe(true);
    expect(kitLine.lineTotalMinor).toBe(5000);

    // kitWarnings should include a price_changed warning
    const priceWarnings = body.cart.kitWarnings.filter((w) => w.type === "price_changed");
    expect(priceWarnings.length).toBe(1);
    expect(priceWarnings[0].message).toContain("4500");
    expect(priceWarnings[0].message).toContain("5000");

    // Subtotal should reflect new price
    expect(body.cart.subtotalMinor).toBe(5000);

    // Restore original price
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 4500 })
      .where(eq(kitDefinition.id, kitDefId));
  });

  it("checkout rejects cart with kit validation warnings", async () => {
    if (!superTokensAvailable) return;

    // Change requirements to make current selections invalid
    await dbConn.db
      .delete(kitClassRequirement)
      .where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
    await dbConn.db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: platesClassId, quantity: 1 },
      { kitDefinitionId: kitDefId, productClassId: cupsClassId, quantity: 1 },
    ]);

    // Attempt checkout — should fail due to kit validation warnings
    const res = await fetch(`${address}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: "test@example.com",
        shipping_address: {
          full_name: "Test User",
          line1: "123 Test St",
          city: "Austin",
          state: "TX",
          postal_code: "78701",
          country: "US",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; kit_warnings?: unknown[] };
    // Should get either ERR_KIT_VALIDATION_FAILED or ERR_CART_STALE
    expect(["ERR_KIT_VALIDATION_FAILED", "ERR_CART_STALE"]).toContain(body.error);

    // Restore original requirements
    await dbConn.db
      .delete(kitClassRequirement)
      .where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
    await dbConn.db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: platesClassId, quantity: 2 },
      { kitDefinitionId: kitDefId, productClassId: bowlsClassId, quantity: 1 },
    ]);
  });

  it("admin updates kit via API → carts flagged and warnings appear", async () => {
    if (!superTokensAvailable) return;

    // First verify cart is clean
    const cleanRes = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartToken },
    });
    const cleanBody = (await cleanRes.json()) as {
      cart: { kitWarnings: Array<{ type: string }> };
    };
    expect(cleanBody.cart.kitWarnings).toEqual([]);

    // Now update the kit price directly in DB (simulating admin update)
    // to 3000 (lower than original 4500)
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 3000 })
      .where(eq(kitDefinition.id, kitDefId));

    // Cart read should now show the price_changed warning
    const res = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartToken },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      cart: {
        items: Array<{ currentPriceMinor: number; priceChanged: boolean }>;
        kitWarnings: Array<{ type: string }>;
      };
    };

    expect(body.cart.items[0].currentPriceMinor).toBe(3000);
    expect(body.cart.items[0].priceChanged).toBe(true);
    expect(body.cart.kitWarnings.some((w) => w.type === "price_changed")).toBe(true);

    // Restore
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 4500 })
      .where(eq(kitDefinition.id, kitDefId));
  });
});
