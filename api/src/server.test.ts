import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  createServer,
  markReady,
  markNotReady,
  type HealthResponse,
  type ReadyResponse,
} from "./server.js";
import type { Config } from "./config.js";
import type { DatabaseConnection } from "./db/connection.js";

/** Minimal config for testing — secrets don't matter for server skeleton. */
function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0, // Let the OS pick an available port
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/test",
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

/** Creates a fake process to avoid registering signal handlers on the real process. */
function createFakeProcess(): NodeJS.Process {
  return new EventEmitter() as unknown as NodeJS.Process;
}

/** Creates a fake database connection where SELECT 1 always succeeds. */
function createFakeDatabase(): DatabaseConnection {
  return {
    db: {
      execute: async () => [{ "?column?": 1 }],
    } as unknown as DatabaseConnection["db"],
    sql: {} as unknown as DatabaseConnection["sql"],
    async close() {},
  };
}

describe("server", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
    markNotReady();
  });

  async function startServer(configOverrides: Partial<Config> = {}, database?: DatabaseConnection) {
    const config = testConfig(configOverrides);
    const { app, shutdownManager } = await createServer({
      config,
      processRef: createFakeProcess(),
      database,
    });

    await app.ready();
    cleanup = async () => {
      await app.close();
    };

    return { app, shutdownManager };
  }

  describe("GET /health", () => {
    it("returns 200 with health status", async () => {
      const { app } = await startServer();

      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);

      const body = response.json<HealthResponse>();
      expect(body.status).toBe("ok");
      expect(typeof body.uptime).toBe("number");
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(body.version).toBe("0.1.0");
      expect(typeof body.ready).toBe("boolean");
      expect(body.dependencies).toEqual({
        database: "disconnected",
      });
    });

    it("reports ready: true when server is marked ready", async () => {
      const { app } = await startServer();
      markReady();

      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      const body = response.json<HealthResponse>();
      expect(body.ready).toBe(true);
    });

    it("reports ready: false when server is not marked ready", async () => {
      const { app } = await startServer();
      markNotReady();

      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      const body = response.json<HealthResponse>();
      expect(body.ready).toBe(false);
    });
  });

  describe("GET /ready", () => {
    it("returns 503 when not ready (no DB)", async () => {
      const { app } = await startServer();

      const response = await app.inject({
        method: "GET",
        url: "/ready",
      });

      expect(response.statusCode).toBe(503);

      const body = response.json<ReadyResponse>();
      expect(body.status).toBe("not_ready");
    });

    it("returns 503 with database down when marked ready but no DB connection", async () => {
      const { app } = await startServer();
      markReady();

      const response = await app.inject({
        method: "GET",
        url: "/ready",
      });

      expect(response.statusCode).toBe(503);

      const body = response.json<ReadyResponse>();
      expect(body.status).toBe("not_ready");
      expect(body.dependencies).toEqual({ database: "down" });
    });

    it("returns 200 when marked ready and DB is connected", async () => {
      const { app } = await startServer({}, createFakeDatabase());
      markReady();

      const response = await app.inject({
        method: "GET",
        url: "/ready",
      });

      expect(response.statusCode).toBe(200);

      const body = response.json<ReadyResponse>();
      expect(body.status).toBe("ready");
    });
  });

  describe("server boot", () => {
    it("boots on configured PORT", async () => {
      const config = testConfig();
      const server = await createServer({ config, processRef: createFakeProcess() });
      const address = await server.start();
      cleanup = async () => {
        await server.app.close();
      };

      expect(address).toMatch(/http:\/\//);
    });
  });
});
