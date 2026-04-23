import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { customer } from "./db/schema/customer.js";
import { cart } from "./db/schema/cart.js";
import { eq } from "drizzle-orm";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import type { WsMessage, WsManager } from "./ws/manager.js";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function verifyEmail(userId: string): Promise<void> {
  const supertokens = await import("supertokens-node");
  const { default: EmailVerification } =
    await import("supertokens-node/recipe/emailverification/index.js");
  const tokenRes = await EmailVerification.createEmailVerificationToken(
    "public",
    supertokens.convertToRecipeUserId(userId),
  );
  if (tokenRes.status === "OK") {
    await EmailVerification.verifyEmailUsingToken("public", tokenRes.token);
  }
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

/**
 * Collect `count` messages from ws, returning them in order.
 * Sets up the listener eagerly so no messages are lost between awaits.
 */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<WsMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: WsMessage[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${count} messages (got ${messages.length})`)),
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
      const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
      reject(new Error(`Unexpected message received: ${JSON.stringify(msg)}`));
    };
    ws.on("message", handler);
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

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS close")), timeoutMs);
    ws.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf-8") });
    });
  });
}

// ---------------------------------------------------------------------------
// Test suite: WebSocket session + event broadcast (T253) [FR-081, FR-082]
// ---------------------------------------------------------------------------

describe("WebSocket session + event broadcast (T253) [FR-081, FR-082]", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let wsAddress: string;
  let wsManager: WsManager;

  const ts = Date.now();
  const adminEmail = `test-ws-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";
  const customerAEmail = `test-ws-custA-${ts}@kanix.dev`;
  const customerAPassword = "CustAPassword123!";
  const customerBEmail = `test-ws-custB-${ts}@kanix.dev`;
  const customerBPassword = "CustBPassword123!";

  let testRoleId: string;
  let testAdminUserId: string;
  let testCustomerAId: string;
  let testCustomerBId: string;
  let testCartId: string;
  let testCartToken: string;

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    wsManager = ts_.server.wsManager as WsManager;

    // Convert HTTP address to WS address
    wsAddress = address.replace(/^http/, "ws");

    // --- Admin setup ---
    const adminAuthSubject = await signUpUser(address, adminEmail, adminPassword);
    await verifyEmail(adminAuthSubject);

    const [role] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_ws_super_admin_${ts}`,
        description: "Test WS super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [adminUsr] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject: adminAuthSubject,
        email: adminEmail,
        name: "Test WS Admin",
        status: "active",
      })
      .returning();
    testAdminUserId = adminUsr.id;

    await dbConn.db.insert(adminUserRole).values({
      adminUserId: adminUsr.id,
      adminRoleId: role.id,
    });

    // --- Customer A setup (auto-created by signUpPOST override) ---
    const customerAAuthSubject = await signUpUser(address, customerAEmail, customerAPassword);
    await verifyEmail(customerAAuthSubject);

    const [custA] = await dbConn.db
      .select({ id: customer.id })
      .from(customer)
      .where(eq(customer.authSubject, customerAAuthSubject));
    testCustomerAId = custA.id;

    // --- Customer B setup (for cross-customer isolation) ---
    const customerBAuthSubject = await signUpUser(address, customerBEmail, customerBPassword);
    await verifyEmail(customerBAuthSubject);

    const [custB] = await dbConn.db
      .select({ id: customer.id })
      .from(customer)
      .where(eq(customer.authSubject, customerBAuthSubject));
    testCustomerBId = custB.id;

    // --- Guest cart ---
    const [cartRow] = await dbConn.db.insert(cart).values({ status: "active" }).returning();
    testCartId = cartRow.id;
    testCartToken = cartRow.token;
  }, 30000);

  afterAll(async () => {
    // Cleanup
    if (testCartId) {
      await dbConn.db.delete(cart).where(eq(cart.id, testCartId));
    }
    if (testAdminUserId) {
      await dbConn.db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, testAdminUserId));
      await dbConn.db.delete(adminUser).where(eq(adminUser.id, testAdminUserId));
    }
    if (testRoleId) {
      await dbConn.db.delete(adminRole).where(eq(adminRole.id, testRoleId));
    }
    // Customers auto-created by signup — clean up
    if (testCustomerAId) {
      await dbConn.db.delete(customer).where(eq(customer.id, testCustomerAId));
    }
    if (testCustomerBId) {
      await dbConn.db.delete(customer).where(eq(customer.id, testCustomerBId));
    }
    await stopTestServer(ts_);
  }, 15000);

  // -------------------------------------------------------------------------
  // Auth rejection tests
  // -------------------------------------------------------------------------

  it("rejects unauthenticated WebSocket connections with code 4001", async () => {
    const ws = new WebSocket(`${wsAddress}/ws`);
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(4001);
    expect(reason).toBe("Unauthorized: no credentials provided");
  });

  it("rejects WebSocket with invalid token with code 4001", async () => {
    const ws = new WebSocket(`${wsAddress}/ws?token=invalid-token-xxx`);
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(4001);
    expect(reason).toBe("Unauthorized: invalid token");
  });

  it("rejects WebSocket with invalid cart token with code 4001", async () => {
    const ws = new WebSocket(`${wsAddress}/ws?cart_token=00000000-0000-0000-0000-000000000000`);
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(4001);
    expect(reason).toBe("Unauthorized: invalid cart token");
  });

  // -------------------------------------------------------------------------
  // Admin connection + event broadcast [FR-082]
  // -------------------------------------------------------------------------

  it("admin connects and receives welcome with wildcard channels", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");
    expect(welcome.entity).toBe("system");
    expect(typeof welcome.entityId).toBe("string");
    expect(welcome.entityId.length).toBeGreaterThan(0);
    expect(welcome.data?.role).toBe("admin");
    expect(welcome.sequenceId).toBeGreaterThan(0);

    const channels = welcome.data?.channels as string[];
    expect(channels).toContain("order:*");
    expect(channels).toContain("payment:*");
    expect(channels).toContain("shipment:*");
    expect(channels).toContain("inventory:*");
    expect(channels).toContain("ticket:*");
    expect(channels).toContain("dispute:*");
    expect(channels).toContain("cart:*");
    expect(channels).toContain("setting:*");
    expect(channels).toContain("contributor:*");

    // Verify reconnection guidance
    const reconnection = welcome.data?.reconnection as Record<string, unknown>;
    expect(reconnection?.strategy).toBe("exponential_backoff");
    expect(reconnection?.initialDelayMs).toBe(1000);
    expect(reconnection?.maxDelayMs).toBe(30000);
    expect(reconnection?.multiplier).toBe(2);

    ws.close();
  });

  it("admin receives published order events", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);
    await waitForMessage(ws); // consume welcome

    const msgPromise = waitForMessage(ws);
    wsManager.publish("order", "test-order-123", "order.placed", {
      orderNumber: "KNX-001",
    });

    const msg = await msgPromise;
    expect(msg.type).toBe("order.placed");
    expect(msg.entity).toBe("order");
    expect(msg.entityId).toBe("test-order-123");
    expect(msg.data?.orderNumber).toBe("KNX-001");
    expect(msg.sequenceId).toBeGreaterThan(0);

    ws.close();
  });

  // -------------------------------------------------------------------------
  // Customer connection + own-events delivery [FR-081]
  // -------------------------------------------------------------------------

  it("customer connects and receives welcome with customer-scoped channel", async () => {
    const accessToken = await signInAndGetAccessToken(address, customerAEmail, customerAPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");
    expect(welcome.data?.role).toBe("customer");

    const channels = welcome.data?.channels as string[];
    expect(channels).toEqual([`customer:${testCustomerAId}`]);
    // Customer must NOT have wildcard admin channels
    expect(channels).not.toContain("order:*");
    expect(channels).not.toContain("payment:*");

    ws.close();
  });

  it("customer receives own order events published to their channel", async () => {
    const accessToken = await signInAndGetAccessToken(address, customerAEmail, customerAPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);
    await waitForMessage(ws); // consume welcome

    const msgPromise = waitForMessage(ws);
    wsManager.publish("customer", testCustomerAId, "order.confirmed", {
      orderNumber: "KNX-100",
      status: "confirmed",
    });

    const msg = await msgPromise;
    expect(msg.type).toBe("order.confirmed");
    expect(msg.entity).toBe("customer");
    expect(msg.entityId).toBe(testCustomerAId);
    expect(msg.data?.orderNumber).toBe("KNX-100");
    expect(msg.data?.status).toBe("confirmed");
    expect(msg.sequenceId).toBeGreaterThan(0);

    ws.close();
  });

  // -------------------------------------------------------------------------
  // Cross-customer isolation [FR-081]
  // -------------------------------------------------------------------------

  it("customer A does NOT receive customer B's events", async () => {
    const tokenA = await signInAndGetAccessToken(address, customerAEmail, customerAPassword);
    const wsA = new WebSocket(`${wsAddress}/ws?token=${tokenA}`);
    await waitForOpen(wsA);
    await waitForMessage(wsA); // consume welcome

    // Publish an event to customer B's channel
    wsManager.publish("customer", testCustomerBId, "order.confirmed", {
      orderNumber: "KNX-B-001",
    });

    // Customer A should NOT receive it
    await expectNoMessage(wsA, 500);

    wsA.close();
  });

  it("customer B does NOT receive customer A's events", async () => {
    const tokenB = await signInAndGetAccessToken(address, customerBEmail, customerBPassword);
    const wsB = new WebSocket(`${wsAddress}/ws?token=${tokenB}`);
    await waitForOpen(wsB);
    await waitForMessage(wsB); // consume welcome

    // Publish an event to customer A's channel
    wsManager.publish("customer", testCustomerAId, "order.shipped", {
      orderNumber: "KNX-A-001",
    });

    // Customer B should NOT receive it
    await expectNoMessage(wsB, 500);

    wsB.close();
  });

  // -------------------------------------------------------------------------
  // Guest WebSocket with cart token
  // -------------------------------------------------------------------------

  it("guest connects with valid cart token and receives cart events", async () => {
    const ws = new WebSocket(`${wsAddress}/ws?cart_token=${testCartToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");
    expect(welcome.data?.role).toBe("guest");

    const channels = welcome.data?.channels as string[];
    expect(channels).toEqual([`cart:${testCartId}`]);

    // Publish a cart event — guest should receive it
    const msgPromise = waitForMessage(ws);
    wsManager.publish("cart", testCartId, "cart.updated", { itemCount: 3 });

    const msg = await msgPromise;
    expect(msg.type).toBe("cart.updated");
    expect(msg.entity).toBe("cart");
    expect(msg.entityId).toBe(testCartId);
    expect(msg.data?.itemCount).toBe(3);
    expect(msg.sequenceId).toBeGreaterThan(0);

    ws.close();
  });

  it("guest does not receive events for other entities", async () => {
    const ws = new WebSocket(`${wsAddress}/ws?cart_token=${testCartToken}`);
    await waitForOpen(ws);
    await waitForMessage(ws); // consume welcome

    // Publish an order event — guest should NOT receive it
    wsManager.publish("order", "some-order-id", "order.placed", {});

    await expectNoMessage(ws, 500);

    ws.close();
  });

  // -------------------------------------------------------------------------
  // IC-008 message contract
  // -------------------------------------------------------------------------

  it("message format matches IC-008 contract with all required fields", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);
    await waitForMessage(ws); // consume welcome

    const msgPromise = waitForMessage(ws);
    wsManager.publish("shipment", "shp-001", "shipment.delivered", {
      trackingNumber: "TRK123",
    });

    const msg = await msgPromise;

    // Verify all IC-008 contract fields with concrete values
    expect(msg.type).toBe("shipment.delivered");
    expect(msg.entity).toBe("shipment");
    expect(msg.entityId).toBe("shp-001");
    expect(msg.data).toEqual({ trackingNumber: "TRK123" });
    expect(typeof msg.sequenceId).toBe("number");
    expect(msg.sequenceId).toBeGreaterThan(0);

    // Verify no extra top-level fields
    const keys = Object.keys(msg).sort();
    expect(keys).toEqual(["data", "entity", "entityId", "sequenceId", "type"]);

    ws.close();
  });

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  it("connection is removed from manager on close", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);
    await waitForMessage(ws); // welcome

    const connCountBefore = wsManager.connections.size;
    expect(connCountBefore).toBeGreaterThan(0);

    ws.close();
    // Wait for close event to propagate
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(wsManager.connections.size).toBe(connCountBefore - 1);
  });

  it("sequence IDs are monotonically increasing across messages", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    const welcomeSeq = welcome.sequenceId;
    expect(welcomeSeq).toBeGreaterThan(0);

    const msg1Promise = waitForMessage(ws);
    wsManager.publish("order", "o1", "order.placed", { n: 1 });
    const msg1 = await msg1Promise;

    const msg2Promise = waitForMessage(ws);
    wsManager.publish("order", "o2", "order.placed", { n: 2 });
    const msg2 = await msg2Promise;

    expect(msg1.sequenceId).toBeGreaterThan(welcomeSeq);
    expect(msg2.sequenceId).toBeGreaterThan(msg1.sequenceId);
    // Verify strict monotonic increment (each +1 since no concurrent publishers)
    expect(msg2.sequenceId).toBe(msg1.sequenceId + 1);

    ws.close();
  });

  // -------------------------------------------------------------------------
  // Reconnect with lastSequenceId — replay missed events [FR-082]
  // -------------------------------------------------------------------------

  it("replays missed messages on reconnect with lastSequenceId", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);

    // First connection: connect and receive a message
    const ws1 = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws1);
    const welcome1 = await waitForMessage(ws1);
    expect(welcome1.type).toBe("connected");

    // Publish message — admin receives it
    const msg1Promise = waitForMessage(ws1);
    wsManager.publish("order", "buf-order-1", "order.placed", { num: 1 });
    const msg1 = await msg1Promise;
    expect(msg1.type).toBe("order.placed");
    expect(msg1.entityId).toBe("buf-order-1");
    const seq1 = msg1.sequenceId;

    // Disconnect
    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // While disconnected, publish another message
    wsManager.publish("order", "buf-order-2", "order.placed", { num: 2 });

    // Reconnect with lastSequenceId = seq1
    // Use collectMessages to eagerly capture welcome + replay in one pass
    // (they are sent in the same server tick, so sequential once() misses the 2nd)
    const ws2 = new WebSocket(`${wsAddress}/ws?token=${accessToken}&lastSequenceId=${seq1}`);
    const msgs = collectMessages(ws2, 2, 5000);
    await waitForOpen(ws2);
    const [welcome2, replayed] = await msgs;

    expect(welcome2.type).toBe("connected");

    expect(replayed.type).toBe("order.placed");
    expect(replayed.entityId).toBe("buf-order-2");
    expect(replayed.data?.num).toBe(2);
    expect(replayed.sequenceId).toBeGreaterThan(seq1);

    ws2.close();
  });

  it("does not replay messages already received (sequenceId <= lastSequenceId)", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);

    // Connect and receive some messages
    const ws1 = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws1);
    await waitForMessage(ws1); // welcome

    const msg1Promise = waitForMessage(ws1);
    wsManager.publish("order", "no-replay-1", "order.placed", {});
    await msg1Promise;

    const msg2Promise = waitForMessage(ws1);
    wsManager.publish("order", "no-replay-2", "order.placed", {});
    const msg2 = await msg2Promise;

    const lastSeq = msg2.sequenceId;

    // Disconnect
    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Reconnect with lastSequenceId = lastSeq (already received everything)
    // Collect just the welcome, then verify nothing else arrives
    const ws2 = new WebSocket(`${wsAddress}/ws?token=${accessToken}&lastSequenceId=${lastSeq}`);
    const msgs = collectMessages(ws2, 1, 5000);
    await waitForOpen(ws2);
    const [welcome2] = await msgs;
    expect(welcome2.type).toBe("connected");

    // No more messages should arrive (nothing missed)
    await expectNoMessage(ws2, 500);

    ws2.close();
  });

  it("buffers messages and they are available in the buffer", async () => {
    const bufferLengthBefore = wsManager.messageBuffer.length;

    // Publish a message — it should be buffered
    wsManager.publish("order", "buffer-test-1", "order.placed", { test: true });

    expect(wsManager.messageBuffer.length).toBe(bufferLengthBefore + 1);

    const last = wsManager.messageBuffer[wsManager.messageBuffer.length - 1];
    expect(last.message.type).toBe("order.placed");
    expect(last.message.entityId).toBe("buffer-test-1");
    expect(last.message.data).toEqual({ test: true });
    expect(last.channel).toBe("order:buffer-test-1");
    expect(last.wildcardChannel).toBe("order:*");
    expect(last.timestamp).toBeGreaterThan(0);
  });

  it("guest reconnects and receives missed cart events", async () => {
    // Connect as guest
    const ws1 = new WebSocket(`${wsAddress}/ws?cart_token=${testCartToken}`);
    await waitForOpen(ws1);
    const welcome1 = await waitForMessage(ws1);
    expect(welcome1.data?.role).toBe("guest");

    // Receive a cart event
    const cartMsgPromise = waitForMessage(ws1);
    wsManager.publish("cart", testCartId, "cart.updated", { items: 1 });
    const cartMsg = await cartMsgPromise;
    expect(cartMsg.type).toBe("cart.updated");
    const seq1 = cartMsg.sequenceId;

    // Disconnect
    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Publish another cart event while disconnected
    wsManager.publish("cart", testCartId, "cart.updated", { items: 2 });

    // Reconnect with lastSequenceId — collect welcome + replay eagerly
    const ws2 = new WebSocket(`${wsAddress}/ws?cart_token=${testCartToken}&lastSequenceId=${seq1}`);
    const msgs = collectMessages(ws2, 2, 5000);
    await waitForOpen(ws2);
    const [welcome2, replayed] = await msgs;

    expect(welcome2.type).toBe("connected");
    expect(replayed.type).toBe("cart.updated");
    expect(replayed.entity).toBe("cart");
    expect(replayed.entityId).toBe(testCartId);
    expect(replayed.data?.items).toBe(2);
    expect(replayed.sequenceId).toBeGreaterThan(seq1);

    ws2.close();
  });
});
