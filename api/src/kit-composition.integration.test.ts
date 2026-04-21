import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
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
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

describe("kit composition (T047)", () => {
  let ts_: TestServer;

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
  let inactiveVariantId = "";
  let locationId = "";
  let kitDefId = "";
  let inactiveKitDefId = "";
  let cartToken = "";
  let cartId = "";

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

    // --- Seed product classes ---
    const [platesClass] = await dbConn.db
      .insert(productClass)
      .values({ name: `Plates-${ts}`, slug: `plates-${ts}`, sortOrder: 0 })
      .returning();
    platesClassId = platesClass.id;

    const [bowlsClass] = await dbConn.db
      .insert(productClass)
      .values({ name: `Bowls-${ts}`, slug: `bowls-${ts}`, sortOrder: 1 })
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

    // Inactive variant on prodA — tests active-only enforcement
    const [inactiveV] = await dbConn.db
      .insert(productVariant)
      .values({
        productId: productAId,
        sku: `KIT-INACT-${ts}`,
        title: "Plate A - Inactive",
        optionValuesJson: { material: "PLA" },
        priceMinor: 1900,
        status: "archived",
      })
      .returning();
    inactiveVariantId = inactiveV.id;

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

    // Inactive variant has stock (tests that status is checked, not just inventory)
    await dbConn.db.insert(inventoryBalance).values({
      variantId: inactiveVariantId,
      locationId,
      onHand: 50,
      reserved: 0,
      available: 50,
      safetyStock: 5,
    });

    // --- Kit definition (active) ---
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

    // --- Kit definition (inactive) ---
    const [inactiveKit] = await dbConn.db
      .insert(kitDefinition)
      .values({
        slug: `test-kit-inactive-${ts}`,
        title: "Inactive Kit",
        description: "Should not be orderable",
        priceMinor: 3000,
        status: "draft",
      })
      .returning();
    inactiveKitDefId = inactiveKit.id;

    await dbConn.db.insert(kitClassRequirement).values([
      { kitDefinitionId: inactiveKitDefId, productClassId: platesClassId, quantity: 1 },
    ]);

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
      for (const kid of [kitDefId, inactiveKitDefId]) {
        if (kid) {
          await dbConn.db
            .delete(kitClassRequirement)
            .where(eq(kitClassRequirement.kitDefinitionId, kid));
          await dbConn.db.delete(kitDefinition).where(eq(kitDefinition.id, kid));
        }
      }
      // Clean inventory
      await dbConn.db.delete(inventoryBalance).where(eq(inventoryBalance.locationId, locationId));
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
      // Clean inventory location
      await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, locationId));
    } catch {
      // best-effort cleanup
    }
    await stopTestServer(ts_);
  }, 15000);

  it("valid kit selection satisfies all classes and computes exact savings", async () => {
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

    // Kit metadata
    expect(body.kit.kitDefinitionId).toBe(kitDefId);
    expect(body.kit.kitPriceMinor).toBe(4500);

    // Exact price math: 2000 (A1-TPU) + 1800 (B1-TPU) + 1500 (C1-TPU) = 5300
    expect(body.kit.individualTotalMinor).toBe(5300);
    // Savings: 5300 - 4500 = 800
    expect(body.kit.savingsMinor).toBe(800);

    // All 3 selections returned with correct details
    expect(body.kit.selections).toHaveLength(3);

    const selA1 = body.kit.selections.find((s) => s.variantId === variantA1Id);
    expect(selA1).toMatchObject({
      productClassId: platesClassId,
      variantId: variantA1Id,
      variantTitle: "Plate A - TPU",
      individualPriceMinor: 2000,
    });

    const selB1 = body.kit.selections.find((s) => s.variantId === variantB1Id);
    expect(selB1).toMatchObject({
      productClassId: platesClassId,
      variantId: variantB1Id,
      variantTitle: "Plate B - TPU",
      individualPriceMinor: 1800,
    });

    const selC1 = body.kit.selections.find((s) => s.variantId === variantC1Id);
    expect(selC1).toMatchObject({
      productClassId: bowlsClassId,
      variantId: variantC1Id,
      variantTitle: "Bowl C - TPU",
      individualPriceMinor: 1500,
    });

    // Cart line created at kit price
    const kitLine = body.cart.items.find((i) => i.id === body.kit.cartLineId);
    expect(kitLine).toMatchObject({ unitPriceMinor: 4500 });
  });

  it("missing class selection returns 400 identifying which class is missing", async () => {
    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [
          // Only 1 from Bowls — missing both Plates selections
          { product_class_id: bowlsClassId, variant_id: variantC1Id },
        ],
      }),
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_KIT_INCOMPLETE");
    expect(body.message).toBe(`Select 2 more from Plates-${ts}`);
  });

  it("out-of-stock component returns 400 with specific alternatives", async () => {
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
    expect(body.message).toBe("Component out of stock");
    // Alternatives are in-stock variants from the same class (Plates) excluding prodB's variants
    // prodA has variantA1Id and variantA2Id in stock → those are the alternatives
    expect(body.alternatives).toEqual(expect.arrayContaining([variantA1Id, variantA2Id]));
    expect(body.alternatives.length).toBe(2);
  });

  it("wrong variant for class returns 400 with ERR_KIT_CLASS_MISMATCH", async () => {
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

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_KIT_CLASS_MISMATCH");
    expect(body.message).toBe("Variant's product does not belong to the specified class");
  });

  it("inactive variant rejected even when in stock (active-only enforcement)", async () => {
    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [
          { product_class_id: platesClassId, variant_id: inactiveVariantId }, // archived!
          { product_class_id: platesClassId, variant_id: variantB1Id },
          { product_class_id: bowlsClassId, variant_id: variantC1Id },
        ],
      }),
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VARIANT_NOT_AVAILABLE");
    expect(body.message).toBe("Variant is not available");
  });

  it("inactive kit definition returns 400 ERR_KIT_NOT_AVAILABLE", async () => {
    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: inactiveKitDefId,
        selections: [
          { product_class_id: platesClassId, variant_id: variantA1Id },
        ],
      }),
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_KIT_NOT_AVAILABLE");
    expect(body.message).toBe("Kit is not available");
  });

  it("nonexistent kit returns 404 with ERR_KIT_NOT_FOUND", async () => {
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
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_KIT_NOT_FOUND");
    expect(body.message).toBe("Kit definition not found");
  });

  it("missing selections array returns 400 ERR_VALIDATION", async () => {
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
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toBe("selections array is required and must not be empty");
  });

  it("different variant selection yields different savings math", async () => {
    // Use the pricier PA11 variant instead of TPU for plate A
    const res = await fetch(`${address}/api/cart/kits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cart-Token": cartToken,
      },
      body: JSON.stringify({
        kit_definition_id: kitDefId,
        selections: [
          { product_class_id: platesClassId, variant_id: variantA2Id }, // PA11 @ 2500
          { product_class_id: platesClassId, variant_id: variantB1Id }, // TPU @ 1800
          { product_class_id: bowlsClassId, variant_id: variantC1Id },  // TPU @ 1500
        ],
      }),
    });

    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      kit: {
        kitPriceMinor: number;
        individualTotalMinor: number;
        savingsMinor: number;
        selections: Array<{
          variantId: string;
          individualPriceMinor: number;
        }>;
      };
    };

    // Individual: 2500 + 1800 + 1500 = 5800
    expect(body.kit.individualTotalMinor).toBe(5800);
    expect(body.kit.kitPriceMinor).toBe(4500);
    // Savings: 5800 - 4500 = 1300
    expect(body.kit.savingsMinor).toBe(1300);

    // Verify each selection's price
    const selA2 = body.kit.selections.find((s) => s.variantId === variantA2Id);
    expect(selA2!.individualPriceMinor).toBe(2500);
    const selB1 = body.kit.selections.find((s) => s.variantId === variantB1Id);
    expect(selB1!.individualPriceMinor).toBe(1800);
  });
});
