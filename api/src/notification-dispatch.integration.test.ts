import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { adminAlertPreference } from "./db/schema/alert-preference.js";
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

describeWithDeps("Notification dispatch service (T075)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let wsAddress: string;
  let superTokensAvailable = false;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const emailLogPath = join(process.cwd(), "logs", `test-emails-${ts}.jsonl`);

  const emailAdminEmail = `test-nd-email-admin-${ts}@kanix.dev`;
  const emailAdminPassword = "AdminPassword123!";
  const pushAdminEmail = `test-nd-push-admin-${ts}@kanix.dev`;
  const pushAdminPassword = "PushAdminPassword123!";

  let testRoleId: string;
  let emailAdminUserId: string;
  let pushAdminUserId: string;
  let activeProductId: string;
  let activeVariantId: string;
  let locationId: string;

  beforeAll(async () => {
    superTokensAvailable = await isSuperTokensUp();
    if (!superTokensAvailable) return;

    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

    // Create notification dispatch with test email log path
    const emailAdapter = createEmailStubAdapter(emailLogPath);
    const notificationDispatch = createNotificationDispatchService({ emailAdapter });

    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      reservationCleanupIntervalMs: 0,
      taxAdapter: createStubTaxAdapter(),
      shippingAdapter: createStubShippingAdapter(),
      paymentAdapter: createStubPaymentAdapter(),
      notificationDispatch,
    });
    address = await server.start();
    markReady();
    app = server.app;
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
    if (!superTokensAvailable) return;
    markNotReady();

    try {
      const db = dbConn.db;
      await db
        .delete(adminAlertPreference)
        .where(eq(adminAlertPreference.adminUserId, emailAdminUserId));
      await db
        .delete(adminAlertPreference)
        .where(eq(adminAlertPreference.adminUserId, pushAdminUserId));
      await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, emailAdminUserId));
      await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, pushAdminUserId));
      await db.delete(adminUser).where(eq(adminUser.id, emailAdminUserId));
      await db.delete(adminUser).where(eq(adminUser.id, pushAdminUserId));
      await db.delete(adminRole).where(eq(adminRole.id, testRoleId));
      await db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, activeVariantId));
      await db.delete(inventoryLocation).where(eq(inventoryLocation.id, locationId));
      await db.delete(productVariant).where(eq(productVariant.id, activeVariantId));
      await db.delete(product).where(eq(product.id, activeProductId));
    } catch {
      // best-effort cleanup
    }

    // Clean up test email log
    if (existsSync(emailLogPath)) {
      unlinkSync(emailLogPath);
    }

    await app.close();
    await dbConn.close();
  }, 15000);

  // -------------------------------------------------------------------------
  // Alert preference API tests
  // -------------------------------------------------------------------------

  it("GET /api/admin/settings/alerts returns current preference", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/settings/alerts`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: string };
    expect(body.channel).toBe("email");
  });

  it("PUT /api/admin/settings/alerts updates preference", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/settings/alerts`, {
      method: "PUT",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ channel: "both" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: string };
    expect(body.channel).toBe("both");

    // Read back
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

  it("rejects invalid channel value", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/admin/settings/alerts`, {
      method: "PUT",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ channel: "sms" }),
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Low-stock alert → email admin → email logged to file
  // -------------------------------------------------------------------------

  it("low-stock alert dispatches email to admin with email preference", async () => {
    if (!superTokensAvailable) return;

    // Trigger a low-stock alert via inventory adjustment (shrinkage reduces available)
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

    const lastEntry = JSON.parse(lines[lines.length - 1]) as {
      to: string;
      subject: string;
      templateId: string;
    };
    expect(lastEntry.to).toBe(emailAdminEmail);
    expect(lastEntry.subject).toContain("Low stock");
    expect(lastEntry.templateId).toBe("low_stock_alert");
  });

  // -------------------------------------------------------------------------
  // Low-stock alert → push admin → WebSocket message received
  // -------------------------------------------------------------------------

  it("low-stock alert dispatches WebSocket message to admin with push preference", async () => {
    if (!superTokensAvailable) return;

    // Connect push admin to WebSocket
    const accessToken = await signInAndGetAccessToken(address, pushAdminEmail, pushAdminPassword);
    const ws = new WebSocket(`${wsAddress}/ws?token=${accessToken}`);
    await waitForOpen(ws);

    // Consume welcome message
    const welcome = await waitForMessage(ws);
    expect(welcome.type).toBe("connected");

    // Set up listener BEFORE triggering the alert
    const eventPromise = waitForMessage(ws, 5000);

    // Trigger another low-stock alert
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

    // Admin with push preference should receive the event via WebSocket
    // The notification dispatch sends to entity:entityId which admin gets via wildcard
    const event = await eventPromise;
    expect(event.type).toBe("inventory.low_stock");
    expect(event.entity).toBe("inventory");
    expect(event.entityId).toBe(activeVariantId);

    ws.close();
  }, 15000);
});
