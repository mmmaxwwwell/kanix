import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { eq, and, isNull } from "drizzle-orm";
import { createServer, markReady, markNotReady } from "../server.js";
import { createDatabaseConnection, type DatabaseConnection } from "../db/connection.js";
import type { Config } from "../config.js";
import type { FastifyInstance } from "fastify";
import { order } from "../db/schema/order.js";
import { customer } from "../db/schema/customer.js";

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

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("guest order → account linking (T036)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;

  const guestEmail = `guest-${Date.now()}@example.com`;
  const testPassword = "TestPassword123!";
  const guestOrderIds: string[] = [];

  beforeAll(async () => {
    superTokensAvailable = await isSuperTokensUp();
    if (!superTokensAvailable) return;

    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
    });
    address = await server.start();
    markReady();
    app = server.app;

    // Create 3 guest orders (no customer_id) with the same email
    for (let i = 1; i <= 3; i++) {
      const rows = await dbConn.db
        .insert(order)
        .values({
          orderNumber: `GUEST-${Date.now()}-${i}`,
          email: guestEmail,
          customerId: null,
          status: "placed",
          subtotalMinor: 1000 * i,
          totalMinor: 1000 * i,
        })
        .returning({ id: order.id });
      guestOrderIds.push(rows[0].id);
    }

    // Verify the guest orders have no customer_id
    const guestOrders = await dbConn.db
      .select({ id: order.id, customerId: order.customerId })
      .from(order)
      .where(and(eq(order.email, guestEmail), isNull(order.customerId)));
    expect(guestOrders.length).toBe(3);
  });

  afterAll(async () => {
    markNotReady();
    // Clean up test guest orders
    if (dbConn) {
      for (const id of guestOrderIds) {
        await dbConn.db.delete(order).where(eq(order.id, id));
      }
      // Clean up test customer record
      await dbConn.db.delete(customer).where(eq(customer.email, guestEmail));
    }
    if (app) await app.close();
    if (dbConn) await dbConn.close();
  });

  it("on email verification, guest orders are linked to the new customer", async function () {
    if (!superTokensAvailable) return;

    // Step 1: Sign up with the same email as the guest orders
    const signupRes = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: guestEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });
    expect(signupRes.status).toBe(200);
    const signupBody = (await signupRes.json()) as { status: string; user: { id: string } };
    expect(signupBody.status).toBe("OK");
    const userId = signupBody.user.id;

    // At this point, orders should still have no customer_id (email not verified yet)
    const unlinkedOrders = await dbConn.db
      .select({ id: order.id, customerId: order.customerId })
      .from(order)
      .where(and(eq(order.email, guestEmail), isNull(order.customerId)));
    expect(unlinkedOrders.length).toBe(3);

    // Step 2: Verify email (triggers order linking)
    const { default: supertokens } = await import("supertokens-node");
    const { default: EmailVerification } =
      await import("supertokens-node/recipe/emailverification/index.js");
    const tokenRes = await EmailVerification.createEmailVerificationToken(
      "public",
      supertokens.convertToRecipeUserId(userId),
    );
    expect(tokenRes.status).toBe("OK");

    if (tokenRes.status === "OK") {
      // Use the HTTP API to verify email so the override fires
      const verifyRes = await fetch(`${address}/auth/user/email/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          method: "token",
          token: tokenRes.token,
        }),
      });
      expect(verifyRes.status).toBe(200);
      const verifyBody = (await verifyRes.json()) as { status: string };
      expect(verifyBody.status).toBe("OK");
    }

    // Step 3: Verify the orders now have customer_id set
    const linkedOrders = await dbConn.db
      .select({ id: order.id, customerId: order.customerId })
      .from(order)
      .where(eq(order.email, guestEmail));
    expect(linkedOrders.length).toBe(3);
    for (const o of linkedOrders) {
      expect(o.customerId).not.toBeNull();
    }

    // All orders should have the same customer_id
    const customerIds = new Set(linkedOrders.map((o) => o.customerId));
    expect(customerIds.size).toBe(1);

    // Step 4: Sign in and verify orders appear in customer's order list
    const signinRes = await fetch(`${address}/auth/signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: guestEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });
    expect(signinRes.status).toBe(200);

    const cookies = signinRes.headers.getSetCookie();
    const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
    const accessToken = signinRes.headers.get("st-access-token");
    const antiCsrf = signinRes.headers.get("anti-csrf");

    const headers: Record<string, string> = {
      origin: "http://localhost:3000",
      cookie: cookieHeader,
    };
    if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
    if (antiCsrf) headers["anti-csrf"] = antiCsrf;

    const ordersRes = await fetch(`${address}/api/customer/orders`, { headers });
    expect(ordersRes.status).toBe(200);
    const ordersBody = (await ordersRes.json()) as {
      orders: { id: string; orderNumber: string; email: string }[];
    };
    expect(ordersBody.orders.length).toBe(3);
    for (const o of ordersBody.orders) {
      expect(o.email).toBe(guestEmail);
      expect(guestOrderIds).toContain(o.id);
    }
  });
});
