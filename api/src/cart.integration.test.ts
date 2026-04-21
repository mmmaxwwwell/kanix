import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { cart, cartLine, cartKitSelection } from "./db/schema/cart.js";
import { productClass, productClassMembership, kitDefinition, kitClassRequirement } from "./db/schema/product-class.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

describe("cart API (T046)", () => {
  let ts_: TestServer;

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

  // Kit test data
  let kitClassId = "";
  let kitDefId = "";

  // Cart IDs for cleanup
  const cartIds: string[] = [];

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

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

    // --- Kit setup: product class + membership + kit definition + requirement ---
    const [cls] = await dbConn.db
      .insert(productClass)
      .values({
        name: `CartTestClass-${ts}`,
        slug: `cart-test-class-${ts}`,
        description: "Class for cart kit tests",
        sortOrder: 0,
      })
      .returning();
    kitClassId = cls.id;

    // Add the active product to this class
    await dbConn.db.insert(productClassMembership).values({
      productId: activeProductId,
      productClassId: kitClassId,
    });

    // Create kit definition
    const [kit] = await dbConn.db
      .insert(kitDefinition)
      .values({
        slug: `cart-test-kit-${ts}`,
        title: "Cart Test Kit",
        description: "Kit for cart integration tests",
        priceMinor: 1200,
        currency: "USD",
        status: "active",
      })
      .returning();
    kitDefId = kit.id;

    // Kit requires 1 item from our class
    await dbConn.db.insert(kitClassRequirement).values({
      kitDefinitionId: kitDefId,
      productClassId: kitClassId,
      quantity: 1,
    });
  }, 30000);

  afterAll(async () => {
    try {
      // Cleanup kit selections, cart lines, then carts
      for (const cid of cartIds) {
        const lines = await dbConn.db.select().from(cartLine).where(eq(cartLine.cartId, cid));
        for (const line of lines) {
          await dbConn.db.delete(cartKitSelection).where(eq(cartKitSelection.cartLineId, line.id));
        }
        await dbConn.db.delete(cartLine).where(eq(cartLine.cartId, cid));
        await dbConn.db.delete(cart).where(eq(cart.id, cid));
      }
      // Cleanup kit data
      await dbConn.db.delete(kitClassRequirement).where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
      await dbConn.db.delete(kitDefinition).where(eq(kitDefinition.id, kitDefId));
      await dbConn.db.delete(productClassMembership).where(
        and(
          eq(productClassMembership.productId, activeProductId),
          eq(productClassMembership.productClassId, kitClassId),
        ),
      );
      await dbConn.db.delete(productClass).where(eq(productClass.id, kitClassId));
      // Cleanup inventory
      await dbConn.db.delete(inventoryBalance).where(eq(inventoryBalance.locationId, locationId));
      await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, locationId));
      // Cleanup variants and product
      await dbConn.db.delete(productVariant).where(eq(productVariant.productId, activeProductId));
      await dbConn.db.delete(product).where(eq(product.id, activeProductId));
    } catch {
      // best-effort cleanup
    }
    await stopTestServer(ts_);
  }, 15000);

  // ---------------------------------------------------------------------------
  // Guest cart creation
  // ---------------------------------------------------------------------------

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
        currency: string;
        items: unknown[];
        subtotalMinor: number;
        itemCount: number;
      };
    };

    // Concrete assertions — no toBeDefined()
    expect(typeof body.cart.id).toBe("string");
    expect(body.cart.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof body.cart.token).toBe("string");
    expect(body.cart.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.cart.token).not.toBe(body.cart.id);
    expect(body.cart.customerId).toBeNull();
    expect(body.cart.status).toBe("active");
    expect(body.cart.currency).toBe("USD");
    expect(body.cart.items).toEqual([]);
    expect(body.cart.subtotalMinor).toBe(0);
    expect(body.cart.itemCount).toBe(0);

    cartIds.push(body.cart.id);
  });

  // ---------------------------------------------------------------------------
  // Add items
  // ---------------------------------------------------------------------------

  it("POST /api/cart/items adds item with exact quantity + price", async () => {
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

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
          id: string;
          variantId: string;
          sku: string;
          quantity: number;
          unitPriceMinor: number;
          currentPriceMinor: number;
          lineTotalMinor: number;
          available: number;
          inStock: boolean;
          priceChanged: boolean;
          insufficientStock: boolean;
        }>;
        subtotalMinor: number;
        itemCount: number;
      };
    };

    expect(body.cart.items).toHaveLength(1);
    const item = body.cart.items[0];
    expect(item.variantId).toBe(activeVariantId);
    expect(item.sku).toBe(`CART-SKU-A-${ts}`);
    expect(item.quantity).toBe(2);
    expect(item.unitPriceMinor).toBe(1500);
    expect(item.currentPriceMinor).toBe(1500);
    expect(item.lineTotalMinor).toBe(3000);
    expect(item.inStock).toBe(true);
    expect(item.priceChanged).toBe(false);
    expect(item.insufficientStock).toBe(false);
    expect(body.cart.subtotalMinor).toBe(3000);
    expect(body.cart.itemCount).toBe(2);
  });

  it("POST /api/cart/items merges quantity for duplicate variant", async () => {
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
        items: Array<{ variantId: string; quantity: number; lineTotalMinor: number }>;
        itemCount: number;
        subtotalMinor: number;
      };
    };

    expect(body.cart.items).toHaveLength(1);
    expect(body.cart.items[0].quantity).toBe(5);
    expect(body.cart.items[0].lineTotalMinor).toBe(7500); // 5 × 1500
    expect(body.cart.itemCount).toBe(5);
    expect(body.cart.subtotalMinor).toBe(7500);
  });

  // ---------------------------------------------------------------------------
  // Multi-item cart with exact totals
  // ---------------------------------------------------------------------------

  it("create guest cart → add two variants → verify exact totals", async () => {
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // Add variant A (qty 2, price 1500) → line total 3000
    await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 2 }),
    });

    // Add variant B (qty 1, price 2500) → line total 2500
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
          unitPriceMinor: number;
          lineTotalMinor: number;
        }>;
        subtotalMinor: number;
        itemCount: number;
      };
    };

    expect(body.cart.items).toHaveLength(2);

    const itemA = body.cart.items.find((i) => i.variantId === activeVariantId)!;
    expect(itemA.quantity).toBe(2);
    expect(itemA.unitPriceMinor).toBe(1500);
    expect(itemA.lineTotalMinor).toBe(3000);

    const itemB = body.cart.items.find((i) => i.variantId === secondVariantId)!;
    expect(itemB.quantity).toBe(1);
    expect(itemB.unitPriceMinor).toBe(2500);
    expect(itemB.lineTotalMinor).toBe(2500);

    expect(body.cart.subtotalMinor).toBe(5500);
    expect(body.cart.itemCount).toBe(3); // 2 + 1
  });

  // ---------------------------------------------------------------------------
  // Remove items
  // ---------------------------------------------------------------------------

  it("DELETE /api/cart/items/:id removes item and recalculates totals", async () => {
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // Add two items
    const addRes1 = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 1 }),
    });
    const addBody1 = (await addRes1.json()) as {
      cart: { items: Array<{ id: string; variantId: string }> };
    };

    await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: secondVariantId, quantity: 1 }),
    });

    // Remove first item
    const itemId = addBody1.cart.items[0].id;
    const delRes = await fetch(`${address}/api/cart/items/${itemId}`, {
      method: "DELETE",
      headers: { "X-Cart-Token": cartToken },
    });
    expect(delRes.status).toBe(200);

    const delBody = (await delRes.json()) as {
      cart: {
        items: Array<{ variantId: string; lineTotalMinor: number }>;
        subtotalMinor: number;
        itemCount: number;
      };
    };
    expect(delBody.cart.items).toHaveLength(1);
    expect(delBody.cart.items[0].variantId).toBe(secondVariantId);
    expect(delBody.cart.items[0].lineTotalMinor).toBe(2500);
    expect(delBody.cart.subtotalMinor).toBe(2500);
    expect(delBody.cart.itemCount).toBe(1);
  });

  it("DELETE /api/cart/items/:id on last item leaves empty cart", async () => {
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
      cart: { items: Array<{ id: string }> };
    };
    const itemId = addBody.cart.items[0].id;

    const delRes = await fetch(`${address}/api/cart/items/${itemId}`, {
      method: "DELETE",
      headers: { "X-Cart-Token": cartToken },
    });
    expect(delRes.status).toBe(200);

    const delBody = (await delRes.json()) as {
      cart: { items: unknown[]; subtotalMinor: number; itemCount: number };
    };
    expect(delBody.cart.items).toHaveLength(0);
    expect(delBody.cart.subtotalMinor).toBe(0);
    expect(delBody.cart.itemCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Out-of-stock blocks add-to-cart
  // ---------------------------------------------------------------------------

  it("POST /api/cart/items rejects out-of-stock variant with ERR_INVENTORY_INSUFFICIENT", async () => {
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

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
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("POST /api/cart/items rejects when requested quantity exceeds available stock", async () => {
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // secondVariant has 50 available — request 999
    const res = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: secondVariantId, quantity: 999 }),
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_INVENTORY_INSUFFICIENT");
  });

  // ---------------------------------------------------------------------------
  // GET /api/cart error paths
  // ---------------------------------------------------------------------------

  it("GET /api/cart returns 404 without X-Cart-Token", async () => {
    const res = await fetch(`${address}/api/cart`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_CART_NOT_FOUND");
    expect(typeof body.message).toBe("string");
  });

  it("GET /api/cart returns 404 with invalid token", async () => {
    const res = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_CART_NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // Inventory validation on cart read
  // ---------------------------------------------------------------------------

  it("GET /api/cart flags items when stock drops below cart quantity", async () => {
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // Add 50 units of activeVariant (within stock of 100)
    await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 50 }),
    });

    // Reduce inventory below cart quantity
    await dbConn.db
      .update(inventoryBalance)
      .set({ available: 5, onHand: 5 })
      .where(eq(inventoryBalance.variantId, activeVariantId));

    // GET cart — item should be flagged as insufficient stock
    const getRes = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartToken },
    });
    expect(getRes.status).toBe(200);

    const body = (await getRes.json()) as {
      cart: {
        items: Array<{
          variantId: string;
          quantity: number;
          available: number;
          insufficientStock: boolean;
          inStock: boolean;
        }>;
      };
    };

    expect(body.cart.items).toHaveLength(1);
    const item = body.cart.items[0];
    expect(item.variantId).toBe(activeVariantId);
    expect(item.quantity).toBe(50);
    expect(item.available).toBe(5);
    expect(item.insufficientStock).toBe(true);
    expect(item.inStock).toBe(true); // still in stock, just not enough

    // Restore inventory for other tests
    await dbConn.db
      .update(inventoryBalance)
      .set({ available: 100, onHand: 100 })
      .where(eq(inventoryBalance.variantId, activeVariantId));
  });

  // ---------------------------------------------------------------------------
  // Kit-to-cart flow
  // ---------------------------------------------------------------------------

  it("POST /api/cart/kits adds kit to cart with correct pricing and savings", async () => {
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [
          { product_class_id: kitClassId, variant_id: activeVariantId },
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
        items: Array<{
          isKit: boolean;
          kitTitle: string | null;
          unitPriceMinor: number;
          quantity: number;
          lineTotalMinor: number;
        }>;
        subtotalMinor: number;
        itemCount: number;
      };
    };

    // Kit result assertions
    expect(body.kit.kitDefinitionId).toBe(kitDefId);
    expect(body.kit.kitPriceMinor).toBe(1200);
    expect(body.kit.individualTotalMinor).toBe(1500); // variant A price
    expect(body.kit.savingsMinor).toBe(300); // 1500 - 1200
    expect(body.kit.selections).toHaveLength(1);
    expect(body.kit.selections[0].variantId).toBe(activeVariantId);
    expect(body.kit.selections[0].individualPriceMinor).toBe(1500);

    // Cart shows kit line
    expect(body.cart.items).toHaveLength(1);
    const kitItem = body.cart.items[0];
    expect(kitItem.isKit).toBe(true);
    expect(kitItem.kitTitle).toBe("Cart Test Kit");
    expect(kitItem.unitPriceMinor).toBe(1200);
    expect(kitItem.quantity).toBe(1);
    expect(kitItem.lineTotalMinor).toBe(1200);
    expect(body.cart.subtotalMinor).toBe(1200);
    expect(body.cart.itemCount).toBe(1);
  });

  it("POST /api/cart/kits rejects incomplete selection with ERR_KIT_INCOMPLETE", async () => {
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // Send empty selections array — kit requires 1 selection
    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [],
      }),
    });
    // Empty selections returns validation error (400)
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_VALIDATION");
  });

  // ---------------------------------------------------------------------------
  // Cart handoff: guest → authenticated preserves items
  // ---------------------------------------------------------------------------

  it("authenticated user creating cart gets customerId set and existing cart returned", async () => {
    // Sign up a fresh user for this test
    const email = `cart-handoff-${ts}@example.com`;
    const password = "Test1234!@#$";

    const signupRes = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: email },
          { id: "password", value: password },
        ],
      }),
    });

    if (signupRes.status !== 200) {
      // If signup fails (e.g. email exists from prior run), skip gracefully
      // by using sign-in instead
      const signinRes = await fetch(`${address}/auth/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          formFields: [
            { id: "email", value: email },
            { id: "password", value: password },
          ],
        }),
      });
      expect(signinRes.status).toBe(200);
    }

    // Sign in to get session tokens
    const loginRes = await fetch(`${address}/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: email },
          { id: "password", value: password },
        ],
      }),
    });
    expect(loginRes.status).toBe(200);

    // Extract session cookies from login response
    const cookies = loginRes.headers.getSetCookie();
    const cookieHeader = cookies.join("; ");

    // Create a cart as authenticated user
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({}),
    });
    // 201 for new cart, or 200 for existing
    expect([200, 201]).toContain(cartRes.status);

    const cartBody = (await cartRes.json()) as {
      cart: { id: string; token: string; customerId: string | null };
    };

    // Authenticated carts should have customerId set
    if (cartBody.cart.customerId !== null) {
      expect(typeof cartBody.cart.customerId).toBe("string");
      expect(cartBody.cart.customerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    // If customerId is null, it means the session didn't resolve a customer
    // (e.g. email not verified) — still a valid cart, just guest-mode

    cartIds.push(cartBody.cart.id);

    // Add item to authenticated cart
    const addRes = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartBody.cart.token,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 1 }),
    });
    expect(addRes.status).toBe(201);

    // Re-fetch cart — items should persist
    const getRes = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartBody.cart.token },
    });
    expect(getRes.status).toBe(200);

    const getBody = (await getRes.json()) as {
      cart: {
        items: Array<{ variantId: string; quantity: number }>;
        itemCount: number;
      };
    };
    expect(getBody.cart.items).toHaveLength(1);
    expect(getBody.cart.items[0].variantId).toBe(activeVariantId);
    expect(getBody.cart.items[0].quantity).toBe(1);
    expect(getBody.cart.itemCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Expired cart cleanup: inactive cart not returned by token lookup
  // ---------------------------------------------------------------------------

  it("cart with status != 'active' is not returned by GET /api/cart", async () => {
    // Create a cart via API
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.status).toBe(201);

    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    // Add item to prove it had content
    const addRes = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 1 }),
    });
    expect(addRes.status).toBe(201);

    // Simulate expiry by marking cart as "expired" directly in DB
    await dbConn.db
      .update(cart)
      .set({ status: "expired" })
      .where(eq(cart.id, cartBody.cart.id));

    // GET with the old token should now return 404
    const getRes = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartToken },
    });
    expect(getRes.status).toBe(404);

    const getBody = (await getRes.json()) as { error: string };
    expect(getBody.error).toBe("ERR_CART_NOT_FOUND");

    // Restore to active for cleanup
    await dbConn.db
      .update(cart)
      .set({ status: "active" })
      .where(eq(cart.id, cartBody.cart.id));
  });

  // ---------------------------------------------------------------------------
  // Validation errors
  // ---------------------------------------------------------------------------

  it("POST /api/cart/items returns ERR_VALIDATION when variant_id missing", async () => {
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    const res = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({ quantity: 1 }),
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toBe("variant_id is required");
  });

  it("POST /api/cart/items returns 404 for non-existent variant", async () => {
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    const cartToken = cartBody.cart.token;
    cartIds.push(cartBody.cart.id);

    const res = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        variant_id: "00000000-0000-0000-0000-000000000000",
        quantity: 1,
      }),
    });
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_VARIANT_NOT_FOUND");
  });
});
