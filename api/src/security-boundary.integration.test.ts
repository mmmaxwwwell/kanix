/**
 * T104 — Security boundary tests [SC-008, SC-015]
 *
 * Scripted API-level tests:
 *   1. Unauthenticated → 401 on all protected endpoints
 *   2. Wrong permission → 403 (customer on admin routes)
 *   3. SQL injection attempts → rejected (parameterized queries)
 *   4. XSS in input → sanitized in response
 *   5. Invalid webhook signature → rejected
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection } from "./db/connection.js";
import { customer } from "./db/schema/customer.js";
import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { getSuperTokensUri } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const run = Date.now();
const CUSTOMER_EMAIL = `sec-t104-${run}@example.com`;
const PASSWORD = "SecBound1!T104";
const WEBHOOK_SECRET = "whsec_test_t104_security_boundary";

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
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
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
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
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

// ---------------------------------------------------------------------------
// Webhook helper
// ---------------------------------------------------------------------------

function generateWebhookPayload(
  eventId: string,
  type: string,
  data: Record<string, unknown>,
  secret: string,
): { body: string; signature: string } {
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type,
    data: { object: data },
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    api_version: "2024-12-18.acacia",
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const sig = createHmac("sha256", secret).update(signedPayload).digest("hex");
  const signature = `t=${timestamp},v1=${sig}`;

  return { body: payload, signature };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T104 security boundary tests [SC-008, SC-015]", () => {
  let ts: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  let customerHeaders: Record<string, string> = {};
  let customerId = "";

  beforeAll(async () => {
    ts = await createTestServer({
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
    });
    app = ts.app;
    dbConn = ts.dbConn;
    address = ts.address;

    // Create a verified customer user
    const { userId } = await signUpUser(address, CUSTOMER_EMAIL, PASSWORD);
    await verifyEmail(userId);
    const login = await signIn(address, CUSTOMER_EMAIL, PASSWORD);
    customerHeaders = login.headers;

    const [cust] = await dbConn.db.select().from(customer).where(eq(customer.authSubject, userId));
    customerId = cust.id;
  }, 60_000);

  afterAll(async () => {
    await stopTestServer(ts);
  });

  // =========================================================================
  // 1. Unauthenticated → 401 on all protected endpoints
  // =========================================================================

  describe("unauthenticated requests return 401", () => {
    const protectedEndpoints = [
      { method: "GET" as const, path: "/api/customer/me" },
      { method: "GET" as const, path: "/api/customer/orders" },
      { method: "GET" as const, path: "/api/customer/addresses" },
      { method: "GET" as const, path: "/api/admin/orders" },
      { method: "GET" as const, path: "/api/admin/audit-log" },
      { method: "GET" as const, path: "/api/admin/products" },
      { method: "GET" as const, path: "/api/admin/customers" },
    ];

    for (const ep of protectedEndpoints) {
      it(`${ep.method} ${ep.path} without session returns 401`, async () => {
        const res = await fetch(`${address}${ep.path}`, {
          method: ep.method,
          headers: { origin: "http://localhost:3000" },
        });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("ERR_AUTHENTICATION_FAILED");
      });
    }
  });

  // =========================================================================
  // 2. Wrong permission → 403 (customer token on admin routes)
  // =========================================================================

  describe("customer token on admin routes returns 403", () => {
    const adminEndpoints = [
      { method: "GET" as const, path: "/api/admin/orders" },
      { method: "GET" as const, path: "/api/admin/audit-log" },
      { method: "GET" as const, path: "/api/admin/products" },
      { method: "GET" as const, path: "/api/admin/customers" },
    ];

    for (const ep of adminEndpoints) {
      it(`${ep.method} ${ep.path} with customer auth returns 403`, async () => {
        const res = await fetch(`${address}${ep.path}`, {
          method: ep.method,
          headers: customerHeaders,
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("ERR_FORBIDDEN");
      });
    }
  });

  // =========================================================================
  // 3. SQL injection attempts → rejected (parameterized queries)
  // =========================================================================

  describe("SQL injection attempts are safely handled", () => {
    const sqliPayloads = [
      "'; DROP TABLE customer; --",
      "1 OR 1=1",
      "' UNION SELECT * FROM customer --",
      "1; DELETE FROM customer WHERE ''='",
      "admin'--",
      "' OR '1'='1",
    ];

    it("SQL injection in product search does not cause errors", async () => {
      for (const payload of sqliPayloads) {
        const res = await fetch(`${address}/api/products?search=${encodeURIComponent(payload)}`, {
          headers: { origin: "http://localhost:3000" },
        });
        // Should return 200 with empty results, not 500
        expect(res.status).toBeLessThan(500);
      }
    });

    it("SQL injection in address name field is stored/returned as literal text", async () => {
      const xssName = "Robert'; DROP TABLE customer_address;--";
      const res = await fetch(`${address}/api/customer/addresses`, {
        method: "POST",
        headers: { ...customerHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "shipping",
          full_name: xssName,
          line1: "123 Test St",
          city: "Testville",
          state: "TX",
          postal_code: "75001",
          country: "US",
          is_default: false,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { address: { id: string; fullName: string } };
      // The SQL injection payload is stored as literal text, not executed
      expect(body.address.fullName).toBe(xssName);

      // Verify the customer_address table still exists by listing addresses
      const listRes = await fetch(`${address}/api/customer/addresses`, {
        headers: customerHeaders,
      });
      expect(listRes.status).toBe(200);
    });
  });

  // =========================================================================
  // 4. XSS in input → sanitized/escaped in response
  // =========================================================================

  describe("XSS payloads in input are not executed (JSON API)", () => {
    it("XSS payload in address name is returned as literal text in JSON", async () => {
      const xssPayload = '<script>alert("XSS")</script>';
      const res = await fetch(`${address}/api/customer/addresses`, {
        method: "POST",
        headers: { ...customerHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "shipping",
          full_name: xssPayload,
          line1: "456 XSS Test Ave",
          city: "Hackville",
          state: "CA",
          postal_code: "90210",
          country: "US",
          is_default: false,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { address: { id: string; fullName: string } };
      // The XSS payload is returned as-is in JSON (no execution context)
      expect(body.address.fullName).toBe(xssPayload);

      // Response Content-Type must be application/json (not text/html)
      const contentType = res.headers.get("content-type");
      expect(contentType).toMatch(/application\/json/);
    });

    it("XSS payload in address line does not cause HTML response", async () => {
      const xssPayloads = [
        "<img src=x onerror=alert(1)>",
        '"><svg onload=alert(1)>',
        "javascript:alert(document.cookie)",
      ];

      for (const payload of xssPayloads) {
        const res = await fetch(`${address}/api/customer/addresses`, {
          method: "POST",
          headers: { ...customerHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "shipping",
            full_name: "XSS Tester",
            line1: payload,
            city: "Test",
            state: "TX",
            postal_code: "75001",
            country: "US",
            is_default: false,
          }),
        });
        expect(res.status).toBe(201);
        // JSON response — no HTML rendering context
        const contentType = res.headers.get("content-type");
        expect(contentType).toMatch(/application\/json/);
        const body = (await res.json()) as { address: { line1: string } };
        expect(body.address.line1).toBe(payload);
      }
    });

    it("product search with XSS payload returns JSON, not HTML", async () => {
      const xss = '<script>alert("xss")</script>';
      const res = await fetch(`${address}/api/products?search=${encodeURIComponent(xss)}`, {
        headers: { origin: "http://localhost:3000" },
      });
      expect(res.status).toBeLessThan(500);
      const contentType = res.headers.get("content-type");
      expect(contentType).toMatch(/application\/json/);
    });
  });

  // =========================================================================
  // 5. Invalid webhook signature → rejected
  // =========================================================================

  describe("invalid webhook signature is rejected", () => {
    it("missing stripe-signature header returns 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "payment_intent.succeeded" }),
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_MISSING_SIGNATURE");
    });

    it("invalid signature format returns 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=1234567890,v1=invalid_signature_abc123",
        },
        body: JSON.stringify({ type: "payment_intent.succeeded" }),
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ERR_INVALID_SIGNATURE");
    });

    it("signature signed with wrong secret returns 401", async () => {
      const { body, signature } = generateWebhookPayload(
        `evt_wrong_${run}`,
        "payment_intent.succeeded",
        { id: "pi_test", object: "payment_intent", status: "succeeded" },
        "whsec_COMPLETELY_WRONG_SECRET",
      );

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature,
        },
        body,
      });
      expect(res.statusCode).toBe(401);
      const body2 = JSON.parse(res.body);
      expect(body2.error).toBe("ERR_INVALID_SIGNATURE");
    });

    it("tampered payload with valid-looking signature returns 401", async () => {
      // Generate a valid signature for one payload
      const { signature } = generateWebhookPayload(
        `evt_tampered_${run}`,
        "payment_intent.succeeded",
        { id: "pi_test", object: "payment_intent", status: "succeeded" },
        WEBHOOK_SECRET,
      );

      // Send a different payload with the signature from the original
      const tamperedBody = JSON.stringify({
        id: `evt_tampered_${run}`,
        object: "event",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_HACKED",
            object: "payment_intent",
            status: "succeeded",
            amount: 999999,
          },
        },
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        api_version: "2024-12-18.acacia",
      });

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature,
        },
        body: tamperedBody,
      });
      expect(res.statusCode).toBe(401);
      const body2 = JSON.parse(res.body);
      expect(body2.error).toBe("ERR_INVALID_SIGNATURE");
    });

    it("empty body with signature returns 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=1234567890,v1=deadbeef",
        },
        body: "",
      });
      // Empty body should fail signature verification or parsing
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });
  });
});
