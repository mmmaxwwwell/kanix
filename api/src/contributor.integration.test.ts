import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { eq } from "drizzle-orm";
import { contributor, contributorDesign } from "./db/schema/contributor.js";
import { product } from "./db/schema/catalog.js";
import {
  createContributor,
  findContributorById,
  listContributors,
  linkContributorDesign,
  listDesignsByContributor,
} from "./db/queries/contributor.js";

const DATABASE_URL = process.env["DATABASE_URL"];

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("contributor registry + design linking (T067)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now();
  let productId = "";
  let productId2 = "";

  // Track created IDs for cleanup
  const createdContributorIds: string[] = [];
  const createdDesignIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

    // Create test products
    const [prod1] = await db
      .insert(product)
      .values({
        slug: `contrib-test-prod1-${ts}`,
        title: `Contributor Test Product 1 ${ts}`,
        status: "active",
      })
      .returning();
    productId = prod1.id;

    const [prod2] = await db
      .insert(product)
      .values({
        slug: `contrib-test-prod2-${ts}`,
        title: `Contributor Test Product 2 ${ts}`,
        status: "active",
      })
      .returning();
    productId2 = prod2.id;
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      // Clean up in dependency order
      for (const id of createdDesignIds) {
        await db.delete(contributorDesign).where(eq(contributorDesign.id, id));
      }
      for (const id of createdContributorIds) {
        await db.delete(contributor).where(eq(contributor.id, id));
      }
      // Clean up test products
      await db.delete(product).where(eq(product.slug, `contrib-test-prod1-${ts}`));
      await db.delete(product).where(eq(product.slug, `contrib-test-prod2-${ts}`));
      await dbConn.close();
    }
  });

  it("creates a contributor with CLA data", async () => {
    const db = dbConn.db;
    const claDate = new Date("2026-01-15T12:00:00Z");

    const contrib = await createContributor(db, {
      githubUsername: `testuser-${ts}`,
      githubUserId: `gh-${ts}-1`,
      claAcceptedAt: claDate,
    });

    createdContributorIds.push(contrib.id);

    expect(contrib.id).toBeTruthy();
    expect(contrib.githubUsername).toBe(`testuser-${ts}`);
    expect(contrib.githubUserId).toBe(`gh-${ts}-1`);
    expect(contrib.customerId).toBeNull();
    expect(contrib.claAcceptedAt).toEqual(claDate);
    expect(contrib.status).toBe("active");
  });

  it("creates a contributor without CLA (pending status)", async () => {
    const db = dbConn.db;

    const contrib = await createContributor(db, {
      githubUsername: `pending-user-${ts}`,
      githubUserId: `gh-${ts}-2`,
    });

    createdContributorIds.push(contrib.id);

    expect(contrib.status).toBe("pending");
    expect(contrib.claAcceptedAt).toBeNull();
  });

  it("finds contributor by ID", async () => {
    const db = dbConn.db;

    const contrib = await createContributor(db, {
      githubUsername: `findme-${ts}`,
      githubUserId: `gh-${ts}-3`,
      claAcceptedAt: new Date(),
    });
    createdContributorIds.push(contrib.id);

    const found = await findContributorById(db, contrib.id);
    expect(found).not.toBeNull();
    expect(found?.githubUsername).toBe(`findme-${ts}`);
  });

  it("returns null for non-existent contributor", async () => {
    const db = dbConn.db;
    const found = await findContributorById(db, "00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });

  it("lists all contributors", async () => {
    const db = dbConn.db;
    const contributors = await listContributors(db);
    expect(contributors.length).toBeGreaterThanOrEqual(createdContributorIds.length);
  });

  it("links contributor to product and verifies association", async () => {
    const db = dbConn.db;

    // Create contributor
    const contrib = await createContributor(db, {
      githubUsername: `designer-${ts}`,
      githubUserId: `gh-${ts}-4`,
      claAcceptedAt: new Date(),
    });
    createdContributorIds.push(contrib.id);

    // Link to product 1
    const design1 = await linkContributorDesign(db, {
      contributorId: contrib.id,
      productId: productId,
    });
    createdDesignIds.push(design1.id);

    expect(design1.contributorId).toBe(contrib.id);
    expect(design1.productId).toBe(productId);
    expect(design1.createdAt).toBeTruthy();

    // Link to product 2
    const design2 = await linkContributorDesign(db, {
      contributorId: contrib.id,
      productId: productId2,
    });
    createdDesignIds.push(design2.id);

    // List designs for contributor
    const designs = await listDesignsByContributor(db, contrib.id);
    expect(designs.length).toBe(2);

    // Verify product info is joined
    const prodSlugs = designs.map((d) => d.productSlug);
    expect(prodSlugs).toContain(`contrib-test-prod1-${ts}`);
    expect(prodSlugs).toContain(`contrib-test-prod2-${ts}`);

    // Verify product titles are joined
    const prodTitles = designs.map((d) => d.productTitle);
    expect(prodTitles).toContain(`Contributor Test Product 1 ${ts}`);
    expect(prodTitles).toContain(`Contributor Test Product 2 ${ts}`);
  });

  it("returns empty designs list for contributor with no designs", async () => {
    const db = dbConn.db;

    const contrib = await createContributor(db, {
      githubUsername: `no-designs-${ts}`,
      githubUserId: `gh-${ts}-5`,
      claAcceptedAt: new Date(),
    });
    createdContributorIds.push(contrib.id);

    const designs = await listDesignsByContributor(db, contrib.id);
    expect(designs).toEqual([]);
  });

  it("creates contributor with optional customer_id", async () => {
    const db = dbConn.db;

    // customer_id is nullable and references customer table,
    // so we pass null to verify nullable behavior
    const contrib = await createContributor(db, {
      githubUsername: `with-customer-${ts}`,
      githubUserId: `gh-${ts}-6`,
      customerId: null,
      claAcceptedAt: new Date(),
    });
    createdContributorIds.push(contrib.id);

    expect(contrib.customerId).toBeNull();
  });
});
