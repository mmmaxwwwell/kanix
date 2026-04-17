import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "./server.js";
import type { Config } from "./config.js";
import { ValidationError, NotFoundError, ConflictError, InternalError } from "./errors.js";
import type { AppErrorResponse } from "./error-handler.js";

/** Minimal config for testing. */
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
    GITHUB_OAUTH_CLIENT_ID: "test-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    ...overrides,
  };
}

function createFakeProcess(): NodeJS.Process {
  return new EventEmitter() as unknown as NodeJS.Process;
}

describe("global error handler", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function startServer() {
    const config = testConfig();
    const { app } = createServer({
      config,
      processRef: createFakeProcess(),
    });

    // Route that throws a ValidationError (AppError subclass)
    app.get("/throw-validation", async () => {
      throw new ValidationError("Name is required", "ERR_NAME_REQUIRED");
    });

    // Route that throws a NotFoundError (AppError subclass)
    app.get("/throw-not-found", async () => {
      throw new NotFoundError("Order not found", "ERR_ORDER_NOT_FOUND");
    });

    // Route that throws a ConflictError (AppError subclass)
    app.get("/throw-conflict", async () => {
      throw new ConflictError("Email already exists", "ERR_EMAIL_CONFLICT");
    });

    // Route that throws an InternalError (AppError subclass, userFacing=false)
    app.get("/throw-internal", async () => {
      throw new InternalError("DB connection lost");
    });

    // Route that throws an unknown/unexpected error
    app.get("/throw-unknown", async () => {
      throw new Error("something broke unexpectedly");
    });

    await app.ready();
    cleanup = async () => {
      await app.close();
    };

    return app;
  }

  it("returns 400 for ValidationError with correct error code", async () => {
    const app = await startServer();

    const response = await app.inject({
      method: "GET",
      url: "/throw-validation",
      headers: { origin: "http://localhost:3000" },
    });

    expect(response.statusCode).toBe(400);

    const body = response.json<AppErrorResponse>();
    expect(body.error).toBe("ERR_NAME_REQUIRED");
    expect(body.message).toBe("Name is required");
  });

  it("returns 404 for NotFoundError with correct error code", async () => {
    const app = await startServer();

    const response = await app.inject({
      method: "GET",
      url: "/throw-not-found",
      headers: { origin: "http://localhost:3000" },
    });

    expect(response.statusCode).toBe(404);

    const body = response.json<AppErrorResponse>();
    expect(body.error).toBe("ERR_ORDER_NOT_FOUND");
    expect(body.message).toBe("Order not found");
  });

  it("returns 409 for ConflictError with correct error code", async () => {
    const app = await startServer();

    const response = await app.inject({
      method: "GET",
      url: "/throw-conflict",
      headers: { origin: "http://localhost:3000" },
    });

    expect(response.statusCode).toBe(409);

    const body = response.json<AppErrorResponse>();
    expect(body.error).toBe("ERR_EMAIL_CONFLICT");
    expect(body.message).toBe("Email already exists");
  });

  it("returns 500 for InternalError and hides internal message", async () => {
    const app = await startServer();

    const response = await app.inject({
      method: "GET",
      url: "/throw-internal",
      headers: { origin: "http://localhost:3000" },
    });

    expect(response.statusCode).toBe(500);

    const body = response.json<AppErrorResponse>();
    expect(body.error).toBe("ERR_INTERNAL");
    // userFacing=false → generic message, no stack leak
    expect(body.message).toBe("Internal server error");
    expect(body.message).not.toContain("DB connection lost");
  });

  it("returns 500 for unknown errors with generic message (no stack leak)", async () => {
    const app = await startServer();

    const response = await app.inject({
      method: "GET",
      url: "/throw-unknown",
      headers: { origin: "http://localhost:3000" },
    });

    expect(response.statusCode).toBe(500);

    const body = response.json<AppErrorResponse>();
    expect(body.error).toBe("ERR_INTERNAL");
    expect(body.message).toBe("Internal server error");
    // Must not leak the actual error message or stack
    expect(body.message).not.toContain("something broke");
    expect(JSON.stringify(body)).not.toContain("stack");
  });
});
