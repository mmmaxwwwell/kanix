import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
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

describe("duplicate email verification conflict detection (T054e)", () => {
  let server: ServerInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminAlertService: AdminAlertService;

  // Unique email per test run
  const sharedEmail = `conflict-${Date.now()}@example.com`;
  const testPassword = "TestPassword123!";
  const fakeAuthSubject = `fake-auth-subject-${Date.now()}`;

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
  });

  afterAll(async () => {
    markNotReady();
    if (dbConn) {
      // Clean up seeded customer and signup customer
      await dbConn.db.delete(customer).where(eq(customer.email, sharedEmail));
      await dbConn.db.delete(customer).where(eq(customer.authSubject, fakeAuthSubject));
    }
    if (server) await server.app.close();
    if (dbConn) await dbConn.close();
  });

  it("account A verifies email → account B attempts same email → rejected with ERR_EMAIL_ALREADY_CLAIMED", async function () {
    // Step 1: Seed customer A directly in DB with sharedEmail (simulates an
    // already-verified account owning this email via a different auth method)
    await dbConn.db.insert(customer).values({
      authSubject: fakeAuthSubject,
      email: sharedEmail,
      status: "active",
    });

    // Step 2: Sign up account B via SuperTokens with the same email
    const signupRes = await fetch(`${address}/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        formFields: [
          { id: "email", value: sharedEmail },
          { id: "password", value: testPassword },
        ],
      }),
    });
    expect(signupRes.status).toBe(200);
    const signupBody = (await signupRes.json()) as { status: string; user: { id: string } };
    expect(signupBody.status).toBe("OK");
    const userBId = signupBody.user.id;

    // Step 3: Generate email verification token for account B
    const { default: supertokens } = await import("supertokens-node");
    const { default: EmailVerification } =
      await import("supertokens-node/recipe/emailverification/index.js");
    const tokenRes = await EmailVerification.createEmailVerificationToken(
      "public",
      supertokens.convertToRecipeUserId(userBId),
    );
    expect(tokenRes.status).toBe("OK");
    if (tokenRes.status !== "OK") return;

    // Step 4: Attempt to verify account B's email → should be rejected
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

    // SuperTokens returns GENERAL_ERROR with our message
    expect(verifyBody.status).toBe("GENERAL_ERROR");
    expect(verifyBody.message).toBe("ERR_EMAIL_ALREADY_CLAIMED");

    // Step 5: Verify admin alert was created
    const alerts = adminAlertService.getAlerts();
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const conflictAlert = alerts.find((a) => a.type === "email_conflict");
    expect(conflictAlert).toBeDefined();
    if (!conflictAlert) return; // guard for TS — expect above ensures this
    expect(conflictAlert.message).toContain(sharedEmail);
    expect(conflictAlert.details["email"]).toBe(sharedEmail);
    expect(conflictAlert.details["claimingAuthSubject"]).toBe(userBId);

    // Step 6: Verify the email is NOT verified for account B (was unverified)
    const isVerified = await EmailVerification.isEmailVerified(
      supertokens.convertToRecipeUserId(userBId),
    );
    expect(isVerified).toBe(false);
  });
});
