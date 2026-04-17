import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markNotReady, type HealthResponse, type ReadyResponse } from "./server.js";
import { isShuttingDown } from "./shutdown.js";
import type { Config } from "./config.js";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/test",
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "whsec_xxx",
    STRIPE_TAX_ENABLED: false,
    SUPERTOKENS_API_KEY: "test-key",
    SUPERTOKENS_CONNECTION_URI: "http://localhost:3567",
    EASYPOST_API_KEY: "test-key",
    EASYPOST_WEBHOOK_SECRET: "",
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

describe("smoke test: server boots and responds", () => {
  let serverClose: (() => Promise<void>) | undefined;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

  afterEach(async () => {
    if (serverClose) {
      await serverClose();
      serverClose = undefined;
    }
    markNotReady();
    exitSpy.mockClear();
  });

  it("starts server, /health returns 200, /ready returns 503, SIGTERM shuts down cleanly", async () => {
    const fakeProcess = createFakeProcess();
    const config = testConfig();
    const server = await createServer({
      config,
      processRef: fakeProcess as unknown as NodeJS.Process,
    });

    // Start the server on a real port
    const address = await server.start();
    serverClose = async () => {
      await server.app.close();
    };

    // Verify server is listening
    expect(address).toMatch(/^http:\/\//);

    // GET /health — should return 200
    const healthRes = await fetch(`${address}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as HealthResponse;
    expect(healthBody.status).toBe("ok");
    expect(typeof healthBody.uptime).toBe("number");
    expect(healthBody.version).toBe("0.1.0");
    expect(healthBody.dependencies).toEqual({ database: "disconnected" });

    // GET /ready — should return 503 (no DB connected, server not marked ready)
    const readyRes = await fetch(`${address}/ready`);
    expect(readyRes.status).toBe(503);
    const readyBody = (await readyRes.json()) as ReadyResponse;
    expect(readyBody.status).toBe("not_ready");

    // Emit SIGTERM on the fake process — triggers shutdown manager
    fakeProcess.emit("SIGTERM");

    // Wait for async shutdown to complete
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify shutdown was initiated and completed cleanly
    expect(isShuttingDown()).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Server was closed by shutdown hooks
    serverClose = undefined;
  });
});
