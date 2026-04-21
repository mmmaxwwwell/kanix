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
import { assertSuperTokensUp, getSuperTokensUri, requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();
const SUPERTOKENS_URI = getSuperTokensUri();

function testConfig(): Config {
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
  };
}

function createFakeProcess(): EventEmitter {
  return new EventEmitter();
}

describe("kit composition (T047)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  const ts = Date.now();

  // Seed data IDs
  let platesClassId = "";
  let bowlsClassId = "";
  let productAId = "";
  let productBId = "";
  let productCId = "";
  let variantA1Id = "";
  let variantA2Id = "";
  let variantB1Id = "";
  let variantC1Id = "";
  let oosVariantId = "";
  let locationId = "";
  let kitDefId = "";
  let cartToken = "";
  let cartId = "";

  beforeAll(async () => {
    await assertSuperTokensUp();

    dbConn = createDatabaseConnection(DATABASE_URL);
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
      .values({ name: "Plates", slug: `plates-${ts}`, sortOrder: 0 })
      .returning();
    platesClassId = platesClass.id;

    const [bowlsClass] = await dbConn.db
      .insert(productClass)
      .values({ name: "Bowls", slug: `bowls-${ts}`, sortOrder: 1 })
      .returning();
    bowlsClassId = bowlsClass.id;

    // --- Seed products ---
    const [prodA] = await dbConn.db
      .insert(product)
      .values({ slug: `kit-prod-a-${ts}`, title: "Plate A", status: "active" })
      .returning();
    productAId = prodA.id;

    const [prodB] = await dbConn.db
      .insert(product)
      .values({ slug: `kit-prod-b-${ts}`, title: "Plate B", status: "active" })
      .returning();
    productBId = prodB.id;

    const [prodC] = await dbConn.db
      .insert(product)
      .values({ slug: `kit-prod-c-${ts}`, title: "Bowl C", status: "active" })
      .returning();
    productCId = prodC.id;

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

    // --- Seed variants ---
    const [vA1] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: productAId,
        sku: `KIT-A1-${ts}`,
        title: "Plate A - TPU",
        optionValuesJson: { material: "TPU" },
        priceMinor: 2000,
        status: "active",
      })
      .returning();
    variantA1Id = vA1.id;

    const [vA2] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: productAId,
        sku: `KIT-A2-${ts}`,
        title: "Plate A - PA11",
        optionValuesJson: { material: "PA11" },
        priceMinor: 2500,
        status: "active",
      })
      .returning();
    variantA2Id = vA2.id;

    const [vB1] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: productBId,
        sku: `KIT-B1-${ts}`,
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
        sku: `KIT-C1-${ts}`,
        title: "Bowl C - TPU",
        optionValuesJson: { material: "TPU" },
        priceMinor: 1500,
        status: "active",
      })
      .returning();
    variantC1Id = vC1.id;

    // Out-of-stock variant on prodB
    const [oosV] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: productBId,
        sku: `KIT-OOS-${ts}`,
        title: "Plate B - OOS",
        optionValuesJson: { material: "OOS" },
        priceMinor: 1800,
        status: "active",
      })
      .returning();
    oosVariantId = oosV.id;

    // --- Inventory ---
    const [loc] = await dbConn.db
      .insert(inventoryLocation)
      .values({ name: `Kit Test WH ${ts}`, code: `kit-wh-${ts}`, type: "warehouse" })
      .returning();
    locationId = loc.id;

    for (const vid of [variantA1Id, variantA2Id, variantB1Id, variantC1Id]) {
      await dbConn.db.insert(inventoryBalance).values({
        variantId: vid,
        locationId,
        onHand: 50,
        reserved: 0,
        available: 50,
        safetyStock: 5,
      });
    }

    // OOS variant has 0 available
    await dbConn.db.insert(inventoryBalance).values({
      variantId: oosVariantId,
      locationId,
      onHand: 0,
      reserved: 0,
      available: 0,
      safetyStock: 5,
    });

    // --- Kit definition ---
    const [kit] = await dbConn.db
      .insert(kitDefinition)
      .values({
        slug: `test-kit-${ts}`,
        title: "Starter Kit",
        description: "A starter kit with plates and bowls",
        priceMinor: 4500, // individual: 2000 + 1800 + 1500 = 5300 → savings 800
        status: "active",
      })
      .returning();
    kitDefId = kit.id;

    // Kit requires: 2 from Plates, 1 from Bowls
    await dbConn.db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: platesClassId, quantity: 2 },
      { kitDefinitionId: kitDefId, productClassId: bowlsClassId, quantity: 1 },
    ]);

    // --- Create a cart for tests ---
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    cartToken = cartBody.cart.token;
    cartId = cartBody.cart.id;
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
        for (const pid of [productAId, productBId, productCId]) {
          if (pid)
            await dbConn.db
              .delete(productClassMembership)
              .where(eq(productClassMembership.productId, pid));
        }
        // Clean variants and products
        for (const pid of [productAId, productBId, productCId]) {
          if (pid) await dbConn.db.delete(productVariant).where(eq(productVariant.productId, pid));
        }
        for (const pid of [productAId, productBId, productCId]) {
          if (pid) await dbConn.db.delete(product).where(eq(product.id, pid));
        }
        // Clean product classes
        for (const cid of [platesClassId, bowlsClassId]) {
          if (cid) await dbConn.db.delete(productClass).where(eq(productClass.id, cid));
        }
      } catch {
        // best-effort cleanup
      }
      await dbConn.close();
    }
    if (app) await app.close();
  }, 15000);

  it("valid kit → added to cart with savings", async () => {
    const res = await fetch(`${address}/api/cart/kits`, {
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

    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      kit: {
        cartLineId: string;
        kitDefinitionId: string;
        kitPriceMinor: number;
        individualTotalMinor: number;
        savingsMinor: number;
        selections: Array<{
          productClassId: string;
          variantId: string;
          variantTitle: string;
          individualPriceMinor: number;
        }>;
      };
      cart: {
        items: Array<{ id: string; unitPriceMinor: number }>;
        subtotalMinor: number;
      };
    };

    expect(body.kit.kitDefinitionId).toBe(kitDefId);
    expect(body.kit.kitPriceMinor).toBe(4500);
    // Individual: 2000 (A1) + 1800 (B1) + 1500 (C1) = 5300
    expect(body.kit.individualTotalMinor).toBe(5300);
    expect(body.kit.savingsMinor).toBe(800);
    expect(body.kit.selections.length).toBe(3);

    // Cart should have the kit as a line item at kit price
    expect(body.cart.items.length).toBeGreaterThanOrEqual(1);
    const kitLine = body.cart.items.find((i) => i.id === body.kit.cartLineId);
    expect(kitLine).toBeDefined();
    if (!kitLine) return;
    expect(kitLine.unitPriceMinor).toBe(4500);
  });

  it("incomplete kit → rejected with message 'Select 2 more from Plates'", async () => {
    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [
          // Only 1 from Bowls, but need 2 from Plates + 1 from Bowls
          { product_class_id: bowlsClassId, variant_id: variantC1Id },
        ],
      }),
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_KIT_INCOMPLETE");
    expect(body.message).toContain("Select 2 more from Plates");
  });

  it("out-of-stock component → rejected with swap suggestion", async () => {
    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [
          { product_class_id: platesClassId, variant_id: variantA1Id },
          { product_class_id: platesClassId, variant_id: oosVariantId }, // OOS!
          { product_class_id: bowlsClassId, variant_id: variantC1Id },
        ],
      }),
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      error: string;
      message: string;
      alternatives: string[];
    };
    expect(body.error).toBe("ERR_KIT_COMPONENT_OUT_OF_STOCK");
    expect(body.alternatives).toBeDefined();
    expect(body.alternatives.length).toBeGreaterThan(0);
  });

  it("variant not in class → rejected", async () => {
    // Try to put a bowl variant in a plates slot
    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [
          { product_class_id: platesClassId, variant_id: variantA1Id },
          { product_class_id: platesClassId, variant_id: variantC1Id }, // Bowl variant in Plates!
          { product_class_id: bowlsClassId, variant_id: variantC1Id },
        ],
      }),
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_KIT_CLASS_MISMATCH");
  });

  it("nonexistent kit → 404", async () => {
    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: "00000000-0000-0000-0000-000000000000",
        selections: [{ product_class_id: platesClassId, variant_id: variantA1Id }],
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_KIT_NOT_FOUND");
  });

  it("missing selections → 400", async () => {
    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_VALIDATION");
  });
});
