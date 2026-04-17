import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./connection.js";
import { checkDatabaseConnectivity } from "./queries/health.js";
import { insertProduct, findProductById } from "./queries/product.js";

const DATABASE_URL = process.env["DATABASE_URL"];

// Skip integration tests when no database is available
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb("Database integration", () => {
  let conn: DatabaseConnection;

  beforeAll(() => {
    conn = createDatabaseConnection(DATABASE_URL ?? "");
  });

  afterAll(async () => {
    await conn.close();
  });

  it("SELECT 1 succeeds via Drizzle", async () => {
    const ok = await checkDatabaseConnectivity(conn.db);
    expect(ok).toBe(true);
  });

  it("inserts and reads a product row with type safety", async () => {
    const slug = `test-product-${Date.now()}`;
    const inserted = await insertProduct(conn.db, {
      slug,
      title: "Test Product",
      description: "A test product for integration testing",
      status: "draft",
    });

    expect(inserted.id).toBeDefined();
    expect(inserted.slug).toBe(slug);
    expect(inserted.title).toBe("Test Product");
    expect(inserted.status).toBe("draft");
    expect(inserted.createdAt).toBeInstanceOf(Date);

    const found = await findProductById(conn.db, inserted.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(inserted.id);
    expect(found?.slug).toBe(slug);
    expect(found?.title).toBe("Test Product");

    // Clean up
    await conn.sql`DELETE FROM product WHERE id = ${inserted.id}`;
  });
});
