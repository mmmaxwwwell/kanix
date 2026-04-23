import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { contributor, contributorDesign } from "./db/schema/contributor.js";
import { product } from "./db/schema/catalog.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

async function signUpUser(address: string, email: string, password: string): Promise<string> {
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
  const body = (await res.json()) as { status: string; user?: { id: string } };
  if (body.status !== "OK" || !body.user) {
    throw new Error(`Signup failed: ${JSON.stringify(body)}`);
  }
  return body.user.id;
}

async function signInAndGetHeaders(
  address: string,
  email: string,
  password: string,
): Promise<Record<string, string>> {
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
  if (res.status !== 200) {
    throw new Error(`Sign-in failed with status ${res.status}`);
  }
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

describe("contributor onboarding + profile (T247)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const adminEmail = `test-contrib-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  // Track IDs for cleanup
  const createdContributorIds: string[] = [];
  const createdDesignIds: string[] = [];
  const createdProductIds: string[] = [];
  let adminUserId = "";
  let adminRoleId = "";

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;

    // Create admin user with super_admin role
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await dbConn.db
      .insert(adminRole)
      .values({
        name: `test_contrib_super_admin_${ts}`,
        description: "Test contributor super admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    adminRoleId = role.id;

    const [user] = await dbConn.db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Contrib Admin",
        status: "active",
      })
      .returning();
    adminUserId = user.id;

    await dbConn.db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });

    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);
  });

  afterAll(async () => {
    try {
      const db = dbConn.db;
      // Clean up in dependency order
      if (createdDesignIds.length > 0) {
        await db.delete(contributorDesign).where(inArray(contributorDesign.id, createdDesignIds));
      }
      if (createdContributorIds.length > 0) {
        await db.delete(contributor).where(inArray(contributor.id, createdContributorIds));
      }
      if (createdProductIds.length > 0) {
        await db.delete(product).where(inArray(product.id, createdProductIds));
      }
      // Clean up admin user/role
      if (adminUserId) {
        await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
        await db.delete(adminUser).where(eq(adminUser.id, adminUserId));
      }
      if (adminRoleId) {
        await db.delete(adminRole).where(eq(adminRole.id, adminRoleId));
      }
    } catch {
      // Cleanup best-effort
    }
    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Contributor signup via GitHub (admin creates contributor)
  // -------------------------------------------------------------------------

  it("creates a contributor via admin POST with CLA version + timestamp", async () => {
    const claDate = "2026-01-15T12:00:00Z";
    const res = await fetch(`${address}/api/admin/contributors`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        github_username: `testuser-${ts}`,
        github_user_id: `gh-${ts}-1`,
        cla_accepted_at: claDate,
        cla_version: "2.0",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { contributor: Record<string, unknown> };
    const contrib = body.contributor;
    createdContributorIds.push(contrib.id as string);

    expect(contrib.githubUsername).toBe(`testuser-${ts}`);
    expect(contrib.githubUserId).toBe(`gh-${ts}-1`);
    expect(contrib.claAcceptedAt).toBe("2026-01-15T12:00:00.000Z");
    expect(contrib.claVersion).toBe("2.0");
    expect(contrib.status).toBe("active");
    expect(contrib.profileVisibility).toBe("public");
    expect(contrib.customerId).toBeNull();
  });

  it("creates a contributor without CLA — status is pending, claVersion is null", async () => {
    const res = await fetch(`${address}/api/admin/contributors`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        github_username: `pending-user-${ts}`,
        github_user_id: `gh-${ts}-2`,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { contributor: Record<string, unknown> };
    const contrib = body.contributor;
    createdContributorIds.push(contrib.id as string);

    expect(contrib.status).toBe("pending");
    expect(contrib.claAcceptedAt).toBeNull();
    expect(contrib.claVersion).toBeNull();
  });

  it("creates a contributor with private profile visibility", async () => {
    const res = await fetch(`${address}/api/admin/contributors`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        github_username: `private-user-${ts}`,
        github_user_id: `gh-${ts}-3`,
        cla_accepted_at: new Date().toISOString(),
        cla_version: "1.0",
        profile_visibility: "private",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { contributor: Record<string, unknown> };
    createdContributorIds.push(body.contributor.id as string);

    expect(body.contributor.profileVisibility).toBe("private");
  });

  // -------------------------------------------------------------------------
  // Admin GET contributor by ID — profile retrieval
  // -------------------------------------------------------------------------

  it("retrieves contributor by ID with all fields", async () => {
    const contribId = createdContributorIds[0];
    const res = await fetch(`${address}/api/admin/contributors/${contribId}`, {
      headers: adminHeaders,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { contributor: Record<string, unknown> };
    expect(body.contributor.id).toBe(contribId);
    expect(body.contributor.githubUsername).toBe(`testuser-${ts}`);
    expect(body.contributor.claVersion).toBe("2.0");
    expect(body.contributor.profileVisibility).toBe("public");
  });

  it("returns 404 for non-existent contributor ID", async () => {
    const res = await fetch(
      `${address}/api/admin/contributors/00000000-0000-0000-0000-000000000000`,
      {
        headers: adminHeaders,
      },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Contributor not found");
  });

  // -------------------------------------------------------------------------
  // Admin list contributors
  // -------------------------------------------------------------------------

  it("lists all contributors", async () => {
    const res = await fetch(`${address}/api/admin/contributors`, {
      headers: adminHeaders,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { contributors: Array<Record<string, unknown>> };
    expect(body.contributors.length).toBeGreaterThanOrEqual(createdContributorIds.length);

    // Verify our created contributors are present
    const ourUsernames = body.contributors
      .filter(
        (c) =>
          typeof c.githubUsername === "string" && (c.githubUsername as string).includes(`${ts}`),
      )
      .map((c) => c.githubUsername);
    expect(ourUsernames).toContain(`testuser-${ts}`);
    expect(ourUsernames).toContain(`pending-user-${ts}`);
    expect(ourUsernames).toContain(`private-user-${ts}`);
  });

  // -------------------------------------------------------------------------
  // Unauthenticated access to admin endpoints returns 401
  // -------------------------------------------------------------------------

  it("unauthenticated request to admin contributor endpoint returns 401", async () => {
    const res = await fetch(`${address}/api/admin/contributors`, {
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Design linking (STL upload flow — contributor designs linked to products)
  // -------------------------------------------------------------------------

  it("links contributor to product design and lists designs", async () => {
    const db = dbConn.db;

    // Create a test product
    const [prod] = await db
      .insert(product)
      .values({
        slug: `contrib-design-test-${ts}`,
        title: `Contributor Design Test ${ts}`,
        status: "active",
      })
      .returning();
    createdProductIds.push(prod.id);

    const contribId = createdContributorIds[0];

    // Link design via admin POST
    const linkRes = await fetch(`${address}/api/admin/contributors/${contribId}/designs`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: prod.id }),
    });

    expect(linkRes.status).toBe(200);
    const linkBody = (await linkRes.json()) as { design: Record<string, unknown> };
    createdDesignIds.push(linkBody.design.id as string);

    expect(linkBody.design.contributorId).toBe(contribId);
    expect(linkBody.design.productId).toBe(prod.id);
    expect(linkBody.design.createdAt).toBeTruthy();

    // List designs via admin GET
    const listRes = await fetch(`${address}/api/admin/contributors/${contribId}/designs`, {
      headers: adminHeaders,
    });

    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { designs: Array<Record<string, unknown>> };
    const ourDesign = listBody.designs.find((d) => d.productId === prod.id);
    expect(ourDesign).toBeDefined();
    expect(ourDesign!.productTitle).toBe(`Contributor Design Test ${ts}`);
    expect(ourDesign!.productSlug).toBe(`contrib-design-test-${ts}`);
  });

  it("linking design to non-existent contributor returns 404", async () => {
    const db = dbConn.db;
    const [prod] = await db
      .insert(product)
      .values({
        slug: `contrib-orphan-test-${ts}`,
        title: `Orphan Test ${ts}`,
        status: "active",
      })
      .returning();
    createdProductIds.push(prod.id);

    const res = await fetch(
      `${address}/api/admin/contributors/00000000-0000-0000-0000-000000000000/designs`,
      {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: prod.id }),
      },
    );

    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // CLA acceptance persists with version + timestamp
  // -------------------------------------------------------------------------

  it("CLA version and timestamp persist through read-back", async () => {
    // Create contributor with specific CLA version
    const claDate = "2026-03-20T08:30:00Z";
    const createRes = await fetch(`${address}/api/admin/contributors`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        github_username: `cla-version-test-${ts}`,
        github_user_id: `gh-${ts}-cla`,
        cla_accepted_at: claDate,
        cla_version: "3.1",
      }),
    });

    expect(createRes.status).toBe(200);
    const createBody = (await createRes.json()) as { contributor: Record<string, unknown> };
    const contribId = createBody.contributor.id as string;
    createdContributorIds.push(contribId);

    // Read back via GET
    const getRes = await fetch(`${address}/api/admin/contributors/${contribId}`, {
      headers: adminHeaders,
    });

    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { contributor: Record<string, unknown> };
    expect(getBody.contributor.claAcceptedAt).toBe("2026-03-20T08:30:00.000Z");
    expect(getBody.contributor.claVersion).toBe("3.1");
  });

  // -------------------------------------------------------------------------
  // Profile visibility setting (public/private)
  // -------------------------------------------------------------------------

  it("updates contributor profile visibility to private", async () => {
    const contribId = createdContributorIds[0]; // testuser with public visibility
    const res = await fetch(`${address}/api/admin/contributors/${contribId}/visibility`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ profile_visibility: "private" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { contributor: Record<string, unknown> };
    expect(body.contributor.profileVisibility).toBe("private");
  });

  it("updates contributor profile visibility back to public", async () => {
    const contribId = createdContributorIds[0];
    const res = await fetch(`${address}/api/admin/contributors/${contribId}/visibility`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ profile_visibility: "public" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { contributor: Record<string, unknown> };
    expect(body.contributor.profileVisibility).toBe("public");
  });

  it("visibility update on non-existent contributor returns 404", async () => {
    const res = await fetch(
      `${address}/api/admin/contributors/00000000-0000-0000-0000-000000000000/visibility`,
      {
        method: "PATCH",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ profile_visibility: "private" }),
      },
    );

    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Public endpoint — visibility respected
  // -------------------------------------------------------------------------

  it("public contributor list only includes public profiles", async () => {
    // At this point: testuser is public, pending-user is public, private-user is private
    const res = await fetch(`${address}/api/contributors/public`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { contributors: Array<Record<string, unknown>> };

    // Filter to our test contributors
    const ourContributors = body.contributors.filter(
      (c) => typeof c.githubUsername === "string" && (c.githubUsername as string).includes(`${ts}`),
    );

    const usernames = ourContributors.map((c) => c.githubUsername);
    expect(usernames).toContain(`testuser-${ts}`);
    expect(usernames).toContain(`pending-user-${ts}`);
    expect(usernames).not.toContain(`private-user-${ts}`);
  });

  it("public profile endpoint returns contributor with designs", async () => {
    const res = await fetch(`${address}/api/contributors/public/testuser-${ts}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contributor: Record<string, unknown>;
      designs: Array<Record<string, unknown>>;
    };

    expect(body.contributor.githubUsername).toBe(`testuser-${ts}`);
    expect(body.contributor.claVersion).toBe("2.0");
    expect(body.contributor.profileVisibility).toBe("public");
    expect(Array.isArray(body.designs)).toBe(true);
    expect(body.designs.length).toBeGreaterThanOrEqual(1);
    expect(body.designs[0].productSlug).toBe(`contrib-design-test-${ts}`);
  });

  it("public profile endpoint returns 404 for private contributor", async () => {
    const res = await fetch(`${address}/api/contributors/public/private-user-${ts}`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Contributor not found");
  });

  it("public profile endpoint returns 404 for non-existent username", async () => {
    const res = await fetch(`${address}/api/contributors/public/nonexistent-user-${ts}`);

    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------

  it("duplicate github_username returns error", async () => {
    const res = await fetch(`${address}/api/admin/contributors`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        github_username: `testuser-${ts}`,
        github_user_id: `gh-${ts}-duplicate`,
        cla_accepted_at: new Date().toISOString(),
        cla_version: "1.0",
      }),
    });

    // Unique constraint violation
    expect(res.status).toBe(500);
  });

  it("duplicate github_user_id returns error", async () => {
    const res = await fetch(`${address}/api/admin/contributors`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        github_username: `unique-username-${ts}`,
        github_user_id: `gh-${ts}-1`,
        cla_accepted_at: new Date().toISOString(),
        cla_version: "1.0",
      }),
    });

    // Unique constraint violation
    expect(res.status).toBe(500);
  });
});
