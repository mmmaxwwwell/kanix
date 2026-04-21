import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

describe("customer address CRUD API (T045)", () => {
  let ts_: TestServer;

  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let authHeaders: Record<string, string> = {};
  let otherAuthHeaders: Record<string, string> = {};

  const ts = Date.now();
  const testEmail = `addr-test-${ts}@example.com`;
  const otherEmail = `addr-other-${ts}@example.com`;
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
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

    // Create two verified customers for isolation testing
    authHeaders = await signupAndVerify(testEmail, testPassword);
    otherAuthHeaders = await signupAndVerify(otherEmail, testPassword);
  });

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  // ---- CRUD happy paths ----

  let createdAddressId = "";

  it("creates a shipping address with all fields", async () => {
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
      address: {
        id: string;
        fullName: string;
        phone: string;
        line1: string;
        line2: string;
        city: string;
        state: string;
        postalCode: string;
        country: string;
        type: string;
        isDefault: boolean;
      };
    };
    expect(body.address.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.address.fullName).toBe("John Doe");
    expect(body.address.phone).toBe("555-123-4567");
    expect(body.address.line1).toBe("123 Main St");
    expect(body.address.line2).toBe("Apt 4B");
    expect(body.address.city).toBe("Portland");
    expect(body.address.state).toBe("OR");
    expect(body.address.postalCode).toBe("97201");
    expect(body.address.country).toBe("US");
    expect(body.address.type).toBe("shipping");
    expect(body.address.isDefault).toBe(false);
    createdAddressId = body.address.id;
  });

  it("lists addresses for the customer and returns the created address", async () => {
    const res = await fetch(`${address}/api/customer/addresses`, {
      headers: authHeaders,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      addresses: Array<{ id: string; fullName: string; city: string }>;
    };
    // We created exactly one address so far for this user
    const ourAddr = body.addresses.find((a) => a.id === createdAddressId);
    expect(ourAddr).toBeDefined();
    expect(ourAddr!.fullName).toBe("John Doe");
    expect(ourAddr!.city).toBe("Portland");
  });

  it("updates an address with partial fields", async () => {
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
      address: {
        fullName: string;
        city: string;
        postalCode: string;
        line1: string;
        state: string;
      };
    };
    expect(body.address.fullName).toBe("John Smith");
    expect(body.address.city).toBe("Eugene");
    expect(body.address.postalCode).toBe("97401");
    // Unchanged fields preserved
    expect(body.address.line1).toBe("123 Main St");
    expect(body.address.state).toBe("OR");
  });

  it("deletes an address and confirms removal", async () => {
    // Create a throwaway address to delete
    const createRes = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "Throwaway",
        line1: "999 Temp Rd",
        city: "Bend",
        state: "OR",
        postal_code: "97701",
      }),
    });
    expect(createRes.status).toBe(201);
    const { address: created } = (await createRes.json()) as { address: { id: string } };

    const delRes = await fetch(`${address}/api/customer/addresses/${created.id}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(delRes.status).toBe(204);

    // Verify it's gone from the list
    const listRes = await fetch(`${address}/api/customer/addresses`, {
      headers: authHeaders,
    });
    const listBody = (await listRes.json()) as { addresses: Array<{ id: string }> };
    expect(listBody.addresses.some((a) => a.id === created.id)).toBe(false);
  });

  it("returns 404 when deleting non-existent address", async () => {
    const res = await fetch(
      `${address}/api/customer/addresses/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
        headers: authHeaders,
      },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_NOT_FOUND");
  });

  // ---- Cross-user isolation (returns 404, not 403) ----

  it("returns 404 when another user tries to read/update/delete someone else's address", async () => {
    // Other user tries to PATCH the first user's address → 404
    const patchRes = await fetch(`${address}/api/customer/addresses/${createdAddressId}`, {
      method: "PATCH",
      headers: { ...otherAuthHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: "Hacker" }),
    });
    expect(patchRes.status).toBe(404);
    const patchBody = (await patchRes.json()) as { error: string };
    expect(patchBody.error).toBe("ERR_NOT_FOUND");

    // Other user tries to DELETE the first user's address → 404
    const delRes = await fetch(`${address}/api/customer/addresses/${createdAddressId}`, {
      method: "DELETE",
      headers: otherAuthHeaders,
    });
    expect(delRes.status).toBe(404);

    // Confirm the address still exists for the original owner
    const listRes = await fetch(`${address}/api/customer/addresses`, {
      headers: authHeaders,
    });
    const listBody = (await listRes.json()) as { addresses: Array<{ id: string }> };
    expect(listBody.addresses.some((a) => a.id === createdAddressId)).toBe(true);
  });

  it("other user's list does not include first user's addresses", async () => {
    const res = await fetch(`${address}/api/customer/addresses`, {
      headers: otherAuthHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { addresses: Array<{ id: string }> };
    // The other user has no addresses — shouldn't see the first user's
    expect(body.addresses.some((a) => a.id === createdAddressId)).toBe(false);
  });

  // ---- Default-address behavior ----

  it("sets address as default", async () => {
    const res = await fetch(`${address}/api/customer/addresses/${createdAddressId}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ is_default: true }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: { id: string; isDefault: boolean } };
    expect(body.address.isDefault).toBe(true);
  });

  it("only-one-default: setting a new default unsets the previous one", async () => {
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

    // List addresses — only the second should be default
    const listRes = await fetch(`${address}/api/customer/addresses`, {
      headers: authHeaders,
    });
    const listBody = (await listRes.json()) as {
      addresses: Array<{ id: string; isDefault: boolean }>;
    };
    const firstAddr = listBody.addresses.find((a) => a.id === createdAddressId);
    const secondAddr = listBody.addresses.find((a) => a.id === secondAddressId);
    expect(firstAddr).toBeDefined();
    expect(secondAddr).toBeDefined();
    expect(firstAddr!.isDefault).toBe(false);
    expect(secondAddr!.isDefault).toBe(true);

    // Count how many defaults exist — must be exactly one
    const defaultCount = listBody.addresses.filter((a) => a.isDefault).length;
    expect(defaultCount).toBe(1);

    // Clean up second address
    await fetch(`${address}/api/customer/addresses/${secondAddressId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
  });

  // ---- Validation: incomplete addresses with per-field errors ----

  it("rejects address missing full_name", async () => {
    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        line1: "123 Main St",
        city: "Portland",
        state: "OR",
        postal_code: "97201",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toBe("full_name is required");
  });

  it("rejects address missing line1", async () => {
    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "Test Person",
        city: "Portland",
        state: "OR",
        postal_code: "97201",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toBe("line1 is required");
  });

  it("rejects address missing city", async () => {
    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "Test Person",
        line1: "123 Main St",
        state: "OR",
        postal_code: "97201",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toBe("city is required");
  });

  it("rejects address missing state", async () => {
    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "Test Person",
        line1: "123 Main St",
        city: "Portland",
        postal_code: "97201",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toBe("state is required");
  });

  it("rejects address missing postal_code", async () => {
    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        full_name: "Test Person",
        line1: "123 Main St",
        city: "Portland",
        state: "OR",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toBe("postal_code is required");
  });

  // ---- Validation: format/value errors ----

  it("rejects non-US address on create", async () => {
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
    expect(body.message).toBe("Invalid US state code: XX");
  });

  it("rejects invalid postal code format", async () => {
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
    expect(body.message).toBe("Invalid US postal code format");
  });

  it("rejects invalid type", async () => {
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

  // ---- Auth: unauthenticated access ----

  it("returns 401 without authentication", async () => {
    const res = await fetch(`${address}/api/customer/addresses`, {
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.status).toBe(401);
  });

  it("returns 404 on update of non-existent address", async () => {
    const res = await fetch(
      `${address}/api/customer/addresses/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: "Nobody" }),
      },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_NOT_FOUND");
  });
});
