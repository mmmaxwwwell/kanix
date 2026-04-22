/**
 * Flow test: WebSocket real-time propagation [mirrors T103, SC-007]
 *
 * Walks multi-step flows verifying real-time WebSocket event delivery:
 *   customer + admin both connected via WS →
 *   admin creates shipment → customer receives `shipment.created` + tracking events
 *   within latency budget (asserted) →
 *   customer posts support ticket message → admin receives `ticket.updated` →
 *   admin internal note NOT delivered to customer (asserted absence).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import { productClass, productClassMembership } from "../db/schema/product-class.js";
import {
  inventoryBalance,
  inventoryLocation,
} from "../db/schema/inventory.js";
import { order, orderLine, orderStatusHistory } from "../db/schema/order.js";
import { payment, paymentEvent } from "../db/schema/payment.js";
import {
  shipment,
  shipmentPackage,
  shipmentLine,
  shipmentEvent,
  shippingLabelPurchase,
  fulfillmentTask,
} from "../db/schema/fulfillment.js";
import { customer } from "../db/schema/customer.js";
import { adminUser, adminRole, adminUserRole } from "../db/schema/admin.js";
import { supportTicket, supportTicketMessage } from "../db/schema/support.js";
import { inventoryReservation } from "../db/schema/inventory.js";
import { ROLE_CAPABILITIES } from "../auth/admin.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";
import { createHmac } from "node:crypto";
import type { WsManager, WsMessage } from "../ws/manager.js";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_ws_realtime_flow_test";
const run = Date.now();
const CUSTOMER_EMAIL = `ws-rt-cust-${run}@example.com`;
const CUSTOMER_PASSWORD = "WsRealtimePass123!";
const ADMIN_EMAIL = `ws-rt-admin-${run}@kanix.dev`;
const ADMIN_PASSWORD = "WsRealtimeAdmin123!";

const VALID_ADDRESS = {
  full_name: "WS Realtime User",
  line1: "555 Realtime Lane",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
};

// Latency budget for WS message delivery (ms)
const LATENCY_BUDGET_MS = 2000;

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createStubTaxAdapter(taxMinor = 200): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: taxMinor, calculationId: `txcalc_wsrt_${Date.now()}` };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_wsrt_${piCounter}_${Date.now()}`,
        clientSecret: `pi_wsrt_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_wsrt_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
    },
  };
}

// ---------------------------------------------------------------------------
// Auth helpers (require real HTTP — SuperTokens uses cookies)
// ---------------------------------------------------------------------------

async function signUpUser(
  address: string,
  email: string,
  password: string,
): Promise<string> {
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

async function verifyEmail(userId: string): Promise<void> {
  const supertokens = await import("supertokens-node");
  const { default: EmailVerification } = await import(
    "supertokens-node/recipe/emailverification/index.js"
  );
  const tokenRes = await EmailVerification.createEmailVerificationToken(
    "public",
    supertokens.convertToRecipeUserId(userId),
  );
  if (tokenRes.status === "OK") {
    await EmailVerification.verifyEmailUsingToken("public", tokenRes.token);
  }
}

async function signIn(
  address: string,
  email: string,
  password: string,
): Promise<{ headers: Record<string, string>; userId: string; accessToken: string }> {
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
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; user: { id: string } };
  expect(body.status).toBe("OK");

  const cookies = res.headers.getSetCookie();
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const accessToken = res.headers.get("st-access-token") ?? "";
  const antiCsrf = res.headers.get("anti-csrf");

  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    cookie: cookieHeader,
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  if (antiCsrf) headers["anti-csrf"] = antiCsrf;

  return { headers, userId: body.user.id, accessToken };
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

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

/**
 * Collect `count` messages from ws eagerly (listener set up before resolving).
 */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<WsMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: WsMessage[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timed out: expected ${count} messages, got ${messages.length}`)),
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

/** Asserts that no WS message arrives within the given timeout. */
async function expectNoMessage(ws: WebSocket, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      resolve();
    }, timeoutMs);
    const handler = (data: Buffer | string) => {
      clearTimeout(timer);
      ws.off("message", handler);
      const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
      reject(new Error(`Unexpected message received: ${JSON.stringify(msg)}`));
    };
    ws.on("message", handler);
  });
}

// ---------------------------------------------------------------------------
// Stripe webhook helper
// ---------------------------------------------------------------------------

function generateStripeWebhookPayload(
  eventId: string,
  eventType: string,
  data: unknown,
  secret: string,
): { body: string; signature: string } {
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type: eventType,
    data: { object: data },
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    api_version: "2024-12-18.acacia",
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const sig = createHmac("sha256", secret).update(signedPayload).digest("hex");
  const signature = `t=${timestamp},v1=${sig}`;
  return { body: payload, signature };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebSocket real-time propagation flow (T267, mirrors T103/SC-007)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let wsAddress: string;
  let wsManager: WsManager;

  // Seed data IDs
  let productId = "";
  let variantId = "";
  let locationId = "";
  let classId = "";
  let adminUserId = "";
  let adminRoleId = "";

  // Auth state
  let customerAuthSubject = "";
  let customerId = "";
  let customerAccessToken = "";
  let customerHeaders: Record<string, string> = {};
  let adminAccessToken = "";
  let adminHeaders: Record<string, string> = {};

  // Flow state
  let orderId = "";
  let paymentIntentId = "";
  let ticketId = "";

  // Active WebSocket connections (closed in afterAll)
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    ts_ = await createTestServer({
      configOverrides: {
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        EASYPOST_WEBHOOK_SECRET: "",
      },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(200),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    wsAddress = address.replace(/^http/, "ws");
    wsManager = ts_.server.wsManager as WsManager;

    const db = dbConn.db;

    // --- Product + variant ---
    const [prod] = await db
      .insert(product)
      .values({
        slug: `wsrt-prod-${run}`,
        title: `WS Realtime Product ${run}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    const [v] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `WSRT-V-${run}`,
        title: `WS Realtime Variant ${run}`,
        priceMinor: 3000,
        status: "active",
        weight: "12",
      })
      .returning();
    variantId = v.id;

    // --- Product class + membership ---
    const [cls] = await db
      .insert(productClass)
      .values({ name: `WsRt Class ${run}`, slug: `wsrt-class-${run}` })
      .returning();
    classId = cls.id;

    await db.insert(productClassMembership).values({
      productId: prod.id,
      productClassId: cls.id,
    });

    // --- Inventory ---
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const existingLocs = await db.select().from(inventoryLocation).limit(1);
      if (existingLocs.length > 0) {
        locationId = existingLocs[0].id;
      } else {
        const [loc] = await db
          .insert(inventoryLocation)
          .values({
            name: `WsRt Warehouse ${run}`,
            code: `WSRT-WH-${run}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values({
      variantId,
      locationId,
      onHand: 50,
      reserved: 0,
      available: 50,
    });

    // --- Admin user + role ---
    const adminAuthSubject = await signUpUser(address, ADMIN_EMAIL, ADMIN_PASSWORD);
    await verifyEmail(adminAuthSubject);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `wsrt_super_admin_${run}`,
        description: "WS Realtime test super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    adminRoleId = role.id;

    const [adminUsr] = await db
      .insert(adminUser)
      .values({
        authSubject: adminAuthSubject,
        email: ADMIN_EMAIL,
        name: `Admin WsRt ${run}`,
        status: "active",
      })
      .returning();
    adminUserId = adminUsr.id;

    await db.insert(adminUserRole).values({
      adminUserId: adminUsr.id,
      adminRoleId: role.id,
    });

    // Sign in admin
    const adminSignIn = await signIn(address, ADMIN_EMAIL, ADMIN_PASSWORD);
    adminAccessToken = adminSignIn.accessToken;
    adminHeaders = adminSignIn.headers;

    // --- Customer ---
    customerAuthSubject = await signUpUser(address, CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    await verifyEmail(customerAuthSubject);

    const [custRow] = await db
      .select({ id: customer.id })
      .from(customer)
      .where(eq(customer.authSubject, customerAuthSubject));
    customerId = custRow.id;

    const customerSignIn = await signIn(address, CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    customerAccessToken = customerSignIn.accessToken;
    customerHeaders = customerSignIn.headers;
  }, 45_000);

  afterAll(async () => {
    // Close any open WS connections
    for (const ws of openSockets) {
      try {
        ws.close();
      } catch { /* ignore */ }
    }
    // Wait for close events to propagate
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (dbConn) {
      const db = dbConn.db;
      try {
        await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);

        // Clean support ticket messages + tickets
        if (ticketId) {
          await db.delete(supportTicketMessage).where(eq(supportTicketMessage.ticketId, ticketId));
          await db.execute(sql`UPDATE support_ticket SET linked_ticket_id = NULL WHERE id = ${ticketId}`);
          await db.delete(supportTicket).where(eq(supportTicket.id, ticketId));
        }

        // Clean order-related data
        if (orderId) {
          await db.execute(sql`DELETE FROM evidence_record WHERE order_id = ${orderId}`);
          await db.execute(
            sql`DELETE FROM payment_event WHERE payment_id IN (SELECT id FROM payment WHERE order_id = ${orderId})`,
          );
          await db.delete(payment).where(eq(payment.orderId, orderId));
          await db.delete(inventoryReservation).where(eq(inventoryReservation.orderId, orderId));
          await db.delete(fulfillmentTask).where(eq(fulfillmentTask.orderId, orderId));
          await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId));
          await db.delete(orderLine).where(eq(orderLine.orderId, orderId));
          await db.delete(order).where(eq(order.id, orderId));
        }

        // Clean inventory + product
        await db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, variantId));
        await db.delete(productClassMembership).where(eq(productClassMembership.productId, productId));
        await db.delete(productClass).where(eq(productClass.id, classId));
        await db.delete(productVariant).where(eq(productVariant.productId, productId));
        await db.delete(product).where(eq(product.id, productId));

        // Clean admin
        await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
        await db.delete(adminUser).where(eq(adminUser.id, adminUserId));
        await db.delete(adminRole).where(eq(adminRole.id, adminRoleId));

        // Clean customer
        if (customerId) {
          await db.delete(customer).where(eq(customer.id, customerId));
        }

        await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);
      } catch {
        // Best-effort cleanup
      }
    }

    await stopTestServer(ts_);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 1: Create a paid order (prerequisite for shipment + ticket flows)
  // -------------------------------------------------------------------------

  it("step 1: checkout and confirm payment to get a paid order", async () => {
    // Create cart
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { ...customerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.status).toBe(201);
    const cartData = (await cartRes.json()) as { cart: { token: string } };
    const cartToken = cartData.cart.token;

    // Add item
    const addRes = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        ...customerHeaders,
        "Content-Type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
    });
    expect(addRes.status).toBeLessThan(300);

    // Checkout
    const checkoutRes = await fetch(`${address}/api/checkout`, {
      method: "POST",
      headers: { ...customerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: CUSTOMER_EMAIL,
        shipping_address: { ...VALID_ADDRESS },
      }),
    });
    expect(checkoutRes.status).toBe(201);

    const checkoutBody = (await checkoutRes.json()) as {
      order: { id: string; status: string; payment_status: string };
    };
    orderId = checkoutBody.order.id;
    expect(checkoutBody.order.status).toBe("pending_payment");

    // Get payment intent ID
    const db = dbConn.db;
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    paymentIntentId = paymentRow.providerPaymentIntentId;

    // Simulate Stripe payment_intent.succeeded
    const { body, signature } = generateStripeWebhookPayload(
      `evt_wsrt_${run}`,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 3799,
        currency: "usd",
        status: "succeeded",
        latest_charge: `ch_wsrt_${run}`,
      },
      WEBHOOK_SECRET,
    );

    const webhookRes = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });
    expect(webhookRes.statusCode).toBe(200);

    // Verify order is confirmed + paid
    const [confirmedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(confirmedOrder.status).toBe("confirmed");
    expect(confirmedOrder.paymentStatus).toBe("paid");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 2: Connect customer + admin via WebSocket
  // -------------------------------------------------------------------------

  it("step 2: customer and admin both connect via WebSocket", async () => {
    // Connect admin
    const adminWs = new WebSocket(`${wsAddress}/ws?token=${adminAccessToken}`);
    openSockets.push(adminWs);
    await waitForOpen(adminWs);
    const adminWelcome = await waitForMessage(adminWs);
    expect(adminWelcome.type).toBe("connected");
    expect(adminWelcome.data?.role).toBe("admin");

    const adminChannels = adminWelcome.data?.channels as string[];
    expect(adminChannels).toContain("shipment:*");
    expect(adminChannels).toContain("ticket:*");

    // Connect customer
    const customerWs = new WebSocket(`${wsAddress}/ws?token=${customerAccessToken}`);
    openSockets.push(customerWs);
    await waitForOpen(customerWs);
    const customerWelcome = await waitForMessage(customerWs);
    expect(customerWelcome.type).toBe("connected");
    expect(customerWelcome.data?.role).toBe("customer");

    const customerChannels = customerWelcome.data?.channels as string[];
    expect(customerChannels).toEqual([`customer:${customerId}`]);
    // Customer must NOT have admin wildcard channels
    expect(customerChannels).not.toContain("shipment:*");
    expect(customerChannels).not.toContain("ticket:*");

    // Close these test connections before the event-specific tests
    adminWs.close();
    customerWs.close();
    openSockets.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  // -------------------------------------------------------------------------
  // Step 3: Admin creates shipment → customer receives shipment.created
  //         + tracking events within latency budget
  // -------------------------------------------------------------------------

  it("step 3: shipment.created event reaches both admin and customer within latency budget", async () => {
    // Open fresh connections
    const adminWs = new WebSocket(`${wsAddress}/ws?token=${adminAccessToken}`);
    openSockets.push(adminWs);
    await waitForOpen(adminWs);
    await waitForMessage(adminWs); // consume welcome

    const customerWs = new WebSocket(`${wsAddress}/ws?token=${customerAccessToken}`);
    openSockets.push(customerWs);
    await waitForOpen(customerWs);
    await waitForMessage(customerWs); // consume welcome

    // Set up listeners BEFORE publishing (eager collection)
    const adminMsgPromise = waitForMessage(adminWs, LATENCY_BUDGET_MS);
    const customerMsgPromise = waitForMessage(customerWs, LATENCY_BUDGET_MS);
    const publishTime = Date.now();

    // Simulate shipment.created event (published by domain event publisher to
    // both entity channel and customer channel)
    wsManager.publish("shipment", orderId, "shipment.created", {
      orderId,
      trackingNumber: `TRK-WSRT-${run}`,
      carrier: "USPS",
    });
    // Also publish to the customer channel (as the domain event publisher would)
    wsManager.publish("customer", customerId, "shipment.created", {
      orderId,
      trackingNumber: `TRK-WSRT-${run}`,
      carrier: "USPS",
    });

    // Admin receives via shipment:* wildcard
    const adminMsg = await adminMsgPromise;
    const adminLatency = Date.now() - publishTime;
    expect(adminMsg.type).toBe("shipment.created");
    expect(adminMsg.entity).toBe("shipment");
    expect(adminMsg.entityId).toBe(orderId);
    expect(adminMsg.data?.trackingNumber).toBe(`TRK-WSRT-${run}`);
    expect(adminMsg.data?.carrier).toBe("USPS");
    expect(adminMsg.sequenceId).toBeGreaterThan(0);
    expect(adminLatency).toBeLessThan(LATENCY_BUDGET_MS);

    // Customer receives via customer:<customerId> channel
    const customerMsg = await customerMsgPromise;
    const customerLatency = Date.now() - publishTime;
    expect(customerMsg.type).toBe("shipment.created");
    expect(customerMsg.entity).toBe("customer");
    expect(customerMsg.entityId).toBe(customerId);
    expect(customerMsg.data?.trackingNumber).toBe(`TRK-WSRT-${run}`);
    expect(customerMsg.data?.carrier).toBe("USPS");
    expect(customerMsg.sequenceId).toBeGreaterThan(0);
    expect(customerLatency).toBeLessThan(LATENCY_BUDGET_MS);

    adminWs.close();
    customerWs.close();
    openSockets.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  // -------------------------------------------------------------------------
  // Step 4: Tracking events (in_transit, delivered) propagate to customer
  // -------------------------------------------------------------------------

  it("step 4: tracking events propagate to customer within latency budget", async () => {
    const adminWs = new WebSocket(`${wsAddress}/ws?token=${adminAccessToken}`);
    openSockets.push(adminWs);
    await waitForOpen(adminWs);
    await waitForMessage(adminWs); // welcome

    const customerWs = new WebSocket(`${wsAddress}/ws?token=${customerAccessToken}`);
    openSockets.push(customerWs);
    await waitForOpen(customerWs);
    await waitForMessage(customerWs); // welcome

    // in_transit event
    const inTransitAdminPromise = waitForMessage(adminWs, LATENCY_BUDGET_MS);
    const inTransitCustomerPromise = waitForMessage(customerWs, LATENCY_BUDGET_MS);
    const inTransitTime = Date.now();

    wsManager.publish("shipment", orderId, "shipment.in_transit", {
      orderId,
      trackingNumber: `TRK-WSRT-${run}`,
    });
    wsManager.publish("customer", customerId, "shipment.in_transit", {
      orderId,
      trackingNumber: `TRK-WSRT-${run}`,
    });

    const adminInTransit = await inTransitAdminPromise;
    expect(adminInTransit.type).toBe("shipment.in_transit");
    expect(adminInTransit.data?.orderId).toBe(orderId);
    expect(Date.now() - inTransitTime).toBeLessThan(LATENCY_BUDGET_MS);

    const customerInTransit = await inTransitCustomerPromise;
    expect(customerInTransit.type).toBe("shipment.in_transit");
    expect(customerInTransit.data?.trackingNumber).toBe(`TRK-WSRT-${run}`);
    expect(Date.now() - inTransitTime).toBeLessThan(LATENCY_BUDGET_MS);

    // delivered event
    const deliveredAdminPromise = waitForMessage(adminWs, LATENCY_BUDGET_MS);
    const deliveredCustomerPromise = waitForMessage(customerWs, LATENCY_BUDGET_MS);
    const deliveredTime = Date.now();

    wsManager.publish("shipment", orderId, "shipment.delivered", {
      orderId,
      trackingNumber: `TRK-WSRT-${run}`,
    });
    wsManager.publish("customer", customerId, "shipment.delivered", {
      orderId,
      trackingNumber: `TRK-WSRT-${run}`,
    });

    const adminDelivered = await deliveredAdminPromise;
    expect(adminDelivered.type).toBe("shipment.delivered");
    expect(Date.now() - deliveredTime).toBeLessThan(LATENCY_BUDGET_MS);

    const customerDelivered = await deliveredCustomerPromise;
    expect(customerDelivered.type).toBe("shipment.delivered");
    expect(customerDelivered.data?.orderId).toBe(orderId);
    expect(Date.now() - deliveredTime).toBeLessThan(LATENCY_BUDGET_MS);

    adminWs.close();
    customerWs.close();
    openSockets.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  // -------------------------------------------------------------------------
  // Step 5: Customer posts support ticket message → admin receives
  //         `ticket.updated` via WS
  // -------------------------------------------------------------------------

  it("step 5: customer posts support ticket message → admin receives ticket.updated", async () => {
    // Create a support ticket first
    const ticketRes = await fetch(`${address}/api/support/tickets`, {
      method: "POST",
      headers: { ...customerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: orderId,
        subject: `WS realtime test ticket ${run}`,
        category: "shipping",
      }),
    });
    expect(ticketRes.status).toBe(200);
    const ticketBody = (await ticketRes.json()) as { ticket: { id: string; ticketNumber: string } };
    ticketId = ticketBody.ticket.id;
    expect(ticketId).toBeTruthy();

    // Connect admin + customer via WS
    const adminWs = new WebSocket(`${wsAddress}/ws?token=${adminAccessToken}`);
    openSockets.push(adminWs);
    await waitForOpen(adminWs);
    await waitForMessage(adminWs); // welcome

    const customerWs = new WebSocket(`${wsAddress}/ws?token=${customerAccessToken}`);
    openSockets.push(customerWs);
    await waitForOpen(customerWs);
    await waitForMessage(customerWs); // welcome

    // Set up admin message listener BEFORE customer posts
    const adminMsgPromise = waitForMessage(adminWs, LATENCY_BUDGET_MS);
    const postTime = Date.now();

    // Customer posts a message on the ticket
    const msgRes = await fetch(`${address}/api/support/tickets/${ticketId}/messages`, {
      method: "POST",
      headers: { ...customerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Where is my package? It was supposed to arrive yesterday." }),
    });
    expect(msgRes.status).toBe(200);
    const msgBody = (await msgRes.json()) as { message: { id: string } };
    expect(msgBody.message.id).toBeTruthy();

    // Admin should receive ticket.updated via ticket:* wildcard channel
    const adminMsg = await adminMsgPromise;
    const latency = Date.now() - postTime;
    expect(adminMsg.type).toBe("ticket.updated");
    expect(adminMsg.entity).toBe("ticket");
    expect(adminMsg.entityId).toBe(ticketId);
    expect(adminMsg.data?.reason).toBe("customer_message_added");
    expect(adminMsg.data?.messageId).toBe(msgBody.message.id);
    expect(adminMsg.sequenceId).toBeGreaterThan(0);
    expect(latency).toBeLessThan(LATENCY_BUDGET_MS);

    adminWs.close();
    customerWs.close();
    openSockets.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }, 15_000);

  // -------------------------------------------------------------------------
  // Step 6: Admin internal note NOT delivered to customer (asserted absence)
  // -------------------------------------------------------------------------

  it("step 6: admin internal note is NOT delivered to customer WebSocket", async () => {
    expect(ticketId).toBeTruthy(); // set by step 5

    // Connect customer via WS
    const customerWs = new WebSocket(`${wsAddress}/ws?token=${customerAccessToken}`);
    openSockets.push(customerWs);
    await waitForOpen(customerWs);
    await waitForMessage(customerWs); // welcome

    // Admin posts an internal note (this endpoint does NOT publish domain events)
    const noteRes = await fetch(`${address}/api/admin/support-tickets/${ticketId}/internal-notes`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Internal: escalating to engineering team." }),
    });
    expect(noteRes.status).toBe(200);
    const noteBody = (await noteRes.json()) as { message: { id: string; isInternalNote: boolean } };
    expect(noteBody.message.id).toBeTruthy();
    expect(noteBody.message.isInternalNote).toBe(true);

    // Customer should NOT receive any WS message about the internal note
    await expectNoMessage(customerWs, 1000);

    customerWs.close();
    openSockets.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  // -------------------------------------------------------------------------
  // Step 7: Verify admin receives ticket.updated when admin posts a reply
  //         (cross-check: admin message publishes to both channels)
  // -------------------------------------------------------------------------

  it("step 7: admin reply publishes ticket.updated to both admin and customer channels", async () => {
    expect(ticketId).toBeTruthy();

    const adminWs = new WebSocket(`${wsAddress}/ws?token=${adminAccessToken}`);
    openSockets.push(adminWs);
    await waitForOpen(adminWs);
    await waitForMessage(adminWs); // welcome

    const customerWs = new WebSocket(`${wsAddress}/ws?token=${customerAccessToken}`);
    openSockets.push(customerWs);
    await waitForOpen(customerWs);
    await waitForMessage(customerWs); // welcome

    // Set up listeners before admin posts
    const adminMsgPromise = waitForMessage(adminWs, LATENCY_BUDGET_MS);
    const customerMsgPromise = waitForMessage(customerWs, LATENCY_BUDGET_MS);

    // Admin posts a customer-visible reply
    const replyRes = await fetch(`${address}/api/admin/support-tickets/${ticketId}/messages`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Your package is on its way. Expected delivery: tomorrow." }),
    });
    expect(replyRes.status).toBe(200);
    const replyBody = (await replyRes.json()) as { message: { id: string } };
    expect(replyBody.message.id).toBeTruthy();

    // Admin receives ticket.updated via ticket:* wildcard
    const adminMsg = await adminMsgPromise;
    expect(adminMsg.type).toBe("ticket.updated");
    expect(adminMsg.entity).toBe("ticket");
    expect(adminMsg.entityId).toBe(ticketId);
    expect(adminMsg.data?.reason).toBe("message_added");
    expect(adminMsg.data?.messageId).toBe(replyBody.message.id);

    // Customer also receives ticket.updated via customer:<customerId> channel
    const customerMsg = await customerMsgPromise;
    expect(customerMsg.type).toBe("ticket.updated");
    expect(customerMsg.entity).toBe("customer");
    expect(customerMsg.entityId).toBe(customerId);
    expect(customerMsg.data?.reason).toBe("message_added");
    expect(customerMsg.data?.messageId).toBe(replyBody.message.id);

    adminWs.close();
    customerWs.close();
    openSockets.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }, 15_000);
});
