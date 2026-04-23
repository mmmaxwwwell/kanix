/**
 * Flow test: security boundary enforcement [mirrors T104, SC-008, SC-015]
 *
 * Exercises each trust boundary:
 *   - Unauthenticated → 401 on protected routes
 *   - Customer token on admin route → 403
 *   - Cross-customer access (customer A reads customer B) → 404 (existence hidden)
 *   - Session token replay after logout → 401
 *   - Rate-limit exceeded → 429 with Retry-After
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection } from "../db/connection.js";
import { customer } from "../db/schema/customer.js";
import { eq } from "drizzle-orm";
import { getSuperTokensUri } from "../test-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const run = Date.now();
const USER_A_EMAIL = `sec-a-${run}@example.com`;
const USER_B_EMAIL = `sec-b-${run}@example.com`;
const PASSWORD = "SecBoundary1!";

// ---------------------------------------------------------------------------
// Auth helpers (real HTTP — SuperTokens requires cookies)
// ---------------------------------------------------------------------------

async function signUpUser(
  address: string,
  email: string,
  password: string,
): Promise<{ userId: string }> {
  const res = await fetch(`${address}/auth/signup`, {
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
  const body = (await res.json()) as {
    status: string;
    user: { id: string; emails: string[] };
  };
  expect(body.status).toBe("OK");
  return { userId: body.user.id };
}

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

async function signOut(address: string, headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${address}/auth/signout`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("security boundary enforcement flow (T268, mirrors T104/SC-008/SC-015)", () => {
  let ts: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  // User A state
  let userAAuthSubject = "";
  let userAHeaders: Record<string, string> = {};
  let customerAId = "";

  // User B state
  let userBAuthSubject = "";
  let userBHeaders: Record<string, string> = {};
  let customerBId = "";

  // Address created by user B (used for cross-customer tests)
  let userBAddressId = "";

  beforeAll(async () => {
    ts = await createTestServer({
      configOverrides: {
        // Tiny rate-limit window for the rate-limit test
        RATE_LIMIT_MAX: 1000,
        RATE_LIMIT_WINDOW_MS: 60000,
      },
    });
    app = ts.app;
    dbConn = ts.dbConn;
    address = ts.address;

    // --- Create User A ---
    const { userId: aId } = await signUpUser(address, USER_A_EMAIL, PASSWORD);
    userAAuthSubject = aId;
    await verifyEmail(userAAuthSubject);
    const aLogin = await signIn(address, USER_A_EMAIL, PASSWORD);
    userAHeaders = aLogin.headers;

    // Fetch customer A ID
    const [custA] = await dbConn.db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, userAAuthSubject));
    customerAId = custA.id;

    // --- Create User B ---
    const { userId: bId } = await signUpUser(address, USER_B_EMAIL, PASSWORD);
    userBAuthSubject = bId;
    await verifyEmail(userBAuthSubject);
    const bLogin = await signIn(address, USER_B_EMAIL, PASSWORD);
    userBHeaders = bLogin.headers;

    // Fetch customer B ID
    const [custB] = await dbConn.db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, userBAuthSubject));
    customerBId = custB.id;

    // Create an address for User B (for cross-customer tests)
    const addrRes = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...userBHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "User B",
        line1: "456 Private Rd",
        city: "Dallas",
        state: "TX",
        postal_code: "75201",
        country: "US",
        is_default: true,
      }),
    });
    expect(addrRes.status).toBe(201);
    const addrBody = (await addrRes.json()) as { address: { id: string } };
    userBAddressId = addrBody.address.id;
  }, 60_000);

  afterAll(async () => {
    await stopTestServer(ts);
  });

  // -------------------------------------------------------------------------
  // Boundary 1: Unauthenticated → 401 on protected routes
  // -------------------------------------------------------------------------

  describe("unauthenticated requests return 401", () => {
    it("GET /api/customer/me without session returns 401", async () => {
      const res = await fetch(`${address}/api/customer/me`, {
        headers: { origin: "http://localhost:3000" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
    });

    it("GET /api/customer/orders without session returns 401", async () => {
      const res = await fetch(`${address}/api/customer/orders`, {
        headers: { origin: "http://localhost:3000" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
    });

    it("GET /api/customer/addresses without session returns 401", async () => {
      const res = await fetch(`${address}/api/customer/addresses`, {
        headers: { origin: "http://localhost:3000" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
    });

    it("GET /api/admin/orders without session returns 401", async () => {
      const res = await fetch(`${address}/api/admin/orders`, {
        headers: { origin: "http://localhost:3000" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
    });

    it("GET /api/admin/audit-log without session returns 401", async () => {
      const res = await fetch(`${address}/api/admin/audit-log`, {
        headers: { origin: "http://localhost:3000" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
    });
  });

  // -------------------------------------------------------------------------
  // Boundary 2: Customer token on admin route → 403
  // -------------------------------------------------------------------------

  describe("customer token on admin routes returns 403", () => {
    it("GET /api/admin/orders with customer auth returns 403", async () => {
      const res = await fetch(`${address}/api/admin/orders`, {
        headers: userAHeaders,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_FORBIDDEN");
    });

    it("GET /api/admin/audit-log with customer auth returns 403", async () => {
      const res = await fetch(`${address}/api/admin/audit-log`, {
        headers: userAHeaders,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_FORBIDDEN");
    });

    it("GET /api/admin/products with customer auth returns 403", async () => {
      const res = await fetch(`${address}/api/admin/products`, {
        headers: userAHeaders,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_FORBIDDEN");
    });

    it("GET /api/admin/customers with customer auth returns 403", async () => {
      const res = await fetch(`${address}/api/admin/customers`, {
        headers: userAHeaders,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_FORBIDDEN");
    });
  });

  // -------------------------------------------------------------------------
  // Boundary 3: Cross-customer access → 404 (existence hidden)
  // -------------------------------------------------------------------------

  describe("cross-customer access returns 404 (hides existence)", () => {
    it("customer A cannot update customer B address — returns 404", async () => {
      const res = await fetch(`${address}/api/customer/addresses/${userBAddressId}`, {
        method: "PATCH",
        headers: { ...userAHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: "Hacked Name" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_NOT_FOUND");
    });

    it("customer A cannot delete customer B address — returns 404", async () => {
      const res = await fetch(`${address}/api/customer/addresses/${userBAddressId}`, {
        method: "DELETE",
        headers: userAHeaders,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_NOT_FOUND");
    });

    it("customer A address list does not contain customer B addresses", async () => {
      const res = await fetch(`${address}/api/customer/addresses`, {
        headers: userAHeaders,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        addresses: { id: string }[];
      };
      const found = body.addresses.find((a) => a.id === userBAddressId);
      expect(found).toBeUndefined();
    });

    it("customer B address is still intact (not modified by A)", async () => {
      const res = await fetch(`${address}/api/customer/addresses`, {
        headers: userBHeaders,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        addresses: { id: string; fullName: string }[];
      };
      const found = body.addresses.find((a) => a.id === userBAddressId);
      expect(found).toBeDefined();
      expect(found!.fullName).toBe("User B");
    });
  });

  // -------------------------------------------------------------------------
  // Boundary 4: Session token replay after logout → 401
  // -------------------------------------------------------------------------

  describe("session token replay after logout returns 401", () => {
    let replayHeaders: Record<string, string> = {};
    let replayUserId = "";

    it("login, capture headers, then revoke sessions", async () => {
      // Create a fresh login to avoid disrupting other tests
      const tempEmail = `sec-replay-${run}@example.com`;
      const { userId } = await signUpUser(address, tempEmail, PASSWORD);
      await verifyEmail(userId);
      const { headers } = await signIn(address, tempEmail, PASSWORD);
      replayHeaders = headers;
      replayUserId = userId;

      // Verify session is valid
      const meRes = await fetch(`${address}/api/customer/me`, {
        headers: replayHeaders,
      });
      expect(meRes.status).toBe(200);

      // Sign out — revokes the session in SuperTokens
      await signOut(address, replayHeaders);

      // Also revoke via the core API to ensure all sessions are invalidated
      const supertokensUri = getSuperTokensUri();
      const revokeRes = await fetch(`${supertokensUri}/recipe/session/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: replayUserId }),
      });
      const revokeBody = (await revokeRes.json()) as { status: string };
      expect(revokeBody.status).toBe("OK");
    }, 30_000);

    it("replaying the old session token after logout returns 401", async () => {
      const res = await fetch(`${address}/api/customer/me`, {
        headers: replayHeaders,
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
    });

    it("replaying the old token on address list also returns 401", async () => {
      const res = await fetch(`${address}/api/customer/addresses`, {
        headers: replayHeaders,
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
    });
  });

  // -------------------------------------------------------------------------
  // Boundary 5: Rate-limit exceeded → 429 with Retry-After
  // -------------------------------------------------------------------------

  describe("rate-limit exceeded returns 429 with Retry-After", () => {
    let rlTs: TestServer;
    let rlAddress: string;

    beforeAll(async () => {
      // Separate server with a very low rate limit
      rlTs = await createTestServer({
        configOverrides: {
          RATE_LIMIT_MAX: 3,
          RATE_LIMIT_WINDOW_MS: 60000,
        },
      });
      rlAddress = rlTs.address;
    }, 30_000);

    afterAll(async () => {
      await stopTestServer(rlTs);
    });

    it("exceeding rate limit returns 429 with correct headers", async () => {
      // Exhaust the rate limit (3 requests)
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${rlAddress}/api/products`, {
          headers: { origin: "http://localhost:3000" },
        });
        expect(res.status).toBeLessThan(429);
        // Verify rate limit headers are present
        expect(res.headers.get("x-ratelimit-limit")).toBe("3");
        const remaining = parseInt(res.headers.get("x-ratelimit-remaining") ?? "-1", 10);
        expect(remaining).toBe(3 - (i + 1));
      }

      // 4th request should be rate-limited
      const blockedRes = await fetch(`${rlAddress}/api/products`, {
        headers: { origin: "http://localhost:3000" },
      });
      expect(blockedRes.status).toBe(429);

      // Verify Retry-After header is present and numeric
      const retryAfter = blockedRes.headers.get("retry-after");
      expect(retryAfter).toBeTruthy();
      expect(parseInt(retryAfter!, 10)).toBeGreaterThan(0);

      // Verify error body
      const body = (await blockedRes.json()) as { error: string };
      expect(body.error).toBe("Rate limit exceeded");

      // Verify rate limit headers on the 429 response
      expect(blockedRes.headers.get("x-ratelimit-limit")).toBe("3");
      expect(blockedRes.headers.get("x-ratelimit-remaining")).toBe("0");
    });
  });
});
