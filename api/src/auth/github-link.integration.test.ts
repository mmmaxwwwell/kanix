import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "../server.js";
import { createDatabaseConnection, type DatabaseConnection } from "../db/connection.js";
import type { Config } from "../config.js";
import type { FastifyInstance } from "fastify";
import type { GitHubUserFetcher } from "./github.js";

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
    GITHUB_OAUTH_CLIENT_ID: "test-github-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-github-secret",
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

describeWithDeps("GitHub OAuth: link GitHub account (T033)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;

  // Mock GitHub user fetcher that returns a predictable user
  const mockGitHubUserId = 12345;
  const mockGitHubFetcher: GitHubUserFetcher = async () => {
    return { id: mockGitHubUserId, login: "testuser" };
  };

  beforeAll(async () => {
    superTokensAvailable = await isSuperTokensUp();
    if (!superTokensAvailable) return;

    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      githubUserFetcher: mockGitHubFetcher,
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

  const testEmail = `gh-test-${Date.now()}@example.com`;
  const testPassword = "TestPassword123!";

  async function signupAndVerify(email: string, password: string) {
    // Signup
    const signupRes = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: email },
          { id: "password", value: password },
        ],
      }),
    });
    expect(signupRes.status).toBe(200);
    const signupBody = (await signupRes.json()) as { status: string; user: { id: string } };
    expect(signupBody.status).toBe("OK");
    const userId = signupBody.user.id;

    // Verify email
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

    // Sign in to get session
    const signinRes = await fetch(`${address}/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: email },
          { id: "password", value: password },
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

    return { userId, headers };
  }

  it("create customer → link GitHub → verify github_user_id stored", async function () {
    if (!superTokensAvailable) return;

    const { headers } = await signupAndVerify(testEmail, testPassword);

    // Link GitHub account
    const linkRes = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });

    expect(linkRes.status).toBe(200);
    const linkBody = (await linkRes.json()) as {
      customer: { id: string; github_user_id: string };
    };
    expect(linkBody.customer.github_user_id).toBe(String(mockGitHubUserId));

    // Verify the github_user_id is persisted by fetching /api/customer/me
    const meRes = await fetch(`${address}/api/customer/me`, { headers });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      customer: { id: string; email: string; githubUserId: string | null };
    };
    expect(meBody.customer.githubUserId).toBe(String(mockGitHubUserId));
  });

  it("duplicate link prevented — same customer cannot re-link", async function () {
    if (!superTokensAvailable) return;

    const { headers } = await signupAndVerify(testEmail, testPassword);

    // Try to link again — should get 409 (already linked)
    const linkRes = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });

    expect(linkRes.status).toBe(409);
    const body = (await linkRes.json()) as { error: string };
    expect(body.error).toBe("ERR_ALREADY_LINKED");
  });

  it("duplicate link prevented — different customer cannot use same GitHub ID", async function () {
    if (!superTokensAvailable) return;

    const secondEmail = `gh-test2-${Date.now()}@example.com`;
    const { headers } = await signupAndVerify(secondEmail, testPassword);

    // Try to link same GitHub ID to different customer — should get 409
    const linkRes = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });

    expect(linkRes.status).toBe(409);
    const body = (await linkRes.json()) as { error: string };
    expect(body.error).toBe("ERR_DUPLICATE_LINK");
  });

  it("unauthenticated request gets 401", async function () {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });

    expect(res.status).toBe(401);
  });

  it("missing code field gets 400", async function () {
    if (!superTokensAvailable) return;

    const { headers } = await signupAndVerify(`gh-test3-${Date.now()}@example.com`, testPassword);

    const res = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_VALIDATION");
  });
});
