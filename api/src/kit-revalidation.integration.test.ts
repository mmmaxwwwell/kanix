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

/**
 * T212 — Kit cart re-validation on state change [T054a]
 *
 * Verifies that kits already in a cart are re-validated on every cart read
 * when underlying state changes: OOS variant, archived product, price change,
 * class-requirement mutation.  Also verifies revalidation is idempotent.
 */
describe("kit cart re-validation on state change (T054a)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

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
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

    // --- Seed product classes ---
    const [platesClass] = await dbConn.db
      .insert(productClass)
      .values({ name: `Plates ${ts}`, slug: `reval-plates-${ts}`, sortOrder: 0 })
      .returning();
    platesClassId = platesClass.id;

    const [bowlsClass] = await dbConn.db
      .insert(productClass)
      .values({ name: `Bowls ${ts}`, slug: `reval-bowls-${ts}`, sortOrder: 1 })
      .returning();
    bowlsClassId = bowlsClass.id;

    const [cupsClass] = await dbConn.db
      .insert(productClass)
      .values({ name: `Cups ${ts}`, slug: `reval-cups-${ts}`, sortOrder: 2 })
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
    expect(cartRes.status).toBe(201);
    const cartBody = (await cartRes.json()) as { cart: { id: string; token: string } };
    cartToken = cartBody.cart.token;
    cartId = cartBody.cart.id;

    // Add kit to cart: 2 plates (A, B) + 1 bowl (C)
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
  }, 30000);

  afterAll(async () => {
    try {
      // Clean kit selections
      if (cartId) {
        const lines = await dbConn.db.select().from(cartLine).where(eq(cartLine.cartId, cartId));
        for (const line of lines) {
          await dbConn.db.delete(cartKitSelection).where(eq(cartKitSelection.cartLineId, line.id));
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
      if (locationId) {
        await dbConn.db.delete(inventoryBalance).where(eq(inventoryBalance.locationId, locationId));
        await dbConn.db.delete(inventoryLocation).where(eq(inventoryLocation.id, locationId));
      }
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
    await stopTestServer(ts_);
  }, 15000);

  /** Helper: read cart and return parsed body */
  async function readCart() {
    const res = await fetch(`${address}/api/cart`, {
      headers: { "X-Cart-Token": cartToken },
    });
    const body = (await res.json()) as {
      cart: {
        id: string;
        items: Array<{
          id: string;
          variantId: string;
          sku: string;
          unitPriceMinor: number;
          currentPriceMinor: number;
          priceChanged: boolean;
          lineTotalMinor: number;
          insufficientStock: boolean;
          inStock: boolean;
          available: number;
          isKit: boolean;
        }>;
        subtotalMinor: number;
        kitWarnings: Array<{
          cartLineId: string;
          kitDefinitionId: string;
          type: string;
          message: string;
        }>;
      };
    };
    return { status: res.status, body };
  }

  // ── Happy-path baseline ──────────────────────────────────────────────

  it("cart read shows zero warnings when kit is unchanged", async () => {
    const { status, body } = await readCart();
    expect(status).toBe(200);
    expect(body.cart.kitWarnings).toEqual([]);
    // The kit line should exist with correct cached price
    expect(body.cart.items.length).toBe(1);
    const kitLine = body.cart.items[0];
    expect(kitLine.isKit).toBe(true);
    expect(kitLine.unitPriceMinor).toBe(4500);
    expect(kitLine.currentPriceMinor).toBe(4500);
    expect(kitLine.priceChanged).toBe(false);
    expect(kitLine.insufficientStock).toBe(false);
    expect(kitLine.inStock).toBe(true);
    expect(kitLine.lineTotalMinor).toBe(4500);
    expect(body.cart.subtotalMinor).toBe(4500);
  });

  // ── OOS variant triggers revalidation ────────────────────────────────

  it("variant going out-of-stock flags insufficientStock on cart read", async () => {
    // Delete all inventory balance rows for variant A1 (the kit line's primary variant)
    await dbConn.db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, variantA1Id));

    const { status, body } = await readCart();
    expect(status).toBe(200);

    const kitLine = body.cart.items[0];
    expect(kitLine).toBeDefined();
    expect(kitLine.available).toBe(0);
    expect(kitLine.inStock).toBe(false);
    // insufficientStock = totalAvailable(0) < quantity(1)
    expect(kitLine.insufficientStock).toBe(true);

    // Restore inventory
    await dbConn.db.insert(inventoryBalance).values({
      variantId: variantA1Id,
      locationId,
      onHand: 50,
      reserved: 0,
      available: 50,
      safetyStock: 5,
    });
  });

  it("checkout rejects cart when kit variant is out-of-stock with ERR_CART_STALE", async () => {
    // Delete all inventory for variant A1 (the kit line's primary variant)
    await dbConn.db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, variantA1Id));

    const res = await fetch(`${address}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: "reval-oos@example.com",
        shipping_address: {
          full_name: "OOS Test User",
          line1: "123 Test St",
          city: "Austin",
          state: "TX",
          postal_code: "78701",
          country: "US",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      message: string;
      stale_items?: Array<{
        variant_id: string;
        sku: string;
        price_changed: boolean;
        insufficient_stock: boolean;
      }>;
    };
    expect(body.error).toBe("ERR_CART_STALE");
    expect(body.stale_items).toBeDefined();
    expect(body.stale_items!.length).toBeGreaterThanOrEqual(1);
    const oosItem = body.stale_items!.find((i) => i.insufficient_stock);
    expect(oosItem).toBeDefined();
    expect(oosItem!.insufficient_stock).toBe(true);

    // Restore inventory
    await dbConn.db.insert(inventoryBalance).values({
      variantId: variantA1Id,
      locationId,
      onHand: 50,
      reserved: 0,
      available: 50,
      safetyStock: 5,
    });
  });

  // ── Product archived after add triggers revalidation ─────────────────

  it("archiving a kit variant produces selection_invalid warning", async () => {
    // Archive variant B1 (one of the plate selections)
    await dbConn.db
      .update(productVariant)
      .set({ status: "archived" })
      .where(eq(productVariant.id, variantB1Id));

    const { status, body } = await readCart();
    expect(status).toBe(200);

    // Should have a selection_invalid warning for the archived variant
    const invalidWarnings = body.cart.kitWarnings.filter((w) => w.type === "selection_invalid");
    expect(invalidWarnings.length).toBe(1);
    expect(invalidWarnings[0].kitDefinitionId).toBe(kitDefId);
    expect(invalidWarnings[0].message).toContain(variantB1Id);
    expect(invalidWarnings[0].message).toContain("no longer available");

    // Restore variant status
    await dbConn.db
      .update(productVariant)
      .set({ status: "active" })
      .where(eq(productVariant.id, variantB1Id));
  });

  it("checkout rejects cart with archived variant via ERR_KIT_VALIDATION_FAILED", async () => {
    // Archive variant C1 (bowl selection)
    await dbConn.db
      .update(productVariant)
      .set({ status: "archived" })
      .where(eq(productVariant.id, variantC1Id));

    const res = await fetch(`${address}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: "reval-archive@example.com",
        shipping_address: {
          full_name: "Archive Test User",
          line1: "123 Test St",
          city: "Austin",
          state: "TX",
          postal_code: "78701",
          country: "US",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      kit_warnings?: Array<{ type: string; message: string }>;
    };
    // Kit validation is checked after stale-items check; archived variant
    // triggers selection_invalid which is a kit warning
    expect(body.error).toBe("ERR_KIT_VALIDATION_FAILED");
    expect(body.kit_warnings).toBeDefined();
    expect(body.kit_warnings!.length).toBeGreaterThanOrEqual(1);
    expect(body.kit_warnings!.some((w) => w.type === "selection_invalid")).toBe(true);

    // Restore
    await dbConn.db
      .update(productVariant)
      .set({ status: "active" })
      .where(eq(productVariant.id, variantC1Id));
  });

  // ── Price change triggers revalidation ───────────────────────────────

  it("kit price increase produces price_changed warning with exact amounts", async () => {
    // Change kit price from 4500 to 5000
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 5000 })
      .where(eq(kitDefinition.id, kitDefId));

    const { status, body } = await readCart();
    expect(status).toBe(200);

    // The kit line should reflect the new live price
    const kitLine = body.cart.items[0];
    expect(kitLine.unitPriceMinor).toBe(4500); // cached at add-to-cart time
    expect(kitLine.currentPriceMinor).toBe(5000); // live price
    expect(kitLine.priceChanged).toBe(true);
    expect(kitLine.lineTotalMinor).toBe(5000);
    expect(body.cart.subtotalMinor).toBe(5000);

    // kitWarnings should include exactly one price_changed warning
    const priceWarnings = body.cart.kitWarnings.filter((w) => w.type === "price_changed");
    expect(priceWarnings.length).toBe(1);
    expect(priceWarnings[0].kitDefinitionId).toBe(kitDefId);
    expect(priceWarnings[0].message).toBe("Kit price changed from 4500 to 5000");

    // Restore original price
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 4500 })
      .where(eq(kitDefinition.id, kitDefId));
  });

  it("kit price decrease also produces price_changed warning", async () => {
    // Change kit price from 4500 to 3000
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 3000 })
      .where(eq(kitDefinition.id, kitDefId));

    const { status, body } = await readCart();
    expect(status).toBe(200);

    const kitLine = body.cart.items[0];
    expect(kitLine.unitPriceMinor).toBe(4500);
    expect(kitLine.currentPriceMinor).toBe(3000);
    expect(kitLine.priceChanged).toBe(true);
    expect(kitLine.lineTotalMinor).toBe(3000);

    const priceWarnings = body.cart.kitWarnings.filter((w) => w.type === "price_changed");
    expect(priceWarnings.length).toBe(1);
    expect(priceWarnings[0].message).toBe("Kit price changed from 4500 to 3000");

    // Restore original price
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 4500 })
      .where(eq(kitDefinition.id, kitDefId));
  });

  // ── Class requirement change triggers revalidation ───────────────────

  it("changing class requirements produces requirement_changed warnings with specific messages", async () => {
    // Change requirements: 1 Plate + 1 Bowl + 1 Cup (was 2 Plates + 1 Bowl)
    await dbConn.db
      .delete(kitClassRequirement)
      .where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
    await dbConn.db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: platesClassId, quantity: 1 },
      { kitDefinitionId: kitDefId, productClassId: bowlsClassId, quantity: 1 },
      { kitDefinitionId: kitDefId, productClassId: cupsClassId, quantity: 1 },
    ]);

    const { status, body } = await readCart();
    expect(status).toBe(200);

    const reqWarnings = body.cart.kitWarnings.filter((w) => w.type === "requirement_changed");
    // Plates: cart has 2 but now needs 1 → warning
    // Cups: now required but cart has 0 → warning
    expect(reqWarnings.length).toBe(2);
    expect(
      reqWarnings.some((w) => w.message.includes("requires 1 selections but cart has 2")),
    ).toBe(true);
    expect(
      reqWarnings.some((w) =>
        w.message.includes(`${cupsClassId} now requires 1 selections but has none`),
      ),
    ).toBe(true);

    // Restore original requirements
    await dbConn.db
      .delete(kitClassRequirement)
      .where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
    await dbConn.db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: platesClassId, quantity: 2 },
      { kitDefinitionId: kitDefId, productClassId: bowlsClassId, quantity: 1 },
    ]);
  });

  it("checkout rejects cart with stale kit requirements via ERR_KIT_VALIDATION_FAILED", async () => {
    // Change requirements to make selections invalid
    await dbConn.db
      .delete(kitClassRequirement)
      .where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
    await dbConn.db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: platesClassId, quantity: 1 },
      { kitDefinitionId: kitDefId, productClassId: cupsClassId, quantity: 1 },
    ]);

    const res = await fetch(`${address}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: "reval-req@example.com",
        shipping_address: {
          full_name: "Req Test User",
          line1: "123 Test St",
          city: "Austin",
          state: "TX",
          postal_code: "78701",
          country: "US",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      kit_warnings?: Array<{ type: string }>;
    };
    expect(body.error).toBe("ERR_KIT_VALIDATION_FAILED");
    expect(body.kit_warnings).toBeDefined();

    // Restore original requirements
    await dbConn.db
      .delete(kitClassRequirement)
      .where(eq(kitClassRequirement.kitDefinitionId, kitDefId));
    await dbConn.db.insert(kitClassRequirement).values([
      { kitDefinitionId: kitDefId, productClassId: platesClassId, quantity: 2 },
      { kitDefinitionId: kitDefId, productClassId: bowlsClassId, quantity: 1 },
    ]);
  });

  // ── Revalidation is idempotent ───────────────────────────────────────

  it("repeated cart reads with same stale state produce identical warnings (idempotent)", async () => {
    // Create a stale state: change kit price
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 6000 })
      .where(eq(kitDefinition.id, kitDefId));

    // Read cart twice
    const { body: body1 } = await readCart();
    const { body: body2 } = await readCart();

    // Both reads should return the exact same warnings
    expect(body1.cart.kitWarnings.length).toBe(1);
    expect(body2.cart.kitWarnings.length).toBe(1);
    expect(body1.cart.kitWarnings[0].type).toBe("price_changed");
    expect(body2.cart.kitWarnings[0].type).toBe("price_changed");
    expect(body1.cart.kitWarnings[0].message).toBe(body2.cart.kitWarnings[0].message);
    expect(body1.cart.kitWarnings[0].message).toBe("Kit price changed from 4500 to 6000");

    // Item-level fields should also be identical
    expect(body1.cart.items[0].currentPriceMinor).toBe(6000);
    expect(body2.cart.items[0].currentPriceMinor).toBe(6000);
    expect(body1.cart.items[0].priceChanged).toBe(true);
    expect(body2.cart.items[0].priceChanged).toBe(true);
    expect(body1.cart.subtotalMinor).toBe(body2.cart.subtotalMinor);

    // Restore
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 4500 })
      .where(eq(kitDefinition.id, kitDefId));
  });

  it("repeated cart reads with archived variant produce identical selection_invalid warnings", async () => {
    // Archive variant A1
    await dbConn.db
      .update(productVariant)
      .set({ status: "archived" })
      .where(eq(productVariant.id, variantA1Id));

    const { body: body1 } = await readCart();
    const { body: body2 } = await readCart();

    // Both reads should have the same selection_invalid warning
    const w1 = body1.cart.kitWarnings.filter((w) => w.type === "selection_invalid");
    const w2 = body2.cart.kitWarnings.filter((w) => w.type === "selection_invalid");
    expect(w1.length).toBe(1);
    expect(w2.length).toBe(1);
    expect(w1[0].message).toBe(w2[0].message);
    expect(w1[0].cartLineId).toBe(w2[0].cartLineId);

    // Restore
    await dbConn.db
      .update(productVariant)
      .set({ status: "active" })
      .where(eq(productVariant.id, variantA1Id));
  });

  // ── Warnings clear when state is restored ────────────────────────────

  it("warnings clear when kit state returns to original", async () => {
    // Create a warning by changing price
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 9999 })
      .where(eq(kitDefinition.id, kitDefId));

    const { body: staleBody } = await readCart();
    expect(staleBody.cart.kitWarnings.length).toBe(1);
    expect(staleBody.cart.kitWarnings[0].type).toBe("price_changed");

    // Restore price → warnings should clear
    await dbConn.db
      .update(kitDefinition)
      .set({ priceMinor: 4500 })
      .where(eq(kitDefinition.id, kitDefId));

    const { body: cleanBody } = await readCart();
    expect(cleanBody.cart.kitWarnings).toEqual([]);
    expect(cleanBody.cart.items[0].priceChanged).toBe(false);
    expect(cleanBody.cart.items[0].currentPriceMinor).toBe(4500);
  });
});
