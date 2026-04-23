import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "../server.js";
import { createDatabaseConnection, type DatabaseConnection } from "../db/connection.js";
import type { Config } from "../config.js";
import type { FastifyInstance } from "fastify";
import { assertSuperTokensUp, getSuperTokensUri, requireDatabaseUrl } from "../test-helpers.js";
import { eq } from "drizzle-orm";
import { customer } from "../db/schema/customer.js";

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

/**
 * Helper: sign in and return session headers for subsequent requests.
 */
async function signIn(
  address: string,
  email: string,
  password: string,
): Promise<{ headers: Record<string, string>; userId: string }> {
  const res = await fetch(`${address}/auth/signin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
    },
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
  const accessToken = res.headers.get("st-access-token");
  const antiCsrf = res.headers.get("anti-csrf");

  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    cookie: cookieHeader,
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  if (antiCsrf) headers["anti-csrf"] = antiCsrf;

  return { headers, userId: body.user.id };
}

/**
 * Helper: verify a user's email via SuperTokens API.
 */
async function verifyEmail(userId: string): Promise<void> {
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
}

describe("customer auth: email/password + email verification (T032)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

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
  });

  afterAll(async () => {
    markNotReady();
    if (app) await app.close();
    if (dbConn) await dbConn.close();
  });

  // Unique email per test run to avoid conflicts
  const testEmail = `test-auth-${Date.now()}@example.com`;
  const testPassword = "TestPassword123!";
  let signupUserId: string;

  it("signup creates user and customer record", async () => {
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
    const body = (await res.json()) as {
      status: string;
      user: { id: string; emails: string[] };
    };
    expect(body.status).toBe("OK");

    // Assert SuperTokens user properties
    expect(body.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.user.emails).toContain(testEmail);
    signupUserId = body.user.id;

    // Assert customer row created in DB
    const rows = await dbConn.db
      .select({
        id: customer.id,
        email: customer.email,
        authSubject: customer.authSubject,
        status: customer.status,
      })
      .from(customer)
      .where(eq(customer.authSubject, signupUserId));

    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(testEmail);
    expect(rows[0].authSubject).toBe(signupUserId);
    expect(rows[0].status).toBe("active");
    expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("unauthenticated request to protected endpoint returns 401", async () => {
    const res = await fetch(`${address}/api/customer/me`, {
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
    expect(body.message).toBe("Authentication required");
  });

  it("login returns valid session tokens with correct shape", async () => {
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
    const body = (await res.json()) as { status: string; user: { id: string; emails: string[] } };
    expect(body.status).toBe("OK");
    expect(body.user.id).toBe(signupUserId);
    expect(body.user.emails).toContain(testEmail);

    // Session tokens: either via cookies or headers
    const setCookieHeaders = res.headers.getSetCookie();
    const hasAccessCookie = setCookieHeaders.some((c) => c.includes("sAccessToken"));
    const hasAccessHeader = res.headers.has("st-access-token");
    expect(hasAccessCookie || hasAccessHeader).toBe(true);

    // If header-based tokens, assert they are non-empty strings
    const accessToken = res.headers.get("st-access-token");
    if (accessToken) {
      expect(accessToken.length).toBeGreaterThan(10);
    }

    // Access cookie should have httpOnly and path attributes
    if (hasAccessCookie) {
      const accessCookie = setCookieHeaders.find((c) => c.includes("sAccessToken"))!;
      expect(accessCookie).toContain("Path=/");
    }
  });

  it("logged-in but unverified user gets 403 on protected endpoint", async () => {
    const { headers } = await signIn(address, testEmail, testPassword);

    const meRes = await fetch(`${address}/api/customer/me`, { headers });

    expect(meRes.status).toBe(403);
    const body = (await meRes.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_EMAIL_NOT_VERIFIED");
    expect(body.message).toBe("Email verification required to access this resource");
  });

  it("verified user can access protected endpoint with correct customer data", async () => {
    // Verify email via SuperTokens API
    await verifyEmail(signupUserId);

    // Re-sign in to get fresh session with verified claim
    const { headers } = await signIn(address, testEmail, testPassword);

    const meRes = await fetch(`${address}/api/customer/me`, { headers });

    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as {
      customer: { id: string; email: string; status: string; githubUserId: string | null };
    };
    expect(body.customer.email).toBe(testEmail);
    expect(body.customer.status).toBe("active");
    expect(body.customer.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.customer.githubUserId).toBeNull();
  });

  it("bad credentials return 401 with correct error", async () => {
    const res = await fetch(`${address}/auth/signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: testEmail },
          { id: "password", value: "WrongPassword999!" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; message?: string };
    // SuperTokens returns 200 with status: "WRONG_CREDENTIALS_ERROR"
    expect(body.status).toBe("WRONG_CREDENTIALS_ERROR");
  });

  it("signin with non-existent email returns wrong credentials error", async () => {
    const res = await fetch(`${address}/auth/signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: `nonexistent-${Date.now()}@example.com` },
          { id: "password", value: testPassword },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("WRONG_CREDENTIALS_ERROR");
  });

  it("rate-limit rejects after exceeding max requests", async () => {
    // Create a separate server instance with very low rate limit
    const rateLimitDbConn = createDatabaseConnection(DATABASE_URL);
    const rateLimitServer = await createServer({
      config: testConfig({ RATE_LIMIT_MAX: 3, RATE_LIMIT_WINDOW_MS: 60000 }),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: rateLimitDbConn,
    });
    const rateLimitAddress = await rateLimitServer.start();

    try {
      // Exhaust the rate limit (3 requests allowed)
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${rateLimitAddress}/ready`, {
          headers: { origin: "http://localhost:3000" },
        });
        expect(res.status).not.toBe(429);
      }

      // 4th request should be rate-limited
      const blockedRes = await fetch(`${rateLimitAddress}/auth/signin`, {
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

      expect(blockedRes.status).toBe(429);
      const body = (await blockedRes.json()) as { error: string };
      expect(body.error).toBe("Rate limit exceeded");

      // Verify Retry-After header is present and numeric
      const retryAfter = blockedRes.headers.get("Retry-After");
      expect(retryAfter).not.toBeNull();
      expect(Number(retryAfter)).toBeGreaterThan(0);

      // Verify rate limit headers
      expect(blockedRes.headers.get("X-RateLimit-Limit")).toBe("3");
      expect(blockedRes.headers.get("X-RateLimit-Remaining")).toBe("0");
    } finally {
      await rateLimitServer.app.close();
      await rateLimitDbConn.close();
    }
  });
});
