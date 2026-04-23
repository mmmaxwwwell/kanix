import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./connection.js";
import { checkDatabaseConnectivity } from "./queries/health.js";
import {
  insertProduct,
  findProductById,
  findProductBySlug,
  findAllProducts,
} from "./queries/product.js";
import { requireDatabaseUrl } from "../test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("Database integration", () => {
  let conn: DatabaseConnection;

  beforeAll(() => {
    conn = createDatabaseConnection(DATABASE_URL);
  });

  afterAll(async () => {
    await conn.close();
  });

  describe("connection lifecycle", () => {
    it("SELECT 1 succeeds via Drizzle", async () => {
      const ok = await checkDatabaseConnectivity(conn.db);
      expect(ok).toBe(true);
    });

    it("raw sql template tag executes queries", async () => {
      const rows = await conn.sql`SELECT current_database() AS db_name`;
      expect(rows).toHaveLength(1);
      expect(typeof rows[0].db_name).toBe("string");
      expect(rows[0].db_name.length).toBeGreaterThan(0);
    });

    it("close() renders the connection unusable", async () => {
      const tempConn = createDatabaseConnection(DATABASE_URL);
      const ok = await checkDatabaseConnectivity(tempConn.db);
      expect(ok).toBe(true);

      await tempConn.close();

      // After close, raw queries should fail
      await expect(tempConn.sql`SELECT 1`).rejects.toThrow();
    });
  });

  describe("connection failure", () => {
    it("bad URL throws on first query — not silent", async () => {
      const badConn = createDatabaseConnection(
        "postgres://invalid:invalid@localhost:59999/nonexistent",
      );

      const ok = await checkDatabaseConnectivity(badConn.db);
      expect(ok).toBe(false);

      // Raw query should throw, not swallow the error
      await expect(badConn.sql`SELECT 1`).rejects.toThrow();

      // Clean up — end() is safe even on a never-connected socket
      await badConn.close().catch(() => {});
    });
  });

  describe("product query helpers", () => {
    it("inserts and reads a product row with concrete value assertions", async () => {
      const slug = `test-product-${Date.now()}`;
      const inserted = await insertProduct(conn.db, {
        slug,
        title: "Test Product",
        description: "A test product for integration testing",
        status: "draft",
      });

      // Concrete assertions — no toBeDefined()
      expect(typeof inserted.id).toBe("string");
      expect(inserted.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(inserted.slug).toBe(slug);
      expect(inserted.title).toBe("Test Product");
      expect(inserted.description).toBe("A test product for integration testing");
      expect(inserted.status).toBe("draft");
      expect(inserted.createdAt).toBeInstanceOf(Date);
      expect(inserted.updatedAt).toBeInstanceOf(Date);
      expect(inserted.createdAt.getTime()).toBeLessThanOrEqual(Date.now());

      // findProductById returns the same row with matching fields
      const found = await findProductById(conn.db, inserted.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
      expect(found!.slug).toBe(slug);
      expect(found!.title).toBe("Test Product");
      expect(found!.description).toBe("A test product for integration testing");
      expect(found!.status).toBe("draft");
      expect(found!.createdAt).toBeInstanceOf(Date);

      // Clean up
      await conn.sql`DELETE FROM product WHERE id = ${inserted.id}`;
    });

    it("findProductBySlug returns the correct product", async () => {
      const slug = `slug-lookup-${Date.now()}`;
      const inserted = await insertProduct(conn.db, {
        slug,
        title: "Slug Lookup Product",
        status: "draft",
      });

      const found = await findProductBySlug(conn.db, slug);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
      expect(found!.slug).toBe(slug);
      expect(found!.title).toBe("Slug Lookup Product");

      // Non-existent slug returns undefined
      const missing = await findProductBySlug(conn.db, "no-such-slug-ever");
      expect(missing).toBeUndefined();

      await conn.sql`DELETE FROM product WHERE id = ${inserted.id}`;
    });

    it("findProductById returns undefined for non-existent id", async () => {
      const missing = await findProductById(conn.db, "00000000-0000-0000-0000-000000000000");
      expect(missing).toBeUndefined();
    });

    it("findAllProducts returns an array including inserted rows", async () => {
      const slug = `all-products-${Date.now()}`;
      const inserted = await insertProduct(conn.db, {
        slug,
        title: "All Products Test",
        status: "draft",
      });

      const all = await findAllProducts(conn.db);
      expect(Array.isArray(all)).toBe(true);
      expect(all.length).toBeGreaterThanOrEqual(1);

      const match = all.find((p) => p.id === inserted.id);
      expect(match).not.toBeUndefined();
      expect(match!.slug).toBe(slug);
      expect(match!.title).toBe("All Products Test");

      await conn.sql`DELETE FROM product WHERE id = ${inserted.id}`;
    });
  });
});
