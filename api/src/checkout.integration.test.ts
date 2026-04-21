import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "./db/schema/inventory.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { payment } from "./db/schema/payment.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createZeroTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 0, calculationId: null };
    },
  };
}

function createNonZeroTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 413, calculationId: "txcalc_test_tx_001" };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_test_${piCounter}_${Date.now()}`,
        clientSecret: `pi_test_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_test_${Date.now()}`, status: "succeeded" };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TX_ADDRESS = {
  full_name: "Test User",
  line1: "123 Main St",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
};

async function createCartWithItems(
  app: FastifyInstance,
  variantQuantities: Array<{ variantId: string; quantity: number }>,
): Promise<string> {
  const cartRes = await app.inject({
    method: "POST",
    url: "/api/cart",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const cartData = JSON.parse(cartRes.body);
  const token = cartData.cart.token as string;
  for (const { variantId, quantity } of variantQuantities) {
    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: { "content-type": "application/json", "x-cart-token": token },
      body: JSON.stringify({ variant_id: variantId, quantity }),
    });
  }
  return token;
}

function checkoutPayload(overrides: Record<string, unknown> = {}) {
  return {
    cart_token: "MUST_OVERRIDE",
    email: "checkout@example.com",
    shipping_address: { ...VALID_TX_ADDRESS },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkout API (T215)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now();

  // Seed data IDs
  let activeVariantId = "";
  let secondVariantId = "";
  let locationId = "";
  let mainCartToken = "";

  beforeAll(async () => {
    ts_ = await createTestServer({
      skipListen: true,
      serverOverrides: {
        taxAdapter: createZeroTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

    // 1. Product
    const [prod] = await db
      .insert(product)
      .values({
        slug: `chkt-prod-${ts}`,
        title: `Checkout Product ${ts}`,
        status: "active",
      })
      .returning();

    // 2. Variants — $15.00 and $20.00
    const [v1] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `CHKT-V1-${ts}`,
        title: `Checkout Variant 1 ${ts}`,
        priceMinor: 1500,
        status: "active",
        weight: "16",
      })
      .returning();
    activeVariantId = v1.id;

    const [v2] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `CHKT-V2-${ts}`,
        title: `Checkout Variant 2 ${ts}`,
        priceMinor: 2000,
        status: "active",
        weight: "8",
      })
      .returning();
    secondVariantId = v2.id;

    // 3. Inventory location — the checkout handler picks its location from
    //    `findInventoryBalances(db,{})[0].locationId` (the first balance
    //    row in the DB). We must insert our test balances at that same
    //    location. If no balances exist yet, create a fresh location.
    const existingBalances = await db.select().from(inventoryBalance);
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const existingLocs = await db.select().from(inventoryLocation);
      if (existingLocs.length > 0) {
        locationId = existingLocs[0].id;
      } else {
        const [loc] = await db
          .insert(inventoryLocation)
          .values({
            name: `Checkout Warehouse ${ts}`,
            code: `CHKT-WH-${ts}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values([
      { variantId: activeVariantId, locationId, onHand: 50, reserved: 0, available: 50 },
      { variantId: secondVariantId, locationId, onHand: 30, reserved: 0, available: 30 },
    ]);

    // 4. Main cart: 2 × variant1 ($15) + 1 × variant2 ($20) = $50.00
    mainCartToken = await createCartWithItems(app, [
      { variantId: activeVariantId, quantity: 2 },
      { variantId: secondVariantId, quantity: 1 },
    ]);
  }, 30_000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  // -----------------------------------------------------------------------
  // Validation: required fields
  // -----------------------------------------------------------------------

  it("rejects checkout with missing cart_token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "test@example.com",
        shipping_address: { ...VALID_TX_ADDRESS },
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("cart_token");
  });

  it("rejects checkout with missing email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: mainCartToken,
        shipping_address: { ...VALID_TX_ADDRESS },
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("email");
  });

  it("rejects checkout with missing shipping_address", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: mainCartToken,
        email: "test@example.com",
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("shipping_address");
  });

  // -----------------------------------------------------------------------
  // Validation: address field errors
  // -----------------------------------------------------------------------

  it("rejects non-US addresses with ERR_NON_US_ADDRESS", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        checkoutPayload({
          cart_token: mainCartToken,
          shipping_address: { ...VALID_TX_ADDRESS, country: "GB", city: "London", state: "EN", postal_code: "SW1A 1AA" },
        }),
      ),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("ERR_NON_US_ADDRESS");
  });

  for (const field of ["full_name", "line1", "city", "state", "postal_code"] as const) {
    it(`rejects shipping address missing ${field}`, async () => {
      const addr = { ...VALID_TX_ADDRESS, [field]: "" };
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          checkoutPayload({ cart_token: mainCartToken, shipping_address: addr }),
        ),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_VALIDATION");
      expect(body.message).toContain(field);
    });
  }

  // -----------------------------------------------------------------------
  // Cart errors
  // -----------------------------------------------------------------------

  it("rejects checkout with invalid cart token (404)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        checkoutPayload({ cart_token: "00000000-0000-0000-0000-000000000000" }),
      ),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("ERR_CART_NOT_FOUND");
  });

  it("rejects checkout with empty cart", async () => {
    const emptyCartToken = await createCartWithItems(app, []);
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checkoutPayload({ cart_token: emptyCartToken })),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("ERR_CART_EMPTY");
  });

  // -----------------------------------------------------------------------
  // Stale cart: price changed after add-to-cart
  // -----------------------------------------------------------------------

  it("rejects checkout when cart item price has changed (ERR_CART_STALE)", async () => {
    const db = dbConn.db;

    // Create a separate product + variant for this test
    const [staleProd] = await db
      .insert(product)
      .values({ slug: `stale-price-${ts}`, title: `Stale Price ${ts}`, status: "active" })
      .returning();
    const [staleVar] = await db
      .insert(productVariant)
      .values({
        productId: staleProd.id,
        sku: `STALE-PRC-${ts}`,
        title: `Stale Price Variant ${ts}`,
        priceMinor: 1000,
        status: "active",
        weight: "8",
      })
      .returning();
    await db.insert(inventoryBalance).values({
      variantId: staleVar.id,
      locationId,
      onHand: 10,
      reserved: 0,
      available: 10,
    });

    // Add to cart at $10.00
    const token = await createCartWithItems(app, [{ variantId: staleVar.id, quantity: 1 }]);

    // Change price to $12.00 after adding to cart
    await db
      .update(productVariant)
      .set({ priceMinor: 1200 })
      .where(eq(productVariant.id, staleVar.id));

    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checkoutPayload({ cart_token: token })),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_CART_STALE");
    expect(body.stale_items).toBeInstanceOf(Array);
    expect(body.stale_items.length).toBe(1);
    expect(body.stale_items[0].variant_id).toBe(staleVar.id);
    expect(body.stale_items[0].price_changed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Stale cart: insufficient stock after add-to-cart
  // -----------------------------------------------------------------------

  it("rejects checkout when stock drops below cart quantity (ERR_CART_STALE)", async () => {
    const db = dbConn.db;

    const [oosProduct] = await db
      .insert(product)
      .values({ slug: `stale-stock-${ts}`, title: `Stale Stock ${ts}`, status: "active" })
      .returning();
    const [oosVar] = await db
      .insert(productVariant)
      .values({
        productId: oosProduct.id,
        sku: `STALE-STK-${ts}`,
        title: `Stale Stock Variant ${ts}`,
        priceMinor: 800,
        status: "active",
        weight: "4",
      })
      .returning();
    await db.insert(inventoryBalance).values({
      variantId: oosVar.id,
      locationId,
      onHand: 5,
      reserved: 0,
      available: 5,
    });

    // Add 3 units to cart (stock=5 at this point)
    const token = await createCartWithItems(app, [{ variantId: oosVar.id, quantity: 3 }]);

    // Reduce available to 1 (below the quantity=3 in the cart)
    await db
      .update(inventoryBalance)
      .set({ available: 1, onHand: 1 })
      .where(
        and(
          eq(inventoryBalance.variantId, oosVar.id),
          eq(inventoryBalance.locationId, locationId),
        ),
      );

    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checkoutPayload({ cart_token: token })),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_CART_STALE");
    expect(body.stale_items).toBeInstanceOf(Array);
    expect(body.stale_items.length).toBe(1);
    expect(body.stale_items[0].variant_id).toBe(oosVar.id);
    expect(body.stale_items[0].insufficient_stock).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Happy path: full checkout flow
  // -----------------------------------------------------------------------

  it("completes full checkout: order + client_secret + correct totals + DB state", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        checkoutPayload({ cart_token: mainCartToken, email: "checkout-full@example.com" }),
      ),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // Response shape
    expect(body.order.order_number).toMatch(/^KNX-\d{6}$/);
    expect(body.order.email).toBe("checkout-full@example.com");
    expect(body.order.status).toBe("pending_payment");
    expect(body.order.payment_status).toBe("unpaid");

    // Totals: 1500*2 + 2000*1 = 5000 subtotal, 0 tax (stub), 599 shipping (stub)
    expect(body.order.subtotal_minor).toBe(5000);
    expect(body.order.tax_minor).toBe(0);
    expect(body.order.shipping_minor).toBe(599);
    expect(body.order.total_minor).toBe(5599);

    // client_secret is a string (not just defined)
    expect(typeof body.client_secret).toBe("string");
    expect(body.client_secret.length).toBeGreaterThan(0);

    // --- DB verification ---
    const db = dbConn.db;
    const orderId = body.order.id as string;

    // Order row
    const [savedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(savedOrder.email).toBe("checkout-full@example.com");
    expect(savedOrder.status).toBe("pending_payment");
    expect(savedOrder.subtotalMinor).toBe(5000);
    expect(savedOrder.taxMinor).toBe(0);
    expect(savedOrder.shippingMinor).toBe(599);
    expect(savedOrder.totalMinor).toBe(5599);

    // Shipping address snapshot persisted
    expect(savedOrder.shippingAddressSnapshotJson).not.toBeNull();
    const addrSnapshot =
      typeof savedOrder.shippingAddressSnapshotJson === "string"
        ? JSON.parse(savedOrder.shippingAddressSnapshotJson)
        : savedOrder.shippingAddressSnapshotJson;
    expect(addrSnapshot.line1).toBe("123 Main St");
    expect(addrSnapshot.state).toBe("TX");

    // Order lines (2 line items, each with SKU snapshot)
    const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, orderId));
    expect(lines.length).toBe(2);
    const skus = lines.map((l) => l.skuSnapshot).sort();
    expect(skus).toEqual([`CHKT-V1-${ts}`, `CHKT-V2-${ts}`].sort());
    // Verify per-line price snapshots
    const v1Line = lines.find((l) => l.skuSnapshot === `CHKT-V1-${ts}`)!;
    expect(v1Line.quantity).toBe(2);
    expect(v1Line.unitPriceMinor).toBe(1500);
    const v2Line = lines.find((l) => l.skuSnapshot === `CHKT-V2-${ts}`)!;
    expect(v2Line.quantity).toBe(1);
    expect(v2Line.unitPriceMinor).toBe(2000);

    // Status history
    const history = await db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId));
    expect(history.length).toBeGreaterThanOrEqual(1);
    const statusEntry = history.find((h) => h.statusType === "status");
    expect(statusEntry).toBeDefined();
    expect(statusEntry!.newValue).toBe("pending_payment");

    // Payment record
    const payments = await db.select().from(payment).where(eq(payment.orderId, orderId));
    expect(payments.length).toBe(1);
    expect(payments[0].provider).toBe("stripe");
    expect(payments[0].status).toBe("pending");
    expect(typeof payments[0].providerPaymentIntentId).toBe("string");
    expect(payments[0].providerPaymentIntentId).toMatch(/^pi_test_/);

    // Inventory reservations linked to order
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    expect(reservations.length).toBe(2);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Repeated checkout on same cart → cart already consumed
  // -----------------------------------------------------------------------

  it("repeated checkout on the same cart returns consistent result or rejects", async () => {
    const db = dbConn.db;

    // Create a fresh cart for this test
    const [repProd] = await db
      .insert(product)
      .values({ slug: `repeat-chkt-${ts}`, title: `Repeat Checkout ${ts}`, status: "active" })
      .returning();
    const [repVar] = await db
      .insert(productVariant)
      .values({
        productId: repProd.id,
        sku: `REP-VAR-${ts}`,
        title: `Repeat Variant ${ts}`,
        priceMinor: 500,
        status: "active",
        weight: "4",
      })
      .returning();
    await db.insert(inventoryBalance).values({
      variantId: repVar.id,
      locationId,
      onHand: 20,
      reserved: 0,
      available: 20,
    });

    const token = await createCartWithItems(app, [{ variantId: repVar.id, quantity: 1 }]);

    // First checkout succeeds
    const res1 = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checkoutPayload({ cart_token: token, email: "repeat@example.com" })),
    });
    expect(res1.statusCode).toBe(201);
    const body1 = JSON.parse(res1.body);
    expect(body1.order.subtotal_minor).toBe(500);
    expect(body1.order.total_minor).toBe(500 + 599); // 500 + 599 shipping

    // Second checkout with same cart token — the cart is now associated with
    // the order (status changed or items consumed). Either a new order is
    // created with the same totals, or the endpoint rejects (404/400).
    const res2 = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checkoutPayload({ cart_token: token, email: "repeat@example.com" })),
    });
    // Accept either:  identical totals (idempotent) or rejection
    if (res2.statusCode === 201) {
      const body2 = JSON.parse(res2.body);
      expect(body2.order.subtotal_minor).toBe(500);
      expect(body2.order.total_minor).toBe(500 + 599);
    } else {
      // Cart consumed / not found / empty — any 4xx is acceptable
      expect(res2.statusCode).toBeGreaterThanOrEqual(400);
      expect(res2.statusCode).toBeLessThan(500);
    }
  }, 30_000);

  // -----------------------------------------------------------------------
  // Tax path: non-zero tax adapter → tax reflected in totals
  // -----------------------------------------------------------------------

  it("non-zero tax adapter produces correct tax in totals and DB", async () => {
    // Spin up a second server with a non-zero tax adapter
    const taxTs = await createTestServer({
      skipListen: true,
      serverOverrides: {
        taxAdapter: createNonZeroTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    try {
      const taxApp = taxTs.app;
      const taxDb = taxTs.dbConn.db;

      // Seed a product + inventory (reuse the location from the main server's DB since same Postgres)
      const [taxProd] = await taxDb
        .insert(product)
        .values({ slug: `tax-prod-${ts}`, title: `Tax Product ${ts}`, status: "active" })
        .returning();
      const [taxVar] = await taxDb
        .insert(productVariant)
        .values({
          productId: taxProd.id,
          sku: `TAX-V1-${ts}`,
          title: `Tax Variant ${ts}`,
          priceMinor: 3000,
          status: "active",
          weight: "8",
        })
        .returning();

      // Need a location for the tax server's inventory
      const existingLocs = await taxDb.select().from(inventoryLocation);
      const taxLocId = existingLocs[0]?.id ?? locationId;
      await taxDb.insert(inventoryBalance).values({
        variantId: taxVar.id,
        locationId: taxLocId,
        onHand: 10,
        reserved: 0,
        available: 10,
      });

      // Create cart via the tax server
      const cartRes = await taxApp.inject({
        method: "POST",
        url: "/api/cart",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const taxCartToken = JSON.parse(cartRes.body).cart.token as string;
      await taxApp.inject({
        method: "POST",
        url: "/api/cart/items",
        headers: { "content-type": "application/json", "x-cart-token": taxCartToken },
        body: JSON.stringify({ variant_id: taxVar.id, quantity: 1 }),
      });

      // Checkout — expect non-zero tax
      const res = await taxApp.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          checkoutPayload({ cart_token: taxCartToken, email: "tax-test@example.com" }),
        ),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      // subtotal=3000, tax=413 (from adapter), shipping=599 (stub)
      expect(body.order.subtotal_minor).toBe(3000);
      expect(body.order.tax_minor).toBe(413);
      expect(body.order.shipping_minor).toBe(599);
      expect(body.order.total_minor).toBe(3000 + 413 + 599);

      // Verify tax persisted in DB
      const [savedOrder] = await taxDb
        .select()
        .from(order)
        .where(eq(order.id, body.order.id));
      expect(savedOrder.taxMinor).toBe(413);
      expect(savedOrder.totalMinor).toBe(3000 + 413 + 599);
    } finally {
      await stopTestServer(taxTs);
    }
  }, 30_000);

  // -----------------------------------------------------------------------
  // Shipping rate persists on the order
  // -----------------------------------------------------------------------

  it("shipping rate from adapter persists on the order row", async () => {
    const db = dbConn.db;

    // Create a fresh cart for this specific assertion
    const [shipProd] = await db
      .insert(product)
      .values({ slug: `ship-persist-${ts}`, title: `Ship Persist ${ts}`, status: "active" })
      .returning();
    const [shipVar] = await db
      .insert(productVariant)
      .values({
        productId: shipProd.id,
        sku: `SHIP-V1-${ts}`,
        title: `Ship Variant ${ts}`,
        priceMinor: 2500,
        status: "active",
        weight: "12",
      })
      .returning();
    await db.insert(inventoryBalance).values({
      variantId: shipVar.id,
      locationId,
      onHand: 10,
      reserved: 0,
      available: 10,
    });

    const token = await createCartWithItems(app, [{ variantId: shipVar.id, quantity: 1 }]);

    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checkoutPayload({ cart_token: token, email: "ship@example.com" })),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // Stub shipping adapter returns 599 (flat rate)
    expect(body.order.shipping_minor).toBe(599);

    // Verify it's persisted in the DB
    const [savedOrder] = await db.select().from(order).where(eq(order.id, body.order.id));
    expect(savedOrder.shippingMinor).toBe(599);
  }, 30_000);
});
