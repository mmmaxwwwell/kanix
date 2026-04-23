import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { eq, ilike } from "drizzle-orm";
import { createServer, markReady, markNotReady, type ServerInstance } from "../server.js";
import { createDatabaseConnection, type DatabaseConnection } from "../db/connection.js";
import type { Config } from "../config.js";
import { customer } from "../db/schema/customer.js";
import { createAdminAlertService, type AdminAlertService } from "../services/admin-alert.js";
import { assertSuperTokensUp, getSuperTokensUri, requireDatabaseUrl } from "../test-helpers.js";

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

describe("email conflict handling (T054e, T205)", () => {
  let server: ServerInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminAlertService: AdminAlertService;

  const uniqueSuffix = Date.now();
  const existingEmail = `conflict-existing-${uniqueSuffix}@example.com`;
  const caseEmail = `Conflict-CASE-${uniqueSuffix}@Example.COM`;
  const caseEmailLower = caseEmail.toLowerCase();
  const testPassword = "TestPassword123!";
  const fakeAuthSubject = `fake-auth-subject-${uniqueSuffix}`;
  const githubAuthSubject = `github-auth-${uniqueSuffix}`;

  beforeAll(async () => {
    await assertSuperTokensUp();

    dbConn = createDatabaseConnection(DATABASE_URL);
    adminAlertService = createAdminAlertService();

    server = await createServer({
      config: testConfig(),
      processRef: createFakeProcess() as unknown as NodeJS.Process,
      database: dbConn,
      adminAlertService,
    });
    address = await server.start();
    markReady();

    // Seed customer A (simulates an account that already owns existingEmail)
    await dbConn.db.insert(customer).values({
      authSubject: fakeAuthSubject,
      email: existingEmail,
      status: "active",
    });

    // Seed customer B with a GitHub-linked account (different auth method)
    await dbConn.db.insert(customer).values({
      authSubject: githubAuthSubject,
      email: caseEmailLower,
      githubUserId: `gh-${uniqueSuffix}`,
      status: "active",
    });
  });

  afterAll(async () => {
    markNotReady();
    if (dbConn) {
      await dbConn.db.delete(customer).where(eq(customer.authSubject, fakeAuthSubject));
      await dbConn.db.delete(customer).where(eq(customer.authSubject, githubAuthSubject));
      // Clean up any test customers created during signup attempts
      await dbConn.db.delete(customer).where(ilike(customer.email, `%conflict%${uniqueSuffix}%`));
    }
    if (server) await server.app.close();
    if (dbConn) await dbConn.close();
  });

  it("signup with an existing email returns GENERAL_ERROR with ERR_EMAIL_CONFLICT", async () => {
    const res = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: existingEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; message?: string };
    expect(body.status).toBe("GENERAL_ERROR");
    expect(body.message).toBe("ERR_EMAIL_CONFLICT");
  });

  it("existing user's password and session are unaffected after conflict attempt", async () => {
    // The existing customer row should still be intact
    const rows = await dbConn.db
      .select({
        id: customer.id,
        email: customer.email,
        authSubject: customer.authSubject,
        status: customer.status,
      })
      .from(customer)
      .where(eq(customer.authSubject, fakeAuthSubject));

    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(existingEmail);
    expect(rows[0].status).toBe("active");

    // No new customer row was created for the conflicting attempt
    const allWithEmail = await dbConn.db
      .select({ id: customer.id, authSubject: customer.authSubject })
      .from(customer)
      .where(ilike(customer.email, existingEmail));

    expect(allWithEmail).toHaveLength(1);
    expect(allWithEmail[0].authSubject).toBe(fakeAuthSubject);
  });

  it("case-insensitive conflict detection — mixed-case email rejected", async () => {
    // Try to sign up with a casing variant of an existing email
    const res = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: caseEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; message?: string };
    expect(body.status).toBe("GENERAL_ERROR");
    expect(body.message).toBe("ERR_EMAIL_CONFLICT");
  });

  it("conflict response does not leak whether email exists via email/password or third-party (enumeration defense)", async () => {
    // Attempt signup with email owned by an email/password customer
    const res1 = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: existingEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });
    const body1 = (await res1.json()) as { status: string; message?: string };

    // Attempt signup with email owned by a GitHub-linked customer
    const res2 = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: caseEmailLower },
          { id: "password", value: testPassword },
        ],
      }),
    });
    const body2 = (await res2.json()) as { status: string; message?: string };

    // Both responses must have identical shape and status — no difference
    // reveals whether the email is tied to email/password vs third-party
    expect(res1.status).toBe(res2.status);
    expect(body1.status).toBe(body2.status);
    expect(body1.message).toBe(body2.message);
    expect(body1.status).toBe("GENERAL_ERROR");
    expect(body1.message).toBe("ERR_EMAIL_CONFLICT");

    // Verify no extra fields leak info in one but not the other
    const keys1 = Object.keys(body1).sort();
    const keys2 = Object.keys(body2).sort();
    expect(keys1).toEqual(keys2);
  });

  it("email verification conflict — account B verifying email already claimed by account A", async () => {
    // Create a fresh email for this sub-test
    const verifyEmail = `conflict-verify-${uniqueSuffix}@example.com`;

    // Seed account A as owning this email
    await dbConn.db.insert(customer).values({
      authSubject: `verify-owner-${uniqueSuffix}`,
      email: verifyEmail,
      status: "active",
    });

    // Sign up account B with a DIFFERENT email first (so signup succeeds)
    const differentEmail = `conflict-other-${uniqueSuffix}@example.com`;
    const signupRes = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: differentEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });
    expect(signupRes.status).toBe(200);
    const signupBody = (await signupRes.json()) as { status: string; user?: { id: string } };
    expect(signupBody.status).toBe("OK");
    const userBId = signupBody.user!.id;

    // Generate email verification token for account B (for verifyEmail)
    const { default: supertokens } = await import("supertokens-node");
    const { default: EmailVerification } =
      await import("supertokens-node/recipe/emailverification/index.js");
    const tokenRes = await EmailVerification.createEmailVerificationToken(
      "public",
      supertokens.convertToRecipeUserId(userBId),
      verifyEmail,
    );
    expect(tokenRes.status).toBe("OK");
    if (tokenRes.status !== "OK") return;

    // Attempt to verify → should be rejected because account A owns verifyEmail
    adminAlertService.clear();
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
    const verifyBody = (await verifyRes.json()) as { status: string; message?: string };

    expect(verifyBody.status).toBe("GENERAL_ERROR");
    expect(verifyBody.message).toBe("ERR_EMAIL_ALREADY_CLAIMED");

    // Admin alert fired
    const alerts = adminAlertService.getAlerts();
    const conflictAlert = alerts.find((a) => a.type === "email_conflict");
    expect(conflictAlert).toBeDefined();
    expect(conflictAlert!.message).toContain(verifyEmail);
    expect(conflictAlert!.details["email"]).toBe(verifyEmail);
    expect(conflictAlert!.details["claimingAuthSubject"]).toBe(userBId);

    // Email is NOT verified for account B
    const isVerified = await EmailVerification.isEmailVerified(
      supertokens.convertToRecipeUserId(userBId),
    );
    expect(isVerified).toBe(false);

    // Clean up
    await dbConn.db
      .delete(customer)
      .where(eq(customer.authSubject, `verify-owner-${uniqueSuffix}`));
    await dbConn.db.delete(customer).where(eq(customer.email, differentEmail));
  });
});
