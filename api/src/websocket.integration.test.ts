import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { customer } from "./db/schema/customer.js";
import { cart } from "./db/schema/cart.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import type { WsMessage, WsManager } from "./ws/manager.js";
import WebSocket from "ws";
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

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS close")), timeoutMs);
    ws.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf-8") });
    });
  });
}

describe("WebSocket server with auth (T072)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let wsAddress: string;
  let wsManager: WsManager;

  const ts = Date.now();
  const adminEmail = `test-ws-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";
  const customerEmail = `test-ws-customer-${ts}@kanix.dev`;
  const customerPassword = "CustPassword123!";

  let testRoleId: string;
  let testAdminUserId: string;
  let testCustomerId: string;
  let testCartId: string;
  let testCartToken: string;

  beforeAll(async () => {
    await assertSuperTokensUp();

    dbConn = createDatabaseConnection(DATABASE_URL);
    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
    });
    address = await server.start();
    markReady();
    app = server.app;
    wsManager = server.wsManager as WsManager;

    // Convert HTTP address to WS address
    wsAddress = address.replace(/^http/, "ws");

    // Create admin user
    const adminAuthSubject = await signUpUser(address, adminEmail, adminPassword);

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

    // Create customer user
    const customerAuthSubject = await signUpUser(address, customerEmail, customerPassword);

    const [cust] = await dbConn.db
      .insert(customer)
      .values({
        authSubject: customerAuthSubject,
        email: customerEmail,
        firstName: "Test",
        lastName: "WS Customer",
      })
      .returning();
    testCustomerId = cust.id;

    // Create a cart for guest testing
    const [cartRow] = await dbConn.db.insert(cart).values({ status: "active" }).returning();
    testCartId = cartRow.id;
    testCartToken = cartRow.token;
  }, 30000);

  afterAll(async () => {
    markNotReady();

    // Cleanup
    if (testCartId) {
      await dbConn.db.delete(cart).where((await import("drizzle-orm")).eq(cart.id, testCartId));
    }
    if (testAdminUserId) {
      await dbConn.db
        .delete(adminUserRole)
        .where((await import("drizzle-orm")).eq(adminUserRole.adminUserId, testAdminUserId));
      await dbConn.db
        .delete(adminUser)
        .where((await import("drizzle-orm")).eq(adminUser.id, testAdminUserId));
    }
    if (testRoleId) {
      await dbConn.db
        .delete(adminRole)
        .where((await import("drizzle-orm")).eq(adminRole.id, testRoleId));
    }
    if (testCustomerId) {
      await dbConn.db
        .delete(customer)
        .where((await import("drizzle-orm")).eq(customer.id, testCustomerId));
    }

    await app.close();
    await dbConn.close();
  }, 15000);

  it("rejects unauthenticated WebSocket connections", async () => {
    const ws = new WebSocket(`${wsAddress}/ws`);
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(4001);
    expect(reason).toContain("Unauthorized");
  });

  it("rejects WebSocket with invalid token", async () => {
    const ws = new WebSocket(`${wsAddress}/ws?token=invalid-token-xxx`);
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(4001);
    expect(reason).toContain("Unauthorized");
  });

  it("rejects WebSocket with invalid cart token", async () => {
    const ws = new WebSocket(`${wsAddress}/ws?cart_token=00000000-0000-0000-0000-000000000000`);
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(4001);
    expect(reason).toContain("Unauthorized");
  });

  it("admin connects and receives welcome with wildcard channels", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");
    expect(welcome.entity).toBe("system");
    expect(welcome.data?.role).toBe("admin");
    expect(welcome.sequenceId).toBeGreaterThan(0);

    const channels = welcome.data?.channels as string[];
    expect(channels).toContain("order:*");
    expect(channels).toContain("payment:*");
    expect(channels).toContain("shipment:*");
    expect(channels).toContain("inventory:*");

    // Verify reconnection guidance
    const reconnection = welcome.data?.reconnection as Record<string, unknown>;
    expect(reconnection?.strategy).toBe("exponential_backoff");
    expect(reconnection?.initialDelayMs).toBe(1000);
    expect(reconnection?.maxDelayMs).toBe(30000);

    ws.close();
  });

  it("admin receives published events", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    // Consume the welcome message
    await waitForMessage(ws);

    // Publish an order event
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

  it("customer connects and receives welcome with customer channel", async () => {
    const accessToken = await signInAndGetAccessToken(address, customerEmail, customerPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");
    expect(welcome.data?.role).toBe("customer");

    const channels = welcome.data?.channels as string[];
    expect(channels).toContain(`customer:${testCustomerId}`);
    // Customer should NOT have wildcard channels
    expect(channels).not.toContain("order:*");

    ws.close();
  });

  it("guest connects with valid cart token and receives cart events", async () => {
    const ws = new WebSocket(`${wsAddress}/ws?cart_token=${testCartToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");
    expect(welcome.data?.role).toBe("guest");

    const channels = welcome.data?.channels as string[];
    expect(channels).toContain(`cart:${testCartId}`);

    // Publish a cart event — guest should receive it
    const msgPromise = waitForMessage(ws);
    wsManager.publish("cart", testCartId, "cart.updated", { itemCount: 3 });

    const msg = await msgPromise;
    expect(msg.type).toBe("cart.updated");
    expect(msg.entity).toBe("cart");
    expect(msg.entityId).toBe(testCartId);
    expect(msg.data?.itemCount).toBe(3);

    ws.close();
  });

  it("guest does not receive events for other entities", async () => {
    const ws = new WebSocket(`${wsAddress}/ws?cart_token=${testCartToken}`);
    await waitForOpen(ws);

    // Consume welcome
    await waitForMessage(ws);

    // Publish an order event — guest should NOT receive it
    wsManager.publish("order", "some-order-id", "order.placed", {});

    // Wait a short time to ensure no message arrives
    const received = await Promise.race([
      waitForMessage(ws, 500).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 600)),
    ]);

    expect(received).toBe(false);

    ws.close();
  });

  it("message format matches IC-008 contract", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    // Consume welcome
    await waitForMessage(ws);

    const msgPromise = waitForMessage(ws);
    wsManager.publish("shipment", "shp-001", "shipment.delivered", {
      trackingNumber: "TRK123",
    });

    const msg = await msgPromise;

    // Verify all IC-008 contract fields
    expect(msg).toHaveProperty("type");
    expect(msg).toHaveProperty("entity");
    expect(msg).toHaveProperty("entityId");
    expect(msg).toHaveProperty("data");
    expect(msg).toHaveProperty("sequenceId");
    expect(typeof msg.type).toBe("string");
    expect(typeof msg.entity).toBe("string");
    expect(typeof msg.entityId).toBe("string");
    expect(typeof msg.data).toBe("object");
    expect(typeof msg.sequenceId).toBe("number");

    ws.close();
  });

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

    expect(wsManager.connections.size).toBeLessThan(connCountBefore);
  });

  it("sequence IDs are monotonically increasing", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    const welcomeSeq = welcome.sequenceId;

    const msg1Promise = waitForMessage(ws);
    wsManager.publish("order", "o1", "order.placed", {});
    const msg1 = await msg1Promise;

    const msg2Promise = waitForMessage(ws);
    wsManager.publish("order", "o2", "order.placed", {});
    const msg2 = await msg2Promise;

    expect(msg1.sequenceId).toBeGreaterThan(welcomeSeq);
    expect(msg2.sequenceId).toBeGreaterThan(msg1.sequenceId);

    ws.close();
  });

  // ---------------------------------------------------------------------------
  // T073: Message buffering tests
  // ---------------------------------------------------------------------------

  it("replays missed messages on reconnect with lastSequenceId", async () => {
    const accessToken = await signInAndGetAccessToken(address, adminEmail, adminPassword);

    // First connection: connect and receive a message
    const ws1 = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws1);
    const welcome1 = await waitForMessage(ws1);
    expect(welcome1.type).toBe("connected");

    // Publish message seq 1 — admin receives it
    const msg1Promise = waitForMessage(ws1);
    wsManager.publish("order", "buf-order-1", "order.placed", { num: 1 });
    const msg1 = await msg1Promise;
    expect(msg1.type).toBe("order.placed");
    const seq1 = msg1.sequenceId;

    // Disconnect
    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // While disconnected, publish another message (seq 2)
    wsManager.publish("order", "buf-order-2", "order.placed", { num: 2 });

    // Reconnect with lastSequenceId = seq1
    const ws2 = new WebSocket(`${wsAddress}/ws?token=${accessToken}&lastSequenceId=${seq1}`);
    await waitForOpen(ws2);

    // Should receive welcome first
    const welcome2 = await waitForMessage(ws2);
    expect(welcome2.type).toBe("connected");

    // Then the replayed missed message (seq 2)
    const replayed = await waitForMessage(ws2);
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
    const ws2 = new WebSocket(`${wsAddress}/ws?token=${accessToken}&lastSequenceId=${lastSeq}`);
    await waitForOpen(ws2);

    // Should receive welcome
    const welcome2 = await waitForMessage(ws2);
    expect(welcome2.type).toBe("connected");

    // No more messages should arrive (nothing missed)
    const received = await Promise.race([
      waitForMessage(ws2, 500).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 600)),
    ]);
    expect(received).toBe(false);

    ws2.close();
  });

  it("buffers messages and they are available in the buffer", async () => {
    const bufferLengthBefore = wsManager.messageBuffer.length;

    // Publish a message — it should be buffered
    wsManager.publish("order", "buffer-test-1", "order.placed", { test: true });

    expect(wsManager.messageBuffer.length).toBeGreaterThan(bufferLengthBefore);

    const last = wsManager.messageBuffer[wsManager.messageBuffer.length - 1];
    expect(last?.message.entityId).toBe("buffer-test-1");
    expect(last?.channel).toBe("order:buffer-test-1");
    expect(last?.wildcardChannel).toBe("order:*");
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
    const seq1 = cartMsg.sequenceId;

    // Disconnect
    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Publish another cart event while disconnected
    wsManager.publish("cart", testCartId, "cart.updated", { items: 2 });

    // Reconnect with lastSequenceId
    const ws2 = new WebSocket(`${wsAddress}/ws?cart_token=${testCartToken}&lastSequenceId=${seq1}`);
    await waitForOpen(ws2);
    await waitForMessage(ws2); // welcome

    // Should receive the missed cart event
    const replayed = await waitForMessage(ws2);
    expect(replayed.type).toBe("cart.updated");
    expect(replayed.data?.items).toBe(2);
    expect(replayed.sequenceId).toBeGreaterThan(seq1);

    ws2.close();
  });
});
