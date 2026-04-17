import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { customer } from "./db/schema/customer.js";
import { product, productVariant } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import type { WsMessage } from "./ws/manager.js";
import type { DomainEventPublisher } from "./ws/events.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import WebSocket from "ws";
import { eq, sql } from "drizzle-orm";

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

function createStubTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 0, calculationId: null };
    },
  };
}

let paymentAdapterCallCount = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      paymentAdapterCallCount++;
      return {
        id: `pi_test_de_${paymentAdapterCallCount}_${Date.now()}`,
        clientSecret: `pi_test_de_${paymentAdapterCallCount}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_test_${Date.now()}`, status: "succeeded" };
    },
  };
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

async function signInAndGetAccessToken(
  address: string,
  email: string,
  password: string,
): Promise<string> {
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
  const accessToken = res.headers.get("st-access-token");
  if (!accessToken) {
    throw new Error("No access token in sign-in response");
  }
  return accessToken;
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WS message")),
      timeoutMs,
    );
    ws.once("message", (data: Buffer | string) => {
      clearTimeout(timer);
      resolve(JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as WsMessage);
    });
  });
}

function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS open")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("Domain events pub/sub (T074)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let wsAddress: string;
  let superTokensAvailable = false;
  let domainEvents: DomainEventPublisher;

  const ts = Date.now();
  const adminEmail = `test-de-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";
  const customerEmail = `test-de-customer-${ts}@kanix.dev`;
  const customerPassword = "CustPassword123!";

  let testRoleId: string;
  let testAdminUserId: string;
  let testCustomerId: string;
  let activeProductId: string;
  let activeVariantId: string;
  let locationId: string;

  beforeAll(async () => {
    superTokensAvailable = await isSuperTokensUp();
    if (!superTokensAvailable) return;

    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      reservationCleanupIntervalMs: 0,
      taxAdapter: createStubTaxAdapter(),
      shippingAdapter: createStubShippingAdapter(),
      paymentAdapter: createStubPaymentAdapter(),
    });
    address = await server.start();
    markReady();
    app = server.app;
    domainEvents = server.domainEvents;

    wsAddress = address.replace(/^http/, "ws");

    // Create admin user
    const adminAuthSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `test_de_super_admin_${ts}`,
        description: "Test domain events super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [adminUsr] = await db
      .insert(adminUser)
      .values({
        authSubject: adminAuthSubject,
        email: adminEmail,
        name: "Test DE Admin",
        status: "active",
      })
      .returning();
    testAdminUserId = adminUsr.id;

    await db.insert(adminUserRole).values({
      adminUserId: adminUsr.id,
      adminRoleId: role.id,
    });

    // Create customer user
    const customerAuthSubject = await signUpUser(address, customerEmail, customerPassword);

    const [cust] = await db
      .insert(customer)
      .values({
        authSubject: customerAuthSubject,
        email: customerEmail,
        firstName: "Test",
        lastName: "DE Customer",
      })
      .returning();
    testCustomerId = cust.id;

    // Seed product, variant, inventory for checkout test
    const [prod] = await db
      .insert(product)
      .values({
        slug: `de-test-prod-${ts}`,
        title: `Domain Events Test Product ${ts}`,
        status: "active",
      })
      .returning();
    activeProductId = prod.id;

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: activeProductId,
        sku: `DE-VAR-${ts}`,
        title: `DE Variant ${ts}`,
        priceMinor: 2500,
        status: "active",
        weight: "16",
      })
      .returning();
    activeVariantId = variant.id;

    const [loc] = await db
      .insert(inventoryLocation)
      .values({
        name: `DE Warehouse ${ts}`,
        code: `DE-WH-${ts}`,
        type: "warehouse",
      })
      .returning();
    locationId = loc.id;

    await db.insert(inventoryBalance).values({
      variantId: activeVariantId,
      locationId,
      onHand: 100,
      reserved: 0,
      available: 100,
    });
  }, 30000);

  afterAll(async () => {
    if (!superTokensAvailable) return;
    markNotReady();

    try {
      // Cleanup in reverse dependency order
      const db = dbConn.db;

      // Clean up orders, payments, reservations created by checkout tests
      await db.execute(
        sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM "order" WHERE email LIKE ${"test-de-%"})`,
      );
      await db.execute(
        sql`DELETE FROM order_line WHERE order_id IN (SELECT id FROM "order" WHERE email LIKE ${"test-de-%"})`,
      );
      await db.execute(
        sql`DELETE FROM payment WHERE order_id IN (SELECT id FROM "order" WHERE email LIKE ${"test-de-%"})`,
      );
      await db.execute(sql`DELETE FROM "order" WHERE email LIKE ${"test-de-%"}`);
      await db.execute(
        sql`DELETE FROM inventory_reservation WHERE variant_id = ${activeVariantId}`,
      );
      await db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, activeVariantId));
      await db.delete(inventoryLocation).where(eq(inventoryLocation.id, locationId));
      await db.delete(productVariant).where(eq(productVariant.id, activeVariantId));
      await db.delete(product).where(eq(product.id, activeProductId));

      // Clean up cart data
      await db.execute(
        sql`DELETE FROM cart_item WHERE cart_id IN (SELECT id FROM cart WHERE status = 'converted')`,
      );

      await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, testAdminUserId));
      await db.delete(adminUser).where(eq(adminUser.id, testAdminUserId));
      await db.delete(adminRole).where(eq(adminRole.id, testRoleId));
      await db.delete(customer).where(eq(customer.id, testCustomerId));
    } catch {
      // best-effort cleanup
    }

    await app.close();
    await dbConn.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // Core test: admin connected → create order → receives order.placed event
  // -------------------------------------------------------------------------

  it("admin receives order.placed event when checkout creates an order", async () => {
    if (!superTokensAvailable) return;

    // 1. Connect admin to WebSocket
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    // Consume welcome message
    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");

    // 2. Create a cart and add items
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cartData = JSON.parse(cartRes.body);
    const cartToken = cartData.cart.token;

    await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: { "content-type": "application/json", "x-cart-token": cartToken },
      body: JSON.stringify({ variant_id: activeVariantId, quantity: 1 }),
    });

    // 3. Set up message listener BEFORE checkout
    const eventPromise = waitForMessage(ws, 2000);

    // 4. Perform checkout
    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: `test-de-checkout-${ts}@kanix.dev`,
        shipping_address: {
          full_name: "Test User",
          line1: "123 Main St",
          city: "Austin",
          state: "TX",
          postal_code: "78701",
          country: "US",
        },
      }),
    });
    expect(checkoutRes.statusCode).toBe(201);

    // 5. Admin should receive order.placed event within 2 seconds
    const event = await eventPromise;
    expect(event.type).toBe("order.placed");
    expect(event.entity).toBe("order");
    expect(event.entityId).toBeTruthy();
    expect(event.data?.orderNumber).toBeTruthy();
    expect(event.data?.totalMinor).toBeGreaterThan(0);
    expect(event.sequenceId).toBeGreaterThan(0);

    ws.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // Domain event publisher routes events to customer channel
  // -------------------------------------------------------------------------

  it("customer receives domain events published to their channel", async () => {
    if (!superTokensAvailable) return;

    // Connect as customer
    const accessToken = await signInAndGetAccessToken(address, customerEmail, customerPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    // Consume welcome
    const welcome = await waitForMessage(ws);
    expect(welcome.data?.role).toBe("customer");

    // Publish an order.placed event with the customer's ID
    const eventPromise = waitForMessage(ws, 2000);
    domainEvents.publish(
      "order.placed",
      "order",
      "test-order-for-customer",
      { orderNumber: "KNX-CUST-001" },
      testCustomerId,
    );

    const event = await eventPromise;
    expect(event.type).toBe("order.placed");
    expect(event.entity).toBe("customer");
    expect(event.entityId).toBe(testCustomerId);
    expect(event.data?.orderNumber).toBe("KNX-CUST-001");

    ws.close();
  });

  it("customer does NOT receive events without their customerId", async () => {
    if (!superTokensAvailable) return;

    const accessToken = await signInAndGetAccessToken(address, customerEmail, customerPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);
    await waitForMessage(ws); // welcome

    // Publish an event without customerId — customer should NOT receive it
    domainEvents.publish("order.placed", "order", "some-other-order", {
      orderNumber: "KNX-OTHER",
    });

    const received = await Promise.race([
      waitForMessage(ws, 500).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 600)),
    ]);
    expect(received).toBe(false);

    ws.close();
  });

  // -------------------------------------------------------------------------
  // All 6 domain event types publish correctly
  // -------------------------------------------------------------------------

  it("admin receives all 6 domain event types", async () => {
    if (!superTokensAvailable) return;

    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);
    await waitForMessage(ws); // welcome

    const eventTypes: Array<{
      type: Parameters<DomainEventPublisher["publish"]>[0];
      entity: string;
      entityId: string;
      data: Record<string, unknown>;
    }> = [
      {
        type: "order.placed",
        entity: "order",
        entityId: "evt-order-1",
        data: { orderNumber: "KNX-100" },
      },
      {
        type: "payment.succeeded",
        entity: "payment",
        entityId: "evt-pay-1",
        data: { amountMinor: 5000 },
      },
      {
        type: "shipment.delivered",
        entity: "shipment",
        entityId: "evt-ship-1",
        data: { oldStatus: "in_transit", newStatus: "delivered" },
      },
      {
        type: "ticket.updated",
        entity: "ticket",
        entityId: "evt-ticket-1",
        data: { oldStatus: "open", newStatus: "resolved" },
      },
      {
        type: "inventory.low_stock",
        entity: "inventory",
        entityId: "evt-inv-1",
        data: { available: 2, safetyStock: 10 },
      },
      {
        type: "dispute.opened",
        entity: "dispute",
        entityId: "evt-disp-1",
        data: { reason: "fraudulent", amountMinor: 3000 },
      },
    ];

    for (const evt of eventTypes) {
      const msgPromise = waitForMessage(ws, 2000);
      domainEvents.publish(evt.type, evt.entity, evt.entityId, evt.data);
      const msg = await msgPromise;

      expect(msg.type).toBe(evt.type);
      expect(msg.entity).toBe(evt.entity);
      expect(msg.entityId).toBe(evt.entityId);
      expect(msg.sequenceId).toBeGreaterThan(0);
    }

    ws.close();
  });
});
