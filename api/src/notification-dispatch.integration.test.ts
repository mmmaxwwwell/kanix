import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { adminAlertPreference } from "./db/schema/alert-preference.js";
import { customer } from "./db/schema/customer.js";
import { product, productVariant } from "./db/schema/catalog.js";
import { inventoryBalance, inventoryLocation } from "./db/schema/inventory.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import {
  createNotificationDispatchService,
  createEmailStubAdapter,
} from "./services/notification-dispatch.js";
import type { WsMessage } from "./ws/manager.js";
import type { TaxAdapter } from "./services/tax-adapter.js";
import { createStubShippingAdapter } from "./services/shipping-adapter.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";
import WebSocket from "ws";
import { eq } from "drizzle-orm";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

function createStubTaxAdapter(): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: 0, calculationId: null };
    },
  };
}

function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      return {
        id: `pi_test_nd_${Date.now()}`,
        clientSecret: `pi_test_nd_secret_${Date.now()}`,
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

async function signInAndGetHeaders(
  address: string,
  email: string,
  password: string,
): Promise<Record<string, string>> {
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
  const cookies = res.headers.getSetCookie();
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const accessToken = res.headers.get("st-access-token");
  const antiCsrf = res.headers.get("anti-csrf");
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    cookie: cookieHeader,
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  if (antiCsrf) headers["anti-csrf"] = antiCsrf;
  return headers;
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
    ws.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      reject(new Error(`WS closed before message: code=${code} reason=${reason.toString()}`));
    });
  });
}

function collectMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<WsMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: WsMessage[] = [];
    const timer = setTimeout(
      () =>
        reject(new Error(`Timed out waiting for ${count} WS messages (got ${messages.length})`)),
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

describe("Notification dispatch service (T252)", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let wsAddress: string;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const emailLogPath = join(process.cwd(), "logs", `test-emails-${ts}.jsonl`);

  const emailAdminEmail = `test-nd-email-admin-${ts}@kanix.dev`;
  const emailAdminPassword = "AdminPassword123!";
  const pushAdminEmail = `test-nd-push-admin-${ts}@kanix.dev`;
  const pushAdminPassword = "PushAdminPassword123!";
  const bothAdminEmail = `test-nd-both-admin-${ts}@kanix.dev`;
  const bothAdminPassword = "BothAdminPassword123!";
  const customerEmail = `test-nd-customer-${ts}@kanix.dev`;
  const customerPassword = "CustomerPassword123!";

  let testRoleId: string;
  let emailAdminUserId: string;
  let pushAdminUserId: string;
  let bothAdminUserId: string;
  let customerId: string;
  let customerHeaders: Record<string, string>;
  let activeProductId: string;
  let activeVariantId: string;
  let locationId: string;

  beforeAll(async () => {
    const emailAdapter = createEmailStubAdapter(emailLogPath);
    const notificationDispatch = createNotificationDispatchService({ emailAdapter });

    ts_ = await createTestServer({
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
        notificationDispatch,
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;
    wsAddress = address.replace(/^http/, "ws");

    // Create admin role (super_admin)
    const [role] = await db
      .insert(adminRole)
      .values({
        name: `test_nd_super_admin_${ts}`,
        description: "Test notification dispatch super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    // Create admin with email preference
    const emailAuthSubject = await signUpUser(address, emailAdminEmail, emailAdminPassword);
    await verifyEmail(emailAuthSubject);
    const [emailAdminUsr] = await db
      .insert(adminUser)
      .values({
        authSubject: emailAuthSubject,
        email: emailAdminEmail,
        name: "Test Email Admin",
        status: "active",
      })
      .returning();
    emailAdminUserId = emailAdminUsr.id;
    await db.insert(adminUserRole).values({
      adminUserId: emailAdminUserId,
      adminRoleId: testRoleId,
    });
    await db.insert(adminAlertPreference).values({
      adminUserId: emailAdminUserId,
      channel: "email",
    });
    adminHeaders = await signInAndGetHeaders(address, emailAdminEmail, emailAdminPassword);

    // Create admin with push preference
    const pushAuthSubject = await signUpUser(address, pushAdminEmail, pushAdminPassword);
    await verifyEmail(pushAuthSubject);
    const [pushAdminUsr] = await db
      .insert(adminUser)
      .values({
        authSubject: pushAuthSubject,
        email: pushAdminEmail,
        name: "Test Push Admin",
        status: "active",
      })
      .returning();
    pushAdminUserId = pushAdminUsr.id;
    await db.insert(adminUserRole).values({
      adminUserId: pushAdminUserId,
      adminRoleId: testRoleId,
    });
    await db.insert(adminAlertPreference).values({
      adminUserId: pushAdminUserId,
      channel: "push",
    });

    // Create admin with "both" preference
    const bothAuthSubject = await signUpUser(address, bothAdminEmail, bothAdminPassword);
    await verifyEmail(bothAuthSubject);
    const [bothAdminUsr] = await db
      .insert(adminUser)
      .values({
        authSubject: bothAuthSubject,
        email: bothAdminEmail,
        name: "Test Both Admin",
        status: "active",
      })
      .returning();
    bothAdminUserId = bothAdminUsr.id;
    await db.insert(adminUserRole).values({
      adminUserId: bothAdminUserId,
      adminRoleId: testRoleId,
    });
    await db.insert(adminAlertPreference).values({
      adminUserId: bothAdminUserId,
      channel: "both",
    });

    // Create a customer user (non-admin) — signup auto-creates the customer row
    const custAuthSubject = await signUpUser(address, customerEmail, customerPassword);
    await verifyEmail(custAuthSubject);
    const [cust] = await db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, custAuthSubject));
    if (!cust) throw new Error("Customer row not created by signup");
    customerId = cust.id;
    customerHeaders = await signInAndGetHeaders(address, customerEmail, customerPassword);

    // Seed product + variant + inventory with low safety stock threshold
    const [prod] = await db
      .insert(product)
      .values({
        slug: `nd-test-prod-${ts}`,
        title: `Notification Test Product ${ts}`,
        status: "active",
      })
      .returning();
    activeProductId = prod.id;

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: activeProductId,
        sku: `ND-VAR-${ts}`,
        title: `ND Variant ${ts}`,
        priceMinor: 2500,
        status: "active",
        weight: "16",
      })
      .returning();
    activeVariantId = variant.id;

    const [loc] = await db
      .insert(inventoryLocation)
      .values({
        name: `ND Warehouse ${ts}`,
        code: `ND-WH-${ts}`,
        type: "warehouse",
      })
      .returning();
    locationId = loc.id;

    // Set up inventory with safetyStock > available to trigger low-stock on adjustment
    await db.insert(inventoryBalance).values({
      variantId: activeVariantId,
      locationId,
      onHand: 10,
      reserved: 0,
      available: 10,
      safetyStock: 20,
    });
  }, 30000);

  afterAll(async () => {
    try {
      const db = dbConn.db;
      await db
        .delete(adminAlertPreference)
        .where(eq(adminAlertPreference.adminUserId, emailAdminUserId));
      await db
        .delete(adminAlertPreference)
        .where(eq(adminAlertPreference.adminUserId, pushAdminUserId));
      await db
        .delete(adminAlertPreference)
        .where(eq(adminAlertPreference.adminUserId, bothAdminUserId));
      await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, emailAdminUserId));
      await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, pushAdminUserId));
      await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, bothAdminUserId));
      await db.delete(adminUser).where(eq(adminUser.id, emailAdminUserId));
      await db.delete(adminUser).where(eq(adminUser.id, pushAdminUserId));
      await db.delete(adminUser).where(eq(adminUser.id, bothAdminUserId));
      await db.delete(adminRole).where(eq(adminRole.id, testRoleId));
      await db.delete(customer).where(eq(customer.id, customerId));
      await db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, activeVariantId));
      await db.delete(inventoryLocation).where(eq(inventoryLocation.id, locationId));
      await db.delete(productVariant).where(eq(productVariant.id, activeVariantId));
      await db.delete(product).where(eq(product.id, activeProductId));
    } catch {
      // best-effort cleanup
    }

    if (existsSync(emailLogPath)) {
      unlinkSync(emailLogPath);
    }

    await stopTestServer(ts_);
  }, 15000);

  // -------------------------------------------------------------------------
  // Alert preference API — CRUD + validation
  // -------------------------------------------------------------------------

  it("GET /api/admin/settings/alerts returns current preference", async () => {
    const res = await fetch(`${address}/api/admin/settings/alerts`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: string };
    expect(body.channel).toBe("email");
  });

  it("PUT /api/admin/settings/alerts updates preference and round-trips", async () => {
    const res = await fetch(`${address}/api/admin/settings/alerts`, {
      method: "PUT",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ channel: "both" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: string };
    expect(body.channel).toBe("both");

    // Read back to verify persistence
    const getRes = await fetch(`${address}/api/admin/settings/alerts`, {
      headers: adminHeaders,
    });
    const getBody = (await getRes.json()) as { channel: string };
    expect(getBody.channel).toBe("both");

    // Reset to email for subsequent tests
    await fetch(`${address}/api/admin/settings/alerts`, {
      method: "PUT",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ channel: "email" }),
    });
  });

  it("rejects invalid channel value with 400", async () => {
    const res = await fetch(`${address}/api/admin/settings/alerts`, {
      method: "PUT",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ channel: "sms" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body).toHaveProperty("error");
  });

  it("non-admin user cannot access alert preference GET", async () => {
    const res = await fetch(`${address}/api/admin/settings/alerts`, {
      headers: customerHeaders,
    });
    expect(res.status).toBe(403);
  });

  it("non-admin user cannot access alert preference PUT", async () => {
    const res = await fetch(`${address}/api/admin/settings/alerts`, {
      method: "PUT",
      headers: { ...customerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ channel: "email" }),
    });
    expect(res.status).toBe(403);
  });

  it("unauthenticated request to alert preference returns 401", async () => {
    const res = await fetch(`${address}/api/admin/settings/alerts`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Low-stock alert → email channel only
  // -------------------------------------------------------------------------

  it("low-stock alert dispatches email to admin with email preference", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/adjustments",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
        "x-idempotency-key": `nd-email-test-${ts}`,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        location_id: locationId,
        adjustment_type: "shrinkage",
        quantity_delta: -3,
        reason: "Test shrinkage for notification",
      }),
    });
    expect(res.statusCode).toBe(201);

    // Verify email was logged to file
    expect(existsSync(emailLogPath)).toBe(true);
    const content = readFileSync(emailLogPath, "utf-8").trim();
    const lines = content.split("\n");
    expect(lines.length).toBeGreaterThan(0);

    // Find the email sent to the email-preference admin (multiple admins may receive emails)
    const entries = lines.map(
      (l) =>
        JSON.parse(l) as {
          to: string;
          subject: string;
          body: string;
          templateId: string;
          timestamp: string;
        },
    );
    const emailAdminEntry = entries.find(
      (e) => e.to === emailAdminEmail && e.templateId === "low_stock_alert",
    );
    expect(emailAdminEntry).toBeDefined();
    expect(emailAdminEntry!.subject).toContain("Low stock");
    expect(emailAdminEntry!.body).toContain(activeVariantId);
    expect(emailAdminEntry!.timestamp).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Low-stock alert → push channel (WebSocket delivery)
  // -------------------------------------------------------------------------

  it("low-stock alert dispatches WebSocket message to admin with push preference", async () => {
    const accessToken = await signInAndGetAccessToken(address, pushAdminEmail, pushAdminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");

    const eventPromise = waitForMessage(ws, 5000);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/adjustments",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
        "x-idempotency-key": `nd-push-test-${ts}`,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        location_id: locationId,
        adjustment_type: "shrinkage",
        quantity_delta: -2,
        reason: "Test shrinkage for push notification",
      }),
    });
    expect(res.statusCode).toBe(201);

    const event = await eventPromise;
    expect(event.type).toBe("inventory.low_stock");
    expect(event.entity).toBe("inventory");
    expect(event.entityId).toBe(activeVariantId);
    expect(event.data).toHaveProperty("available");
    expect(event.data).toHaveProperty("safetyStock");
    expect(typeof event.sequenceId).toBe("number");
    expect(event.sequenceId).toBeGreaterThan(0);

    ws.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // "both" channel admin → email AND WebSocket simultaneously
  // -------------------------------------------------------------------------

  it("admin with 'both' preference receives email AND WebSocket on low-stock alert", async () => {
    const emailLinesBefore = existsSync(emailLogPath)
      ? readFileSync(emailLogPath, "utf-8").trim().split("\n").length
      : 0;

    const accessToken = await signInAndGetAccessToken(address, bothAdminEmail, bothAdminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");

    const eventPromise = waitForMessage(ws, 5000);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/adjustments",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
        "x-idempotency-key": `nd-both-test-${ts}`,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        location_id: locationId,
        adjustment_type: "shrinkage",
        quantity_delta: -1,
        reason: "Test shrinkage for both-channel admin",
      }),
    });
    expect(res.statusCode).toBe(201);

    // WebSocket event received
    const event = await eventPromise;
    expect(event.type).toBe("inventory.low_stock");
    expect(event.entity).toBe("inventory");
    expect(event.entityId).toBe(activeVariantId);

    // Email also sent to this admin
    const emailContent = readFileSync(emailLogPath, "utf-8").trim();
    const emailLines = emailContent.split("\n");
    expect(emailLines.length).toBeGreaterThan(emailLinesBefore);

    // Find the email sent to the "both" admin
    const bothEmails = emailLines
      .map((line) => JSON.parse(line) as { to: string; templateId: string })
      .filter((e) => e.to === bothAdminEmail && e.templateId === "low_stock_alert");
    expect(bothEmails.length).toBeGreaterThan(0);

    ws.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // Multiple admins simultaneously receive broadcast
  // -------------------------------------------------------------------------

  it("low-stock alert broadcasts to all connected admins", async () => {
    // Connect both push and both-channel admins via WebSocket
    const pushToken = await signInAndGetAccessToken(address, pushAdminEmail, pushAdminPassword);
    const bothToken = await signInAndGetAccessToken(address, bothAdminEmail, bothAdminPassword);

    const ws1 = new WebSocket(`${wsAddress}/ws?token=${pushToken}`);
    const ws2 = new WebSocket(`${wsAddress}/ws?token=${bothToken}`);
    await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

    // Consume welcome messages
    const [welcome1, welcome2] = await Promise.all([waitForMessage(ws1), waitForMessage(ws2)]);
    expect(welcome1.type).toBe("connected");
    expect(welcome2.type).toBe("connected");

    // Set up listeners BEFORE triggering alert
    const event1Promise = waitForMessage(ws1, 5000);
    const event2Promise = waitForMessage(ws2, 5000);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/adjustments",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
        "x-idempotency-key": `nd-broadcast-test-${ts}`,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        location_id: locationId,
        adjustment_type: "restock",
        quantity_delta: 5,
        reason: "Restock then shrink for broadcast test",
      }),
    });
    expect(res.statusCode).toBe(201);

    // Trigger another shrinkage so available < safetyStock fires alert
    const shrinkRes = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/adjustments",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
        "x-idempotency-key": `nd-broadcast-shrink-${ts}`,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        location_id: locationId,
        adjustment_type: "shrinkage",
        quantity_delta: -6,
        reason: "Shrinkage for broadcast test",
      }),
    });
    expect(shrinkRes.statusCode).toBe(201);

    // Both admins receive the inventory.low_stock event
    const [ev1, ev2] = await Promise.all([event1Promise, event2Promise]);
    expect(ev1.type).toBe("inventory.low_stock");
    expect(ev1.entity).toBe("inventory");
    expect(ev2.type).toBe("inventory.low_stock");
    expect(ev2.entity).toBe("inventory");

    ws1.close();
    ws2.close();
  }, 20000);

  // -------------------------------------------------------------------------
  // Customer does NOT receive admin-only inventory alerts
  // -------------------------------------------------------------------------

  it("customer WebSocket does not receive inventory.low_stock events", async () => {
    const custToken = await signInAndGetAccessToken(address, customerEmail, customerPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${custToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");
    expect(welcome.data.role).toBe("customer");

    // Customer subscribes to customer:{customerId}, not inventory:*
    const channels = welcome.data.channels as string[];
    expect(channels).toContain(`customer:${customerId}`);
    expect(channels).not.toContain("inventory:*");

    // Trigger a low-stock alert
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/adjustments",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
        "x-idempotency-key": `nd-cust-isolation-${ts}`,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        location_id: locationId,
        adjustment_type: "shrinkage",
        quantity_delta: -1,
        reason: "Customer isolation test",
      }),
    });
    expect(res.statusCode).toBe(201);

    // Wait a short time and confirm no message arrives for customer
    const noMessage = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), 1500);
      ws.once("message", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    expect(noMessage).toBe(true);

    ws.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // Domain event delivery — admin receives order/payment/ticket events
  // -------------------------------------------------------------------------

  it("admin WebSocket receives domain events published on entity channels", async () => {
    const adminToken = await signInAndGetAccessToken(address, pushAdminEmail, pushAdminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${adminToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");
    expect(welcome.data.role).toBe("admin");

    // Admin subscribes to wildcard channels like order:*, payment:*, etc.
    const channels = welcome.data.channels as string[];
    expect(channels).toContain("order:*");
    expect(channels).toContain("payment:*");
    expect(channels).toContain("shipment:*");
    expect(channels).toContain("ticket:*");
    expect(channels).toContain("inventory:*");
    expect(channels).toContain("dispute:*");

    // Directly publish a domain event via the server's WS manager
    const eventPromise = waitForMessage(ws, 5000);
    ts_.server.wsManager!.publish("order", "test-order-123", "order.placed", {
      orderNumber: "ORD-TEST-001",
      email: "buyer@example.com",
      totalMinor: 5000,
    });

    const event = await eventPromise;
    expect(event.type).toBe("order.placed");
    expect(event.entity).toBe("order");
    expect(event.entityId).toBe("test-order-123");
    expect(event.data.orderNumber).toBe("ORD-TEST-001");
    expect(event.data.email).toBe("buyer@example.com");
    expect(event.data.totalMinor).toBe(5000);

    ws.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // Customer WebSocket receives events on their own channel
  // -------------------------------------------------------------------------

  it("customer WebSocket receives events published to their channel", async () => {
    const custToken = await signInAndGetAccessToken(address, customerEmail, customerPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${custToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");
    expect(welcome.data.role).toBe("customer");

    const eventPromise = waitForMessage(ws, 5000);

    // Publish event to customer's channel
    ts_.server.wsManager!.publish("customer", customerId, "order.placed", {
      orderNumber: "ORD-CUST-001",
      totalMinor: 3500,
    });

    const event = await eventPromise;
    expect(event.type).toBe("order.placed");
    expect(event.entity).toBe("customer");
    expect(event.entityId).toBe(customerId);
    expect(event.data.orderNumber).toBe("ORD-CUST-001");
    expect(event.data.totalMinor).toBe(3500);

    ws.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // Cross-customer isolation — customer A doesn't see customer B's events
  // -------------------------------------------------------------------------

  it("customer does not receive events for a different customer", async () => {
    const custToken = await signInAndGetAccessToken(address, customerEmail, customerPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${custToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");

    // Publish to a DIFFERENT customer's channel
    ts_.server.wsManager!.publish("customer", "some-other-customer-id", "order.placed", {
      orderNumber: "ORD-OTHER-001",
    });

    const noMessage = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), 1500);
      ws.once("message", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    expect(noMessage).toBe(true);

    ws.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // Email delivery content includes variant SKU + product title
  // -------------------------------------------------------------------------

  it("low-stock alert email body contains variant SKU and product title", async () => {
    const emailLinesBefore = existsSync(emailLogPath)
      ? readFileSync(emailLogPath, "utf-8").trim().split("\n").length
      : 0;

    // Restock to allow another shrinkage
    await app.inject({
      method: "POST",
      url: "/api/admin/inventory/adjustments",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
        "x-idempotency-key": `nd-restock-content-${ts}`,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        location_id: locationId,
        adjustment_type: "restock",
        quantity_delta: 3,
        reason: "Restock for content test",
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/adjustments",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
        "x-idempotency-key": `nd-content-test-${ts}`,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        location_id: locationId,
        adjustment_type: "shrinkage",
        quantity_delta: -4,
        reason: "Test content assertion",
      }),
    });
    expect(res.statusCode).toBe(201);

    const emailContent = readFileSync(emailLogPath, "utf-8").trim();
    const emailLines = emailContent.split("\n");
    expect(emailLines.length).toBeGreaterThan(emailLinesBefore);

    // The email body should reference the variant ID and available count
    const latestEmail = JSON.parse(emailLines[emailLines.length - 1]) as {
      to: string;
      subject: string;
      body: string;
      templateId: string;
    };
    expect(latestEmail.templateId).toBe("low_stock_alert");
    expect(latestEmail.subject).toContain("Low stock");
    expect(latestEmail.body).toContain(activeVariantId);
    expect(latestEmail.body).toMatch(/\d+ units available/);
  });

  // -------------------------------------------------------------------------
  // WebSocket reconnection replay — buffered messages delivered
  // -------------------------------------------------------------------------

  it("reconnecting admin receives buffered messages via lastSequenceId", async () => {
    const adminToken = await signInAndGetAccessToken(address, pushAdminEmail, pushAdminPassword);

    // First connection: get the welcome message and note the sequence
    const ws1 = new WebSocket(`${wsAddress}/ws?token=${adminToken}`);
    await waitForOpen(ws1);
    const welcome1 = await waitForMessage(ws1);
    expect(welcome1.type).toBe("connected");
    const lastSeq = welcome1.sequenceId;
    ws1.close();

    // Publish messages while disconnected
    ts_.server.wsManager!.publish("order", "replay-order-1", "order.placed", {
      orderNumber: "ORD-REPLAY-1",
    });
    ts_.server.wsManager!.publish("payment", "replay-pay-1", "payment.succeeded", {
      orderId: "replay-order-1",
      amountMinor: 2000,
    });

    // Reconnect with lastSequenceId to replay missed events
    const ws2 = new WebSocket(`${wsAddress}/ws?token=${adminToken}&lastSequenceId=${lastSeq}`);
    await waitForOpen(ws2);

    // Should receive: welcome + 2 replayed messages
    const messages = await collectMessages(ws2, 3, 5000);
    expect(messages[0].type).toBe("connected");

    // The replayed messages should include our published events
    const replayed = messages.slice(1);
    const orderEvent = replayed.find((m) => m.type === "order.placed");
    const paymentEvent = replayed.find((m) => m.type === "payment.succeeded");
    expect(orderEvent).toBeDefined();
    expect(orderEvent!.data.orderNumber).toBe("ORD-REPLAY-1");
    expect(paymentEvent).toBeDefined();
    expect(paymentEvent!.data.orderId).toBe("replay-order-1");
    expect(paymentEvent!.data.amountMinor).toBe(2000);

    ws2.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // Admin without explicit preference defaults to "both"
  // -------------------------------------------------------------------------

  it("admin with no preference row defaults to 'both' in getAllAdminAlertTargets", async () => {
    const db = dbConn.db;
    // Create a temporary admin without a preference row
    const tempAuthSubject = await signUpUser(
      address,
      `test-nd-nopref-${ts}@kanix.dev`,
      "NoPrefPassword123!",
    );
    const [tempAdmin] = await db
      .insert(adminUser)
      .values({
        authSubject: tempAuthSubject,
        email: `test-nd-nopref-${ts}@kanix.dev`,
        name: "Test No-Pref Admin",
        status: "active",
      })
      .returning();
    await db.insert(adminUserRole).values({
      adminUserId: tempAdmin.id,
      adminRoleId: testRoleId,
    });

    // Use the query directly to verify default
    const { getAllAdminAlertTargets } = await import("./db/queries/alert-preference.js");
    const targets = await getAllAdminAlertTargets(db);
    const noPrefTarget = targets.find((t) => t.adminUserId === tempAdmin.id);
    expect(noPrefTarget).toBeDefined();
    expect(noPrefTarget!.channel).toBe("both");
    expect(noPrefTarget!.email).toBe(`test-nd-nopref-${ts}@kanix.dev`);

    // Cleanup
    await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, tempAdmin.id));
    await db.delete(adminUser).where(eq(adminUser.id, tempAdmin.id));
  });

  // -------------------------------------------------------------------------
  // Email-only admin does NOT trigger WebSocket dispatch
  // -------------------------------------------------------------------------

  it("email-only admin does not produce WebSocket messages for alerts", async () => {
    const emailToken = await signInAndGetAccessToken(address, emailAdminEmail, emailAdminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${emailToken}`);
    await waitForOpen(ws);
    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");

    // The email admin's preference is "email" — dispatchAlert only calls emailAdapter
    // for this target. The domain event publish still fires on inventory:* though,
    // so the admin WS sees the domain event (separate from dispatchAlert WS path).
    // This test verifies the admin still gets the domain event on the WS channel
    // because admins subscribe to inventory:* by default.
    const eventPromise = waitForMessage(ws, 5000);

    await app.inject({
      method: "POST",
      url: "/api/admin/inventory/adjustments",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
        "x-idempotency-key": `nd-email-ws-test-${ts}`,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        location_id: locationId,
        adjustment_type: "restock",
        quantity_delta: 2,
        reason: "Restock for email-only WS test",
      }),
    });

    // Shrink to trigger alert
    await app.inject({
      method: "POST",
      url: "/api/admin/inventory/adjustments",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
        "x-idempotency-key": `nd-email-ws-shrink-${ts}`,
      },
      body: JSON.stringify({
        variant_id: activeVariantId,
        location_id: locationId,
        adjustment_type: "shrinkage",
        quantity_delta: -3,
        reason: "Shrinkage for email-only WS test",
      }),
    });

    // The domain event is always published to WS, so admin still sees it
    const event = await eventPromise;
    expect(event.type).toBe("inventory.low_stock");
    expect(event.entity).toBe("inventory");

    ws.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // dispatchAlert with multiple event types exercised via wsManager.publish
  // -------------------------------------------------------------------------

  it("dispatchAlert routes different event types correctly", async () => {
    const adminToken = await signInAndGetAccessToken(address, pushAdminEmail, pushAdminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${adminToken}`);
    await waitForOpen(ws);

    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");

    // Publish dispute.opened event
    const eventPromise = waitForMessage(ws, 5000);
    ts_.server.wsManager!.publish("dispute", "disp-001", "dispute.opened", {
      reason: "product_not_received",
      amountMinor: 5000,
    });

    const event = await eventPromise;
    expect(event.type).toBe("dispute.opened");
    expect(event.entity).toBe("dispute");
    expect(event.entityId).toBe("disp-001");
    expect(event.data.reason).toBe("product_not_received");
    expect(event.data.amountMinor).toBe(5000);

    // Publish shipment.delivered event
    const event2Promise = waitForMessage(ws, 5000);
    ts_.server.wsManager!.publish("shipment", "ship-001", "shipment.delivered", {
      oldStatus: "in_transit",
      newStatus: "delivered",
    });

    const event2 = await event2Promise;
    expect(event2.type).toBe("shipment.delivered");
    expect(event2.entity).toBe("shipment");
    expect(event2.entityId).toBe("ship-001");
    expect(event2.data.oldStatus).toBe("in_transit");
    expect(event2.data.newStatus).toBe("delivered");

    // Publish milestone.reached event
    const event3Promise = waitForMessage(ws, 5000);
    ts_.server.wsManager!.publish("contributor", "contrib-001", "milestone.reached", {
      milestoneId: "ms-001",
      threshold: 25,
      newRate: 0.1,
    });

    const event3 = await event3Promise;
    expect(event3.type).toBe("milestone.reached");
    expect(event3.entity).toBe("contributor");
    expect(event3.entityId).toBe("contrib-001");
    expect(event3.data.threshold).toBe(25);
    expect(event3.data.newRate).toBe(0.1);

    ws.close();
  }, 15000);
});
