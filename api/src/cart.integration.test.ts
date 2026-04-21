import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { cart, cartLine } from "./db/schema/cart.js";
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

describe("cart API (T046)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  const ts = Date.now();

  // Test data IDs
  let activeProductId = "";
  let activeVariantId = "";
  let secondVariantId = "";
  let oosVariantId = "";
  let locationId = "";

  // Cart IDs for cleanup
  const cartIds: string[] = [];

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

    // Seed: product with 3 variants
    const [prod] = await dbConn.db
      .insert(product)
      .values({
        slug: `cart-test-product-${ts}`,
        title: "Cart Test Product",
        status: "active",
      })
      .returning();
    activeProductId = prod.id;

    const [v1] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: activeProductId,
        sku: `CART-SKU-A-${ts}`,
        title: "Variant A",
        optionValuesJson: { color: "red" },
        priceMinor: 1500,
        currency: "USD",
        status: "active",
      })
      .returning();
    activeVariantId = v1.id;

    const [v2] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: activeProductId,
        sku: `CART-SKU-B-${ts}`,
        title: "Variant B",
        optionValuesJson: { color: "blue" },
        priceMinor: 2500,
        currency: "USD",
        status: "active",
      })
      .returning();
    secondVariantId = v2.id;

    const [v3] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: activeProductId,
        sku: `CART-SKU-OOS-${ts}`,
        title: "Out of Stock Variant",
        optionValuesJson: { color: "green" },
        priceMinor: 3500,
        currency: "USD",
        status: "active",
      })
      .returning();
    oosVariantId = v3.id;

    // Inventory location + balances
    const [loc] = await dbConn.db
      .insert(inventoryLocation)
      .values({
        name: `Cart Test Warehouse ${ts}`,
        code: `cart-test-wh-${ts}`,
        type: "warehouse",
      })
      .returning();
    locationId = loc.id;

    await dbConn.db.insert(inventoryBalance).values({
      variantId: activeVariantId,
      locationId,
      onHand: 100,
      reserved: 0,
      available: 100,
      safetyStock: 5,
    });

    await dbConn.db.insert(inventoryBalance).values({
      variantId: secondVariantId,
      locationId,
      onHand: 50,
      reserved: 0,
      available: 50,
      safetyStock: 5,
    });

    // Out-of-stock: available = 0
    await dbConn.db.insert(inventoryBalance).values({
      variantId: oosVariantId,
      locationId,
      onHand: 0,
      reserved: 0,
      available: 0,
      safetyStock: 5,
    });
  }, 30000);

  afterAll(async () => {
    markNotReady();
    if (dbConn) {
      try {
        // Cleanup cart lines first, then carts
        for (const cid of cartIds) {
          await dbConn.db.delete(cartLine).where(eq(cartLine.cartId, cid));
          await dbConn.db.delete(cart).where(eq(cart.id, cid));
        }
        // Cleanup inventory
        await dbConn.db.delete(inventoryBalance).where(eq(inventoryBalance.locationId, locationId));
        await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, locationId));
        // Cleanup variants and product
        await dbConn.db.delete(productVariant).where(eq(productVariant.productId, activeProductId));
        await dbConn.db.delete(product).where(eq(product.id, activeProductId));
      } catch {
        // best-effort cleanup
      }
      await dbConn.close();
    }
    if (app) await app.close();
  }, 15000);

  it("POST /api/cart creates a guest cart with token", async () => {
    const res = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      cart: {
        id: string;
        token: string;
        customerId: string | null;
        status: string;
        items: unknown[];
        subtotalMinor: number;
      };
    };

    expect(body.cart).toBeDefined();
    expect(body.cart.token).toBeDefined();
    expect(body.cart.token).not.toBe(body.cart.id); // token is distinct from id
    expect(body.cart.customerId).toBeNull();
    expect(body.cart.status).toBe("active");
    expect(body.cart.items).toEqual([]);
    expect(body.cart.subtotalMinor).toBe(0);

    cartIds.push(body.cart.id);
  });

  it("POST /api/cart/items adds item to cart and validates availability", async () => {
    // Create cart first
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // Add item
    const res = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 2 }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      item: { id: string; variantId: string; quantity: number };
      cart: {
        items: Array<{
          variantId: string;
          quantity: number;
          unitPriceMinor: number;
          currentPriceMinor: number;
          lineTotalMinor: number;
          available: number;
          inStock: boolean;
        }>;
        subtotalMinor: number;
        itemCount: number;
      };
    };

    expect(body.cart.items.length).toBe(1);
    expect(body.cart.items[0].variantId).toBe(activeVariantId);
    expect(body.cart.items[0].quantity).toBe(2);
    expect(body.cart.items[0].unitPriceMinor).toBe(1500);
    expect(body.cart.items[0].lineTotalMinor).toBe(3000);
    expect(body.cart.items[0].inStock).toBe(true);
    expect(body.cart.subtotalMinor).toBe(3000);
    expect(body.cart.itemCount).toBe(2);
  });

  it("POST /api/cart/items rejects out-of-stock variant", async () => {
    // Create cart
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // Try to add out-of-stock item
    const res = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: oosVariantId, quantity: 1 }),
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_INVENTORY_INSUFFICIENT");
  });

  it("create guest cart → add items → verify totals", async () => {
    // Create cart
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // Add variant A (qty 2, price 1500) → total 3000
    await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 2 }),
    });

    // Add variant B (qty 1, price 2500) → total 2500
    await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: secondVariantId, quantity: 1 }),
    });

    // GET cart and verify totals
    const getRes = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartToken },
    });
    expect(getRes.status).toBe(200);

    const body = (await getRes.json()) as {
      cart: {
        items: Array<{
          variantId: string;
          quantity: number;
          lineTotalMinor: number;
        }>;
        subtotalMinor: number;
        itemCount: number;
      };
    };

    expect(body.cart.items.length).toBe(2);
    expect(body.cart.subtotalMinor).toBe(3000 + 2500); // 5500
    expect(body.cart.itemCount).toBe(3); // 2 + 1
  });

  it("DELETE /api/cart/items/:id removes item from cart", async () => {
    // Create cart + add item
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    const addRes = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 1 }),
    });
    const addBody = (await addRes.json()) as {
      item: { id: string };
      cart: { items: Array<{ id: string }> };
    };
    const itemId = addBody.cart.items[0].id;

    // Delete item
    const delRes = await fetch(`${address}/api/cart/items/${itemId}`, {
      method: "DELETE",
      headers: { "X-Cart-Token": cartToken },
    });
    expect(delRes.status).toBe(200);

    const delBody = (await delRes.json()) as {
      cart: { items: unknown[]; subtotalMinor: number };
    };
    expect(delBody.cart.items.length).toBe(0);
    expect(delBody.cart.subtotalMinor).toBe(0);
  });

  it("GET /api/cart returns 404 without X-Cart-Token", async () => {
    const res = await fetch(`${address}/api/cart`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_CART_NOT_FOUND");
  });

  it("GET /api/cart validates inventory on read (flags stale items)", async () => {
    // Create cart + add an in-stock item
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // Add 50 units of activeVariant (within stock)
    await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 50 }),
    });

    // Now reduce inventory to below cart quantity
    await dbConn.db
      .update(inventoryBalance)
      .set({ available: 5, onHand: 5 })
      .where(eq(inventoryBalance.variantId, activeVariantId));

    // GET cart — item should be flagged as insufficient stock
    const getRes = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartToken },
    });
    const body = (await getRes.json()) as {
      cart: {
        items: Array<{
          variantId: string;
          quantity: number;
          available: number;
          insufficientStock: boolean;
        }>;
      };
    };

    const item = body.cart.items.find((i) => i.variantId === activeVariantId);
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.insufficientStock).toBe(true);
    expect(item.available).toBe(5);

    // Restore inventory for other tests
    await dbConn.db
      .update(inventoryBalance)
      .set({ available: 100, onHand: 100 })
      .where(eq(inventoryBalance.variantId, activeVariantId));
  });

  it("POST /api/cart/items merges quantity for duplicate variant", async () => {
    // Create cart
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // Add 2 of variant A
    await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 2 }),
    });

    // Add 3 more of the same variant
    const res = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 3 }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      cart: {
        items: Array<{ variantId: string; quantity: number }>;
        itemCount: number;
      };
    };

    // Should have 1 item with quantity 5
    expect(body.cart.items.length).toBe(1);
    expect(body.cart.items[0].quantity).toBe(5);
    expect(body.cart.itemCount).toBe(5);
  });
});
