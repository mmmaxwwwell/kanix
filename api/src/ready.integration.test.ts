import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady, type ReadyResponse } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
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

// Skip integration tests when no database is available
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb("/ready endpoint with Postgres connectivity", () => {
  let serverClose: (() => Promise<void>) | undefined;
  let dbConn: DatabaseConnection | undefined;
  vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

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
  });

  it("returns 200 when Postgres is connected", async () => {
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const fakeProcess = createFakeProcess();
    const server = await createServer({
      config: testConfig(),
      processRef: fakeProcess as unknown as NodeJS.Process,
      database: dbConn,
    });

    const address = await server.start();
    serverClose = async () => {
      await server.app.close();
    };
    markReady();

    const res = await fetch(`${address}/ready`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as ReadyResponse;
    expect(body.status).toBe("ready");
  });

  it("returns 503 with {dependencies: {database: 'down'}} when Postgres is unreachable", async () => {
    // Create a connection to a bogus URL that will fail connectivity checks
    dbConn = createDatabaseConnection("postgres://localhost:19999/nonexistent");
    const fakeProcess = createFakeProcess();
    const server = await createServer({
      config: testConfig(),
      processRef: fakeProcess as unknown as NodeJS.Process,
      database: dbConn,
    });

    const address = await server.start();
    serverClose = async () => {
      await server.app.close();
    };
    markReady();

    const res = await fetch(`${address}/ready`);
    expect(res.status).toBe(503);

    const body = (await res.json()) as ReadyResponse;
    expect(body.status).toBe("not_ready");
    expect(body.dependencies).toEqual({ database: "down" });
  });
});
