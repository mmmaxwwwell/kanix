import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "../server.js";
import { createDatabaseConnection, type DatabaseConnection } from "../db/connection.js";
import type { Config } from "../config.js";
import type { FastifyInstance } from "fastify";

const DATABASE_URL = process.env["DATABASE_URL"];
const SUPERTOKENS_URI = process.env["SUPERTOKENS_CONNECTION_URI"] ?? "http://localhost:3567";

/**
 * Check if SuperTokens is reachable before running integration tests.
 */
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

// Skip when dependencies are unavailable
const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("customer auth: email/password + email verification (T032)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;

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
  });

  afterAll(async () => {
    markNotReady();
    if (app) await app.close();
    if (dbConn) await dbConn.close();
  });

  // Unique email per test run to avoid conflicts
  const testEmail = `test-${Date.now()}@example.com`;
  const testPassword = "TestPassword123!";

  it("signup creates user and customer record", async function () {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: testEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; user?: { id: string; emails: string[] } };
    expect(body.status).toBe("OK");
    expect(body.user).toBeDefined();
    expect(body.user?.emails).toContain(testEmail);
  });

  it("unverified user gets 401 on protected endpoint (no session without login)", async function () {
    if (!superTokensAvailable) return;

    // Access protected endpoint without session → 401
    const res = await fetch(`${address}/api/customer/me`, {
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
  });

  it("login returns session tokens", async function () {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/auth/signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: testEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; user?: { id: string } };
    expect(body.status).toBe("OK");

    // Session tokens should be set in response headers (cookies or tokens)
    const setCookieHeaders = res.headers.getSetCookie();
    const hasSessionTokens =
      setCookieHeaders.some((c) => c.includes("sAccessToken")) ||
      res.headers.has("st-access-token");
    expect(hasSessionTokens).toBe(true);
  });

  it("logged-in but unverified user gets 403 on protected endpoint", async function () {
    if (!superTokensAvailable) return;

    // First, sign in to get session tokens
    const signinRes = await fetch(`${address}/auth/signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: testEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });
    expect(signinRes.status).toBe(200);

    // Extract session tokens from response
    const cookies = signinRes.headers.getSetCookie();
    const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");

    // Also check for header-based tokens
    const accessToken = signinRes.headers.get("st-access-token");
    const antiCsrf = signinRes.headers.get("anti-csrf");

    // Access protected endpoint with session but unverified email → 403
    const headers: Record<string, string> = {
      origin: "http://localhost:3000",
      cookie: cookieHeader,
    };
    if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
    if (antiCsrf) headers["anti-csrf"] = antiCsrf;

    const meRes = await fetch(`${address}/api/customer/me`, { headers });

    expect(meRes.status).toBe(403);
    const body = (await meRes.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_EMAIL_NOT_VERIFIED");
    expect(body.message).toContain("Email verification required");
  });

  it("verified user can access protected endpoint", async function () {
    if (!superTokensAvailable) return;

    // Sign in
    const signinRes = await fetch(`${address}/auth/signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: testEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });
    expect(signinRes.status).toBe(200);
    const signinBody = (await signinRes.json()) as { status: string; user: { id: string } };
    const userId = signinBody.user.id;

    // Manually verify the email via SuperTokens API (simulating email verification)
    const { default: supertokens } = await import("supertokens-node");
    const { default: EmailVerification } =
      await import("supertokens-node/recipe/emailverification/index.js");
    const tokenRes = await EmailVerification.createEmailVerificationToken(
      "public",
      supertokens.convertToRecipeUserId(userId),
    );
    if (tokenRes.status === "OK") {
      await EmailVerification.verifyEmailUsingToken("public", tokenRes.token);
    }

    // Re-sign in to get fresh session tokens (after verification)
    const freshSignin = await fetch(`${address}/auth/signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: testEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });
    expect(freshSignin.status).toBe(200);

    const cookies = freshSignin.headers.getSetCookie();
    const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
    const accessToken = freshSignin.headers.get("st-access-token");
    const antiCsrf = freshSignin.headers.get("anti-csrf");

    const headers: Record<string, string> = {
      origin: "http://localhost:3000",
      cookie: cookieHeader,
    };
    if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
    if (antiCsrf) headers["anti-csrf"] = antiCsrf;

    const meRes = await fetch(`${address}/api/customer/me`, { headers });

    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as {
      customer: { id: string; email: string; status: string };
    };
    expect(body.customer).toBeDefined();
    expect(body.customer.email).toBe(testEmail);
    expect(body.customer.status).toBe("active");
  });
});
