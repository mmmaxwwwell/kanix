import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { customer } from "./db/schema/customer.js";
import { product, productVariant } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { domainEvent } from "./db/schema/domain-event.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import type { WsMessage } from "./ws/manager.js";
import type { DomainEventPublisher, DomainEventType } from "./ws/events.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import WebSocket from "ws";
import { eq, sql } from "drizzle-orm";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";
import EmailVerification from "supertokens-node/recipe/emailverification/index.js";
import supertokens from "supertokens-node";

async function verifyEmail(userId: string): Promise<void> {
  const tokenRes = await EmailVerification.createEmailVerificationToken(
    "public",
    supertokens.convertToRecipeUserId(userId),
  );
  if (tokenRes.status === "OK") {
    await EmailVerification.verifyEmailUsingToken("public", tokenRes.token);
  }
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
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
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

function collectMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<WsMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: WsMessage[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timed out after collecting ${messages.length}/${count} messages`)),
      timeoutMs,
    );
    const handler = (data: Buffer | string) => {
      messages.push(
        JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as WsMessage,
      );
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(messages);
      }
    };
    ws.on("message", handler);
  });
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

function expectNoMessage(ws: WebSocket, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      resolve();
    }, timeoutMs);
    const handler = (data: Buffer | string) => {
      clearTimeout(timer);
      ws.off("message", handler);
      const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
      reject(new Error(`Expected no message but received: ${JSON.stringify(msg)}`));
    };
    ws.on("message", handler);
  });
}

describe("Domain events pub/sub (T254)", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let wsAddress: string;
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
    ts_ = await createTestServer({
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    domainEvents = ts_.server.domainEvents;
    const db = dbConn.db;

    wsAddress = address.replace(/^http/, "ws");

    // Create admin user + verify email for WS auth
    const adminAuthSubject = await signUpUser(address, adminEmail, adminPassword);
    await verifyEmail(adminAuthSubject);

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

    // Create customer user — signUpPOST override auto-creates customer row
    const customerAuthSubject = await signUpUser(address, customerEmail, customerPassword);
    await verifyEmail(customerAuthSubject);

    const [cust] = await db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, customerAuthSubject))
      .limit(1);
    if (!cust) throw new Error("Customer row not created by signUp override");
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

    // Checkout handler picks locationId from first existing balance row.
    // Insert at that same location to avoid ERR_INVENTORY_NOT_FOUND.
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
            name: `DE Warehouse ${ts}`,
            code: `DE-WH-${ts}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values({
      variantId: activeVariantId,
      locationId,
      onHand: 100,
      reserved: 0,
      available: 100,
    });
  }, 30000);

  afterAll(async () => {
    try {
      const db = dbConn.db;

      // Clean up domain events created by this test
      await db.execute(
        sql`DELETE FROM domain_event WHERE entity_id LIKE ${"evt-%"} OR entity_id LIKE ${"test-%"} OR event_type IN ('order.placed', 'payment.succeeded', 'shipment.delivered', 'ticket.updated', 'inventory.low_stock', 'dispute.opened')`,
      );

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
      // Only delete location if we created it (code starts with DE-WH-)
      await db.execute(
        sql`DELETE FROM inventory_location WHERE id = ${locationId} AND code LIKE ${"DE-WH-%"}`,
      );
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

    await stopTestServer(ts_);
  }, 15000);

  // -------------------------------------------------------------------------
  // Concrete producer: checkout → order.placed event
  // -------------------------------------------------------------------------

  it("checkout produces order.placed event with concrete payload to admin WS", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);

    // Collect welcome + event messages eagerly (avoids race from sequential waitForMessage)
    const msgCollector = collectMessages(ws, 2, 10000);
    await waitForOpen(ws);

    // Create a cart and add items
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

    // Perform checkout
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

    const msgs = await msgCollector;
    const welcome = msgs[0];
    const event = msgs[1];

    expect(welcome.type).toBe("connected");
    expect(welcome.data?.role).toBe("admin");

    expect(event.type).toBe("order.placed");
    expect(event.entity).toBe("order");
    expect(typeof event.entityId).toBe("string");
    expect(event.entityId.length).toBeGreaterThan(0);
    expect(event.data?.orderNumber).toMatch(/^KNX-/);
    expect(event.data?.totalMinor).toBeGreaterThanOrEqual(2500);
    expect(typeof event.sequenceId).toBe("number");
    expect(event.sequenceId).toBeGreaterThan(0);

    ws.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // Customer channel routing
  // -------------------------------------------------------------------------

  it("customer receives domain events published to their channel via customerId", async () => {
    const accessToken = await signInAndGetAccessToken(address, customerEmail, customerPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");
    expect(welcome.data?.role).toBe("customer");

    const eventPromise = waitForMessage(ws, 2000);
    domainEvents.publish(
      "order.placed",
      "order",
      "test-order-for-customer",
      { orderNumber: "KNX-CUST-001", totalMinor: 3000 },
      testCustomerId,
    );

    const event = await eventPromise;
    expect(event.type).toBe("order.placed");
    // Customer channel routes to customer:<customerId>
    expect(event.entity).toBe("customer");
    expect(event.entityId).toBe(testCustomerId);
    expect(event.data?.orderNumber).toBe("KNX-CUST-001");
    expect(event.data?.totalMinor).toBe(3000);
    expect(typeof event.sequenceId).toBe("number");
    expect(event.sequenceId).toBeGreaterThan(0);

    ws.close();
  });

  it("customer does NOT receive events without their customerId", async () => {
    const accessToken = await signInAndGetAccessToken(address, customerEmail, customerPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);
    await waitForMessage(ws); // welcome

    // Publish event without customerId — should go to entity channel only (admin wildcard)
    domainEvents.publish("order.placed", "order", "some-other-order", {
      orderNumber: "KNX-OTHER",
    });

    await expectNoMessage(ws, 500);

    ws.close();
  });

  // -------------------------------------------------------------------------
  // All domain event types produce correctly
  // -------------------------------------------------------------------------

  it("admin receives all 8 domain event types with correct shapes", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);
    await waitForMessage(ws); // welcome

    const eventTypes: Array<{
      type: DomainEventType;
      entity: string;
      entityId: string;
      data: Record<string, unknown>;
    }> = [
      {
        type: "order.placed",
        entity: "order",
        entityId: "evt-order-1",
        data: { orderNumber: "KNX-100", totalMinor: 5000 },
      },
      {
        type: "payment.succeeded",
        entity: "payment",
        entityId: "evt-pay-1",
        data: { amountMinor: 5000, orderId: "test-order-id" },
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
        data: { available: 2, safetyStock: 10, locationId: "loc-1" },
      },
      {
        type: "dispute.opened",
        entity: "dispute",
        entityId: "evt-disp-1",
        data: { reason: "fraudulent", amountMinor: 3000, orderId: "test-ord" },
      },
      {
        type: "settings.changed",
        entity: "setting",
        entityId: "evt-setting-1",
        data: { changes: { freeShippingThreshold: 5000 } },
      },
      {
        type: "milestone.reached",
        entity: "contributor",
        entityId: "evt-contrib-1",
        data: { milestoneId: "ms-1", milestoneType: "veteran" },
      },
    ];

    let prevSequenceId = 0;
    for (const evt of eventTypes) {
      const msgPromise = waitForMessage(ws, 2000);
      domainEvents.publish(evt.type, evt.entity, evt.entityId, evt.data);
      const msg = await msgPromise;

      expect(msg.type).toBe(evt.type);
      expect(msg.entity).toBe(evt.entity);
      expect(msg.entityId).toBe(evt.entityId);
      // Verify data payload fields match exactly
      for (const [key, value] of Object.entries(evt.data)) {
        expect(msg.data?.[key]).toEqual(value);
      }
      expect(typeof msg.sequenceId).toBe("number");
      expect(msg.sequenceId).toBeGreaterThan(prevSequenceId);
      prevSequenceId = msg.sequenceId;
    }

    ws.close();
  });

  // -------------------------------------------------------------------------
  // Event ordering preserved per-aggregate
  // -------------------------------------------------------------------------

  it("event ordering is preserved per-aggregate (monotonic sequence IDs)", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);
    await waitForMessage(ws); // welcome

    // Publish 5 events for the same order aggregate in sequence
    const orderId = `evt-ordering-${ts}`;
    const eventSequence: DomainEventType[] = [
      "order.placed",
      "payment.succeeded",
      "shipment.delivered",
      "ticket.updated",
      "settings.changed",
    ];

    const receivedSequenceIds: number[] = [];
    for (const type of eventSequence) {
      const msgPromise = waitForMessage(ws, 2000);
      domainEvents.publish(type, "order", orderId, { step: type });
      const msg = await msgPromise;
      expect(msg.type).toBe(type);
      expect(msg.entityId).toBe(orderId);
      receivedSequenceIds.push(msg.sequenceId);
    }

    // Verify strictly monotonically increasing sequence IDs
    for (let i = 1; i < receivedSequenceIds.length; i++) {
      expect(receivedSequenceIds[i]).toBeGreaterThan(receivedSequenceIds[i - 1]);
    }

    ws.close();
  });

  // -------------------------------------------------------------------------
  // Subscriber registration and isolation
  // -------------------------------------------------------------------------

  it("registered subscribers receive published events", async () => {
    const received: Array<{ type: string; entity: string; entityId: string }> = [];
    const unsub = domainEvents.subscribe((type, entity, entityId) => {
      received.push({ type, entity, entityId });
    });

    domainEvents.publish("order.placed", "order", "test-sub-1", { orderNumber: "KNX-SUB" });
    domainEvents.publish("payment.succeeded", "payment", "test-sub-2", { amountMinor: 100 });

    // Subscribers are called synchronously
    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("order.placed");
    expect(received[0].entity).toBe("order");
    expect(received[0].entityId).toBe("test-sub-1");
    expect(received[1].type).toBe("payment.succeeded");
    expect(received[1].entity).toBe("payment");
    expect(received[1].entityId).toBe("test-sub-2");

    unsub();

    // After unsubscribe, no more events
    domainEvents.publish("dispute.opened", "dispute", "test-sub-3", { reason: "test" });
    expect(received).toHaveLength(2);
  });

  it("failed subscriber does not block other subscribers", async () => {
    const results: string[] = [];

    const unsub1 = domainEvents.subscribe(() => {
      results.push("sub1-before");
      throw new Error("Subscriber 1 fails!");
    });

    const unsub2 = domainEvents.subscribe((type, _entity, entityId) => {
      results.push(`sub2:${type}:${entityId}`);
    });

    const unsub3 = domainEvents.subscribe(() => {
      results.push("sub3-ok");
    });

    domainEvents.publish("ticket.updated", "ticket", "test-fail-sub", {
      reason: "failure-test",
    });

    // Sub1 threw but sub2 and sub3 should still have been called
    expect(results).toContain("sub1-before");
    expect(results).toContain("sub2:ticket.updated:test-fail-sub");
    expect(results).toContain("sub3-ok");
    expect(results).toHaveLength(3);

    unsub1();
    unsub2();
    unsub3();
  });

  it("async subscriber failure does not block other subscribers", async () => {
    const results: string[] = [];

    const unsub1 = domainEvents.subscribe(async () => {
      results.push("async-sub1");
      throw new Error("Async subscriber fails!");
    });

    const unsub2 = domainEvents.subscribe((_type, _entity, entityId) => {
      results.push(`sync-sub2:${entityId}`);
    });

    domainEvents.publish("inventory.low_stock", "inventory", "test-async-fail", {
      available: 1,
    });

    // Both subscribers were called despite async failure
    expect(results).toContain("async-sub1");
    expect(results).toContain("sync-sub2:test-async-fail");

    unsub1();
    unsub2();
  });

  // -------------------------------------------------------------------------
  // Event table persistence for audit replay
  // -------------------------------------------------------------------------

  it("domain events are persisted to the domain_event table with full payload", async () => {
    const db = dbConn.db;
    const uniqueEntityId = `evt-persist-${ts}`;

    domainEvents.publish("order.placed", "order", uniqueEntityId, {
      orderNumber: "KNX-PERSIST-001",
      totalMinor: 9900,
    });

    // Give the async persistence a moment to complete
    await new Promise((r) => setTimeout(r, 300));

    const rows = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.entityId, uniqueEntityId));

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.eventType).toBe("order.placed");
    expect(row.entity).toBe("order");
    expect(row.entityId).toBe(uniqueEntityId);
    expect(row.customerId).toBeNull();
    expect(typeof row.sequenceId).toBe("number");
    expect(row.sequenceId).toBeGreaterThan(0);
    expect(row.createdAt).toBeInstanceOf(Date);

    // Full payload preserved
    const payload = row.payloadJson as Record<string, unknown>;
    expect(payload.orderNumber).toBe("KNX-PERSIST-001");
    expect(payload.totalMinor).toBe(9900);
  });

  it("persisted events include customerId when provided", async () => {
    const db = dbConn.db;
    const uniqueEntityId = `evt-persist-cust-${ts}`;

    domainEvents.publish(
      "ticket.updated",
      "ticket",
      uniqueEntityId,
      { oldStatus: "open", newStatus: "pending" },
      testCustomerId,
    );

    await new Promise((r) => setTimeout(r, 300));

    const rows = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.entityId, uniqueEntityId));

    expect(rows).toHaveLength(1);
    expect(rows[0].customerId).toBe(testCustomerId);
    expect(rows[0].eventType).toBe("ticket.updated");
    const payload = rows[0].payloadJson as Record<string, unknown>;
    expect(payload.oldStatus).toBe("open");
    expect(payload.newStatus).toBe("pending");
  });

  it("multiple events for same aggregate are stored in sequence order", async () => {
    const db = dbConn.db;
    const aggregateId = `evt-seq-${ts}`;

    domainEvents.publish("order.placed", "order", aggregateId, { step: 1 });
    domainEvents.publish("payment.succeeded", "order", aggregateId, { step: 2 });
    domainEvents.publish("shipment.delivered", "order", aggregateId, { step: 3 });

    await new Promise((r) => setTimeout(r, 500));

    const rows = await db
      .select()
      .from(domainEvent)
      .where(eq(domainEvent.entityId, aggregateId))
      .orderBy(domainEvent.sequenceId);

    expect(rows).toHaveLength(3);
    expect(rows[0].eventType).toBe("order.placed");
    expect(rows[1].eventType).toBe("payment.succeeded");
    expect(rows[2].eventType).toBe("shipment.delivered");

    // Sequence IDs are strictly increasing
    expect(rows[1].sequenceId).toBeGreaterThan(rows[0].sequenceId);
    expect(rows[2].sequenceId).toBeGreaterThan(rows[1].sequenceId);

    // Payloads preserved per event
    expect((rows[0].payloadJson as Record<string, unknown>).step).toBe(1);
    expect((rows[1].payloadJson as Record<string, unknown>).step).toBe(2);
    expect((rows[2].payloadJson as Record<string, unknown>).step).toBe(3);
  });
});
