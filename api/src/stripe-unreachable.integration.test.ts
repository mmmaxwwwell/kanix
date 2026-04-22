import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "./db/schema/inventory.js";
import { order } from "./db/schema/order.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import { createCircuitBreaker, type CircuitBreaker } from "./services/circuit-breaker.js";

function createStubTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 0, calculationId: null };
    },
  };
}

/** Payment adapter that simulates Stripe being unreachable (connection error / timeout). */
function createFailingPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
      (err as unknown as Record<string, string>).type = "StripeConnectionError";
      throw err;
    },
    async createRefund() {
      return { id: `re_stub_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
    },
  };
}

/** Payment adapter that succeeds (for circuit-breaker recovery tests). */
function createSucceedingPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      return {
        id: `pi_ok_${Date.now()}`,
        clientSecret: `pi_ok_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_ok_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
    },
  };
}

function buildCheckoutBody(cartToken: string) {
  return {
    cart_token: cartToken,
    email: "stripe-fail@example.com",
    shipping_address: {
      full_name: "Test User",
      line1: "123 Main St",
      city: "Austin",
      state: "TX",
      postal_code: "78701",
      country: "US",
    },
  };
}

describe("Stripe unreachable checkout error (T054d)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;

  const ts = Date.now();

  let activeVariantId = "";
  let secondVariantId = "";
  let locationId = "";
  let cartToken = "";

  // Use a low-threshold circuit breaker for testing
  let circuitBreaker: CircuitBreaker;

  beforeAll(async () => {
    circuitBreaker = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 500, // short timeout for tests
    });

    ts_ = await createTestServer({
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createFailingPaymentAdapter(),
        paymentCircuitBreaker: circuitBreaker,
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

    // Seed test data
    const [prod] = await db
      .insert(product)
      .values({
        slug: `stripe-fail-prod-${ts}`,
        title: `Stripe Fail Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant1] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `SFAIL-V1-${ts}`,
        title: `Stripe Fail Variant 1 ${ts}`,
        priceMinor: 1500,
        status: "active",
        weight: "16",
      })
      .returning();
    activeVariantId = variant1.id;

    const [variant2] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `SFAIL-V2-${ts}`,
        title: `Stripe Fail Variant 2 ${ts}`,
        priceMinor: 2000,
        status: "active",
        weight: "8",
      })
      .returning();
    secondVariantId = variant2.id;

    // Inventory location — the checkout handler picks its location from
    // `findInventoryBalances(db,{})[0].locationId`. We must use the same
    // location. If no balances exist yet, create a fresh location.
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
            name: `Stripe Fail Warehouse ${ts}`,
            code: `SFAIL-WH-${ts}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values({
      variantId: activeVariantId,
      locationId,
      onHand: 50,
      reserved: 0,
      available: 50,
    });
    await db.insert(inventoryBalance).values({
      variantId: secondVariantId,
      locationId,
      onHand: 30,
      reserved: 0,
      available: 30,
    });

    // Create a cart with items
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartData = JSON.parse(cartRes.body);
    cartToken = cartData.cart.token;

    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 2 }),
    });
    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: secondVariantId, quantity: 1 }),
    });
  }, 30000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  it("returns 503 with Retry-After header and ERR_EXTERNAL_SERVICE_UNAVAILABLE when Stripe is unreachable", async () => {
    // Reset circuit breaker for a clean test
    circuitBreaker.reset();

    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCheckoutBody(cartToken)),
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_EXTERNAL_SERVICE_UNAVAILABLE");
    expect(body.message).toBe("Payment service is temporarily unavailable");

    // Verify Retry-After header is present
    expect(res.headers["retry-after"]).toBe("30");
  }, 30000);

  it("creates no order when Stripe is unreachable", async () => {
    const db = dbConn.db;
    circuitBreaker.reset();

    // Count orders before checkout attempt
    const ordersBefore = await db.select().from(order);
    const ordersBeforeCount = ordersBefore.length;

    await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCheckoutBody(cartToken)),
    });

    const ordersAfter = await db.select().from(order);
    expect(ordersAfter.length).toBe(ordersBeforeCount);
  }, 30000);

  it("releases inventory reservations after Stripe failure (no leaked reservations)", async () => {
    const db = dbConn.db;
    circuitBreaker.reset();

    await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCheckoutBody(cartToken)),
    });

    // Inventory balances back to original
    const [balance1] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, activeVariantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );
    expect(balance1.available).toBe(50);

    const [balance2] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, secondVariantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );
    expect(balance2.available).toBe(30);

    // No active reservations left for our variants
    const activeReservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.status, "active"));
    const ourReservations = activeReservations.filter(
      (r) => r.variantId === activeVariantId || r.variantId === secondVariantId,
    );
    expect(ourReservations.length).toBe(0);
  }, 30000);

  it("circuit breaker opens after N consecutive Stripe failures", async () => {
    circuitBreaker.reset();
    expect(circuitBreaker.state()).toBe("closed");

    // Trip the circuit breaker with 3 consecutive failures (threshold=3)
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildCheckoutBody(cartToken)),
      });
      expect(res.statusCode).toBe(503);
    }

    // Circuit should now be open
    expect(circuitBreaker.state()).toBe("open");
    expect(circuitBreaker.consecutiveFailures()).toBe(3);

    // Next request should be rejected immediately by the circuit breaker
    // (without even calling the payment adapter)
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCheckoutBody(cartToken)),
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ERR_EXTERNAL_SERVICE_UNAVAILABLE");
  }, 30000);

  it("circuit breaker transitions to half-open after reset timeout and recovers on success", async () => {
    circuitBreaker.reset();

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildCheckoutBody(cartToken)),
      });
    }
    expect(circuitBreaker.state()).toBe("open");

    // Wait for reset timeout (500ms in test config)
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Circuit should transition to half-open
    expect(circuitBreaker.state()).toBe("half-open");

    // Half-open allows a probe request through — it will still fail
    // (adapter is still the failing one) and re-open the circuit
    const probeRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCheckoutBody(cartToken)),
    });
    expect(probeRes.statusCode).toBe(503);
    expect(circuitBreaker.state()).toBe("open");
  }, 30000);

  it("health endpoint reflects degraded payment state when circuit breaker is open", async () => {
    circuitBreaker.reset();

    // Health with closed circuit — payment is ok
    const healthOk = await app.inject({ method: "GET", url: "/health" });
    expect(healthOk.statusCode).toBe(200);
    const healthOkBody = JSON.parse(healthOk.body);
    expect(healthOkBody.dependencies.payment).toBe("ok");

    // Trip the circuit breaker
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/api/checkout",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildCheckoutBody(cartToken)),
      });
    }
    expect(circuitBreaker.state()).toBe("open");

    // Health with open circuit — payment is degraded
    const healthDegraded = await app.inject({ method: "GET", url: "/health" });
    expect(healthDegraded.statusCode).toBe(200);
    const healthDegradedBody = JSON.parse(healthDegraded.body);
    expect(healthDegradedBody.dependencies.payment).toBe("degraded");
  }, 30000);

  it("partially-processed order (reservations created before Stripe fail) rolls back completely", async () => {
    const db = dbConn.db;
    circuitBreaker.reset();

    // Capture balances before
    const [bal1Before] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, activeVariantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );
    const [bal2Before] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, secondVariantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );

    // Attempt checkout — Stripe fails after reservations are created
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCheckoutBody(cartToken)),
    });
    expect(res.statusCode).toBe(503);

    // Verify balances are back to their pre-checkout values
    const [bal1After] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, activeVariantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );
    const [bal2After] = await db
      .select()
      .from(inventoryBalance)
      .where(
        and(
          eq(inventoryBalance.variantId, secondVariantId),
          eq(inventoryBalance.locationId, locationId),
        ),
      );

    expect(bal1After.available).toBe(bal1Before.available);
    expect(bal1After.reserved).toBe(bal1Before.reserved);
    expect(bal1After.onHand).toBe(bal1Before.onHand);

    expect(bal2After.available).toBe(bal2Before.available);
    expect(bal2After.reserved).toBe(bal2Before.reserved);
    expect(bal2After.onHand).toBe(bal2Before.onHand);
  }, 30000);
});

