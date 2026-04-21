import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GitHubUserFetcher } from "./github.js";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";

describe("GitHub OAuth: link GitHub account (T033, FR-068)", () => {
  let ts_: TestServer;
  let address: string;

  // Configurable mock GitHub user fetcher — tests can swap the returned user.
  // Use Date.now()-based IDs to avoid collisions with data from prior runs.
  let mockGitHubUserId = Date.now();
  let mockGitHubLogin = "testuser";
  const mockGitHubFetcher: GitHubUserFetcher = async () => {
    return { id: mockGitHubUserId, login: mockGitHubLogin };
  };

  beforeAll(async () => {
    ts_ = await createTestServer({
      configOverrides: {
        GITHUB_OAUTH_CLIENT_ID: "test-github-id",
        GITHUB_OAUTH_CLIENT_SECRET: "test-github-secret",
      },
      serverOverrides: { githubUserFetcher: mockGitHubFetcher },
    });
    address = ts_.address;
  });

  afterAll(async () => {
    await stopTestServer(ts_);
  });

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

  it("create customer → link GitHub → verify github_user_id stored", async () => {
    const email = `gh-link-${Date.now()}-a@example.com`;
    const { headers } = await signupAndVerify(email, testPassword);

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

  it("re-linking same GitHub ID is idempotent", async () => {
    const email = `gh-link-${Date.now()}-idem@example.com`;
    const ghId = Date.now() + 1;
    mockGitHubUserId = ghId;
    mockGitHubLogin = "idempotent-user";
    const { headers } = await signupAndVerify(email, testPassword);

    // First link
    const link1 = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });
    expect(link1.status).toBe(200);
    const body1 = (await link1.json()) as {
      customer: { id: string; github_user_id: string };
    };
    expect(body1.customer.github_user_id).toBe(String(ghId));

    // Second link with same GitHub ID → idempotent 200
    const link2 = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });
    expect(link2.status).toBe(200);
    const body2 = (await link2.json()) as {
      customer: { id: string; github_user_id: string };
    };
    expect(body2.customer.github_user_id).toBe(String(ghId));
    expect(body2.customer.id).toBe(body1.customer.id);
  });

  it("linking a GitHub ID already on another account returns 409 ERR_DUPLICATE_LINK", async () => {
    const sharedGhId = Date.now() + 2;
    mockGitHubUserId = sharedGhId;
    mockGitHubLogin = "shared-gh-user";

    // First customer links the GitHub ID
    const email1 = `gh-link-${Date.now()}-dup1@example.com`;
    const { headers: h1 } = await signupAndVerify(email1, testPassword);

    const link1 = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...h1, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });
    expect(link1.status).toBe(200);

    // Second customer tries to link the same GitHub ID → conflict
    const email2 = `gh-link-${Date.now()}-dup2@example.com`;
    const { headers: h2 } = await signupAndVerify(email2, testPassword);

    const link2 = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...h2, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });
    expect(link2.status).toBe(409);
    const body = (await link2.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_DUPLICATE_LINK");
    expect(body.message).toContain("already linked to another customer");
  });

  it("unlink flow: link → unlink → verify githubUserId is null", async () => {
    const ghId = Date.now() + 3;
    mockGitHubUserId = ghId;
    mockGitHubLogin = "unlink-user";
    const email = `gh-link-${Date.now()}-unlink@example.com`;
    const { headers } = await signupAndVerify(email, testPassword);

    // Link
    const linkRes = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });
    expect(linkRes.status).toBe(200);

    // Unlink
    const unlinkRes = await fetch(`${address}/api/customer/link-github`, {
      method: "DELETE",
      headers,
    });
    expect(unlinkRes.status).toBe(200);
    const unlinkBody = (await unlinkRes.json()) as {
      customer: { id: string; github_user_id: string | null };
    };
    expect(unlinkBody.customer.github_user_id).toBeNull();

    // Verify via /api/customer/me
    const meRes = await fetch(`${address}/api/customer/me`, { headers });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      customer: { githubUserId: string | null };
    };
    expect(meBody.customer.githubUserId).toBeNull();
  });

  it("unlink when not linked returns 409 ERR_NOT_LINKED", async () => {
    const email = `gh-link-${Date.now()}-notlinked@example.com`;
    const { headers } = await signupAndVerify(email, testPassword);

    const unlinkRes = await fetch(`${address}/api/customer/link-github`, {
      method: "DELETE",
      headers,
    });
    expect(unlinkRes.status).toBe(409);
    const body = (await unlinkRes.json()) as { error: string };
    expect(body.error).toBe("ERR_NOT_LINKED");
  });

  it("session is preserved across link and unlink", async () => {
    const ghId = Date.now() + 4;
    mockGitHubUserId = ghId;
    mockGitHubLogin = "session-test-user";
    const email = `gh-link-${Date.now()}-session@example.com`;
    const { headers } = await signupAndVerify(email, testPassword);

    // Verify session works before link
    const me1 = await fetch(`${address}/api/customer/me`, { headers });
    expect(me1.status).toBe(200);
    const me1Body = (await me1.json()) as { customer: { email: string } };
    expect(me1Body.customer.email).toBe(email);

    // Link
    const linkRes = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });
    expect(linkRes.status).toBe(200);

    // Session still works after link
    const me2 = await fetch(`${address}/api/customer/me`, { headers });
    expect(me2.status).toBe(200);
    const me2Body = (await me2.json()) as {
      customer: { email: string; githubUserId: string | null };
    };
    expect(me2Body.customer.email).toBe(email);
    expect(me2Body.customer.githubUserId).toBe(String(ghId));

    // Unlink
    const unlinkRes = await fetch(`${address}/api/customer/link-github`, {
      method: "DELETE",
      headers,
    });
    expect(unlinkRes.status).toBe(200);

    // Session still works after unlink
    const me3 = await fetch(`${address}/api/customer/me`, { headers });
    expect(me3.status).toBe(200);
    const me3Body = (await me3.json()) as {
      customer: { email: string; githubUserId: string | null };
    };
    expect(me3Body.customer.email).toBe(email);
    expect(me3Body.customer.githubUserId).toBeNull();
  });

  it("unauthenticated request gets 401", async () => {
    const res = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ code: "mock-auth-code" }),
    });

    expect(res.status).toBe(401);
  });

  it("missing code field gets 400 ERR_VALIDATION", async () => {
    const email = `gh-link-${Date.now()}-nocode@example.com`;
    const { headers } = await signupAndVerify(email, testPassword);

    const res = await fetch(`${address}/api/customer/link-github`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_VALIDATION");
    expect(body.message).toContain("code");
  });
});
