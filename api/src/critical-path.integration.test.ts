import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  createServer,
  markReady,
  markNotReady,
  type HealthResponse,
  type ReadyResponse,
} from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { findProductBySlug } from "./db/queries/product.js";
import { isShuttingDown } from "./shutdown.js";
import type { Config } from "./config.js";

const DATABASE_URL = process.env["DATABASE_URL"];

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: DATABASE_URL ?? "postgres://localhost/test",
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "whsec_xxx",
    STRIPE_TAX_ENABLED: false,
    SUPERTOKENS_API_KEY: "test-key",
    SUPERTOKENS_CONNECTION_URI: "http://localhost:3567",
    EASYPOST_API_KEY: "test-key",
    GITHUB_OAUTH_CLIENT_ID: "test-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    ...overrides,
  };
}

function createFakeProcess(): EventEmitter {
  return new EventEmitter();
}

// Skip when no database is available
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb("critical path checkpoint (Phase 3)", () => {
  let serverClose: (() => Promise<void>) | undefined;
  let dbConn: DatabaseConnection | undefined;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

  afterEach(async () => {
    if (serverClose) {
      await serverClose();
      serverClose = undefined;
    }
    if (dbConn) {
      await dbConn.close();
      dbConn = undefined;
    }
    markNotReady();
    exitSpy.mockClear();
  });

  it("server boots → /health 200 → /ready 200 (DB connected) → seed data queryable → shuts down cleanly", async () => {
    // 1. Create database connection and server
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const fakeProcess = createFakeProcess();
    const server = createServer({
      config: testConfig(),
      processRef: fakeProcess as unknown as NodeJS.Process,
      database: dbConn,
    });

    // 2. Server boots
    const address = await server.start();
    serverClose = async () => {
      await server.app.close();
    };
    expect(address).toMatch(/^http:\/\//);

    // 3. /health returns 200 with DB connected
    const healthRes = await fetch(`${address}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as HealthResponse;
    expect(healthBody.status).toBe("ok");
    expect(healthBody.dependencies.database).toBe("connected");

    // 4. /ready returns 200 (DB connected, server marked ready)
    markReady();
    const readyRes = await fetch(`${address}/ready`);
    expect(readyRes.status).toBe(200);
    const readyBody = (await readyRes.json()) as ReadyResponse;
    expect(readyBody.status).toBe("ready");

    // 5. Seed data queryable via Drizzle — verify seeded products exist
    const basePlate = await findProductBySlug(dbConn.db, "base-plate-100");
    expect(basePlate).toBeDefined();
    expect(basePlate?.title).toBeTruthy();
    expect(basePlate?.status).toBe("active");

    const hingeMod = await findProductBySlug(dbConn.db, "hinge-module");
    expect(hingeMod).toBeDefined();

    const driveBelt = await findProductBySlug(dbConn.db, "drive-belt-gt2");
    expect(driveBelt).toBeDefined();

    // 6. Server shuts down cleanly via SIGTERM
    fakeProcess.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(isShuttingDown()).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Server was closed by shutdown hooks — no manual close needed
    serverClose = undefined;
    // DB was closed by shutdown hooks — no manual close needed
    dbConn = undefined;
  });
});
