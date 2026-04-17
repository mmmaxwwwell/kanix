import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";

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

describeWithDeps("customer address CRUD API (T045)", () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let superTokensAvailable = false;
  let authHeaders: Record<string, string> = {};

  const ts = Date.now();
  const testEmail = `addr-test-${ts}@example.com`;
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

    return headers;
  }

  beforeAll(async () => {
    superTokensAvailable = await isSuperTokensUp();
    if (!superTokensAvailable) return;

    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      reservationCleanupIntervalMs: 0,
    });
    address = await server.start();
    markReady();
    app = server.app;

    // Create verified customer
    authHeaders = await signupAndVerify(testEmail, testPassword);
  });

  afterAll(async () => {
    markNotReady();
    if (app) await app.close();
    if (dbConn) await dbConn.close();
  });

  let createdAddressId = "";

  it("creates a shipping address", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "John Doe",
        phone: "555-123-4567",
        line1: "123 Main St",
        line2: "Apt 4B",
        city: "Portland",
        state: "OR",
        postal_code: "97201",
        is_default: false,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      address: { id: string; fullName: string; state: string; country: string };
    };
    expect(body.address.fullName).toBe("John Doe");
    expect(body.address.state).toBe("OR");
    expect(body.address.country).toBe("US");
    createdAddressId = body.address.id;
  });

  it("lists addresses for the customer", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/addresses`, {
      headers: authHeaders,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { addresses: Array<{ id: string }> };
    expect(body.addresses.length).toBeGreaterThanOrEqual(1);
    expect(body.addresses.some((a) => a.id === createdAddressId)).toBe(true);
  });

  it("sets address as default", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/addresses/${createdAddressId}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ is_default: true }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: { id: string; isDefault: boolean } };
    expect(body.address.isDefault).toBe(true);
  });

  it("only-one-default constraint: new default unsets previous", async () => {
    if (!superTokensAvailable) return;

    // Create a second shipping address and set it as default
    const createRes = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "Jane Doe",
        line1: "456 Oak Ave",
        city: "Seattle",
        state: "WA",
        postal_code: "98101",
        is_default: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { address: { id: string; isDefault: boolean } };
    expect(createBody.address.isDefault).toBe(true);
    const secondAddressId = createBody.address.id;

    // Verify the first address is no longer default
    const listRes = await fetch(`${address}/api/customer/addresses`, {
      headers: authHeaders,
    });
    const listBody = (await listRes.json()) as {
      addresses: Array<{ id: string; isDefault: boolean }>;
    };
    const firstAddr = listBody.addresses.find((a) => a.id === createdAddressId);
    const secondAddr = listBody.addresses.find((a) => a.id === secondAddressId);
    expect(firstAddr?.isDefault).toBe(false);
    expect(secondAddr?.isDefault).toBe(true);

    // Clean up second address
    await fetch(`${address}/api/customer/addresses/${secondAddressId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
  });

  it("updates an address", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/addresses/${createdAddressId}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: "John Smith",
        city: "Eugene",
        postal_code: "97401",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: { fullName: string; city: string; postalCode: string };
    };
    expect(body.address.fullName).toBe("John Smith");
    expect(body.address.city).toBe("Eugene");
    expect(body.address.postalCode).toBe("97401");
  });

  it("rejects non-US address on create", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "International Person",
        line1: "10 Downing Street",
        city: "London",
        state: "LDN",
        postal_code: "SW1A 2AA",
        country: "GB",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("US");
  });

  it("rejects invalid US state code", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "Test Person",
        line1: "123 Main St",
        city: "Somewhere",
        state: "XX",
        postal_code: "12345",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("Invalid US state code");
  });

  it("rejects invalid postal code format", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "Test Person",
        line1: "123 Main St",
        city: "Portland",
        state: "OR",
        postal_code: "ABCDE",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("postal code");
  });

  it("rejects invalid type", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "office",
        full_name: "Test Person",
        line1: "123 Main St",
        city: "Portland",
        state: "OR",
        postal_code: "97201",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("shipping");
  });

  it("deletes an address", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/addresses/${createdAddressId}`, {
      method: "DELETE",
      headers: authHeaders,
    });

    expect(res.status).toBe(204);

    // Verify it's gone
    const listRes = await fetch(`${address}/api/customer/addresses`, {
      headers: authHeaders,
    });
    const listBody = (await listRes.json()) as { addresses: Array<{ id: string }> };
    expect(listBody.addresses.some((a) => a.id === createdAddressId)).toBe(false);
  });

  it("returns 404 when deleting non-existent address", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(
      `${address}/api/customer/addresses/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
        headers: authHeaders,
      },
    );

    expect(res.status).toBe(404);
  });

  it("returns 401 without authentication", async () => {
    if (!superTokensAvailable) return;

    const res = await fetch(`${address}/api/customer/addresses`, {
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.status).toBe(401);
  });
});