describe("Stripe unreachable — circuit breaker recovery with working adapter", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let circuitBreaker: CircuitBreaker;

  const ts2 = Date.now() + 1;
  let cartToken = "";

  beforeAll(async () => {
    circuitBreaker = createCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 300,
    });

    ts_ = await createTestServer({
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createSucceedingPaymentAdapter(),
        paymentCircuitBreaker: circuitBreaker,
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    const db = dbConn.db;

    // Seed minimal data for checkout
    const [prod] = await db
      .insert(product)
      .values({
        slug: `stripe-recover-prod-${ts2}`,
        title: `Stripe Recover Product ${ts2}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `SREC-V1-${ts2}`,
        title: `Stripe Recover Variant ${ts2}`,
        priceMinor: 1000,
        status: "active",
        weight: "8",
      })
      .returning();

    // Use existing location (same pattern as main describe block)
    let locId: string;
    const existingBalances = await db.select().from(inventoryBalance);
    if (existingBalances.length > 0) {
      locId = existingBalances[0].locationId;
    } else {
      const existingLocs = await db.select().from(inventoryLocation);
      if (existingLocs.length > 0) {
        locId = existingLocs[0].id;
      } else {
        const [loc] = await db
          .insert(inventoryLocation)
          .values({
            name: `Stripe Recover Warehouse ${ts2}`,
            code: `SREC-WH-${ts2}`,
            type: "warehouse",
          })
          .returning();
        locId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values({
      variantId: variant.id,
      locationId: locId,
      onHand: 100,
      reserved: 0,
      available: 100,
    });

    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartData = JSON.parse(cartRes.body);
    cartToken = cartData.cart.token;

    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variant.id, quantity: 1 }),
    });
  }, 30000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  it("successful checkout resets circuit breaker and health shows ok", async () => {
    // Manually trip the breaker to simulate prior failures
    circuitBreaker.recordFailure();
    circuitBreaker.recordFailure();
    expect(circuitBreaker.state()).toBe("open");

    // Wait for reset timeout so it transitions to half-open
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(circuitBreaker.state()).toBe("half-open");

    // Successful checkout should reset the circuit breaker
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCheckoutBody(cartToken)),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.order).toBeDefined();
    expect(body.order.status).toBe("pending_payment");
    expect(body.client_secret).toMatch(/^pi_ok_/);

    // Circuit breaker should be closed again
    expect(circuitBreaker.state()).toBe("closed");
    expect(circuitBreaker.consecutiveFailures()).toBe(0);

    // Health endpoint should show payment as ok
    const healthRes = await app.inject({ method: "GET", url: "/health" });
    const healthBody = JSON.parse(healthRes.body);
    expect(healthBody.dependencies.payment).toBe("ok");
  }, 30000);
});
