import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import type { DatabaseConnection } from "../db/connection.js";
import { order } from "../db/schema/order.js";
import { customer } from "../db/schema/customer.js";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";

describe("guest order → account linking (T036, FR-066, T207)", () => {
  let ts_: TestServer;
  let dbConn: DatabaseConnection;
  let address: string;

  const uniqueSuffix = Date.now();
  const testPassword = "TestPassword123!";

  // --- Emails unique per run ---
  const guestEmail = `guest-link-${uniqueSuffix}@example.com`;
  const idempotentEmail = `guest-idemp-${uniqueSuffix}@example.com`;

  // Track order IDs for cleanup
  const allOrderIds: string[] = [];
  // Track state across sequential tests
  let mainUserId: string;
  let mainCustId: string;

  /** Helper: insert a guest order (no customer_id) with valid status */
  async function insertGuestOrder(email: string, suffix: number): Promise<string> {
    const rows = await dbConn.db
      .insert(order)
      .values({
        orderNumber: `GUEST-${uniqueSuffix}-${suffix}`,
        email,
        customerId: null,
        status: "draft",
        subtotalMinor: 1000 * suffix,
        totalMinor: 1000 * suffix,
      })
      .returning({ id: order.id });
    allOrderIds.push(rows[0].id);
    return rows[0].id;
  }

  /** Helper: sign up via HTTP */
  async function signup(email: string): Promise<{ status: string; user?: { id: string } }> {
    const res = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: email },
          { id: "password", value: testPassword },
        ],
      }),
    });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ status: string; user?: { id: string } }>;
  }

  /** Helper: verify email via HTTP (fires the override that links orders) */
  async function verifyEmail(userId: string): Promise<void> {
    const { default: supertokens } = await import("supertokens-node");
    const { default: EmailVerification } =
      await import("supertokens-node/recipe/emailverification/index.js");
    const tokenRes = await EmailVerification.createEmailVerificationToken(
      "public",
      supertokens.convertToRecipeUserId(userId),
    );
    expect(tokenRes.status).toBe("OK");
    if (tokenRes.status !== "OK") return;

    const verifyRes = await fetch(`${address}/auth/user/email/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ method: "token", token: tokenRes.token }),
    });
    expect(verifyRes.status).toBe(200);
    const body = (await verifyRes.json()) as { status: string };
    expect(body.status).toBe("OK");
  }

  /** Helper: sign in and return auth headers */
  async function signinAndGetHeaders(email: string): Promise<Record<string, string>> {
    const res = await fetch(`${address}/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: email },
          { id: "password", value: testPassword },
        ],
      }),
    });
    expect(res.status).toBe(200);
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

  beforeAll(async () => {
    ts_ = await createTestServer();
    dbConn = ts_.dbConn;
    address = ts_.address;
  });

  afterAll(async () => {
    try {
      for (const id of allOrderIds) {
        await dbConn.db.delete(order).where(eq(order.id, id));
      }
      await dbConn.db.delete(customer).where(eq(customer.email, guestEmail));
      await dbConn.db.delete(customer).where(eq(customer.email, idempotentEmail));
    } catch {
      // Best-effort cleanup
    }
    await stopTestServer(ts_);
  });

  it("guest orders are NOT linked before email verification", async () => {
    // Create guest orders
    const oid1 = await insertGuestOrder(guestEmail, 1);
    const oid2 = await insertGuestOrder(guestEmail, 2);
    const oid3 = await insertGuestOrder(guestEmail, 3);

    // Signup — creates customer row but email is unverified
    const signupBody = await signup(guestEmail);
    expect(signupBody.status).toBe("OK");
    expect(signupBody.user).toBeDefined();
    mainUserId = signupBody.user!.id;

    // Orders must still be unlinked (customerId = null)
    const unlinked = await dbConn.db
      .select({ id: order.id, customerId: order.customerId })
      .from(order)
      .where(and(eq(order.email, guestEmail), isNull(order.customerId)));
    expect(unlinked.length).toBe(3);
    const unlinkedIds = unlinked.map((r) => r.id);
    expect(unlinkedIds).toContain(oid1);
    expect(unlinkedIds).toContain(oid2);
    expect(unlinkedIds).toContain(oid3);
  });

  it("on email verification, guest orders are linked to the new customer", async () => {
    // Get the customer row created by the signup in the previous test
    const custRows = await dbConn.db
      .select({ id: customer.id, authSubject: customer.authSubject })
      .from(customer)
      .where(eq(customer.email, guestEmail));
    expect(custRows.length).toBe(1);
    mainCustId = custRows[0].id;

    // Verify email — triggers linkGuestOrdersByEmail in the override
    await verifyEmail(mainUserId);

    // All 3 guest orders should now be linked to this customer
    const linked = await dbConn.db
      .select({ id: order.id, customerId: order.customerId })
      .from(order)
      .where(eq(order.email, guestEmail));
    expect(linked.length).toBe(3);
    for (const o of linked) {
      expect(o.customerId).toBe(mainCustId);
    }
  });

  it("linked orders appear in the authenticated customer order list", async () => {
    const headers = await signinAndGetHeaders(guestEmail);

    const ordersRes = await fetch(`${address}/api/customer/orders`, { headers });
    expect(ordersRes.status).toBe(200);
    const body = (await ordersRes.json()) as {
      orders: { id: string; orderNumber: string; email: string }[];
    };
    expect(body.orders.length).toBe(3);
    for (const o of body.orders) {
      expect(o.email).toBe(guestEmail);
      expect(allOrderIds).toContain(o.id);
    }
  });

  it("duplicate link attempts are idempotent", async () => {
    // Insert a guest order for a new email
    const oid = await insertGuestOrder(idempotentEmail, 100);

    // Signup + verify
    const signupBody = await signup(idempotentEmail);
    expect(signupBody.status).toBe("OK");
    const userId = signupBody.user!.id;
    await verifyEmail(userId);

    // Order should be linked
    const afterFirst = await dbConn.db
      .select({ id: order.id, customerId: order.customerId })
      .from(order)
      .where(eq(order.id, oid));
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].customerId).not.toBeNull();
    const linkedCustId = afterFirst[0].customerId;

    // Call linkGuestOrdersByEmail again directly — should be a no-op
    // (no unlinked orders remain, so 0 rows updated)
    const { linkGuestOrdersByEmail } = await import("../db/queries/order.js");
    const updated = await linkGuestOrdersByEmail(dbConn.db, idempotentEmail, linkedCustId!);
    expect(updated).toBe(0);

    // The order is still linked to the same customer (unchanged)
    const afterSecond = await dbConn.db
      .select({ id: order.id, customerId: order.customerId })
      .from(order)
      .where(eq(order.id, oid));
    expect(afterSecond.length).toBe(1);
    expect(afterSecond[0].customerId).toBe(linkedCustId);
  });
});
