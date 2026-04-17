import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "./server.js";
import type { Config } from "./config.js";
import type { ValidationErrorResponse } from "./validation.js";

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

// JSON schema for a test route used in these integration tests
const testBodySchema = {
  type: "object" as const,
  required: ["name", "age"],
  additionalProperties: false,
  properties: {
    name: { type: "string" as const },
    age: { type: "integer" as const },
  },
};

describe("JSON schema validation plugin", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function startServer() {
    const config = testConfig();
    const { app } = await createServer({
      config,
      processRef: createFakeProcess(),
    });

    // Register a test route that uses JSON schema validation
    app.post(
      "/test-validation",
      {
        schema: {
          body: testBodySchema,
        },
      },
      async (request) => {
        return { received: request.body };
      },
    );

    await app.ready();
    cleanup = async () => {
      await app.close();
    };

    return app;
  }

  it("accepts a valid request body", async () => {
    const app = await startServer();

    const response = await app.inject({
      method: "POST",
      url: "/test-validation",
      headers: { origin: "http://localhost:3000" },
      payload: { name: "Alice", age: 30 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.received).toEqual({ name: "Alice", age: 30 });
  });

  it("rejects missing required field with 400 and structured error", async () => {
    const app = await startServer();

    const response = await app.inject({
      method: "POST",
      url: "/test-validation",
      headers: { origin: "http://localhost:3000" },
      payload: { name: "Alice" }, // missing "age"
    });

    expect(response.statusCode).toBe(400);

    const body = response.json<ValidationErrorResponse>();
    expect(body.error).toBe("validation_failed");
    expect(body.details).toBeInstanceOf(Array);
    expect(body.details.length).toBeGreaterThanOrEqual(1);

    const ageError = body.details.find((d) => d.field === "age");
    expect(ageError).toBeDefined();
    expect(ageError?.message).toMatch(/required/i);
  });

  it("rejects wrong type with 400 and structured error", async () => {
    const app = await startServer();

    const response = await app.inject({
      method: "POST",
      url: "/test-validation",
      headers: { origin: "http://localhost:3000" },
      payload: { name: "Alice", age: "not-a-number" },
    });

    expect(response.statusCode).toBe(400);

    const body = response.json<ValidationErrorResponse>();
    expect(body.error).toBe("validation_failed");
    expect(body.details).toBeInstanceOf(Array);
    expect(body.details.length).toBeGreaterThanOrEqual(1);

    const ageError = body.details.find((d) => d.field === "age");
    expect(ageError).toBeDefined();
    expect(ageError?.message).toMatch(/integer/i);
  });

  it("strips extra fields from request body", async () => {
    const app = await startServer();

    const response = await app.inject({
      method: "POST",
      url: "/test-validation",
      headers: { origin: "http://localhost:3000" },
      payload: { name: "Alice", age: 30, extraField: "should-be-stripped" },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.received).toEqual({ name: "Alice", age: 30 });
    expect(body.received).not.toHaveProperty("extraField");
  });
});
