import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markNotReady } from "./server.js";
import type { Config } from "./config.js";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/test",
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "whsec_xxx",
    PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_xxx",
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

function createFakeProcess(): NodeJS.Process {
  return new EventEmitter() as unknown as NodeJS.Process;
}

describe("security middleware", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
    markNotReady();
  });

  async function startServer(configOverrides: Partial<Config> = {}) {
    const config = testConfig(configOverrides);
    const { app } = await createServer({
      config,
      processRef: createFakeProcess(),
    });

    await app.ready();
    cleanup = async () => {
      await app.close();
    };

    return { app };
  }

  // -------------------------------------------------------------------------
  // CORS
  // -------------------------------------------------------------------------

  describe("CORS", () => {
    it("allows requests from allowed origins", async () => {
      const { app } = await startServer({
        CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
      });

      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://localhost:3000" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    });

    it("rejects requests from non-allowed origins with 403", async () => {
      const { app } = await startServer({
        CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
      });

      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://evil.example.com" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("handles preflight OPTIONS requests for allowed origins", async () => {
      const { app } = await startServer({
        CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
      });

      const response = await app.inject({
        method: "OPTIONS",
        url: "/health",
        headers: { origin: "http://localhost:3000" },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
      expect(response.headers["access-control-allow-methods"]).toContain("GET");
      expect(response.headers["access-control-allow-headers"]).toContain("Content-Type");
    });

    it("rejects preflight OPTIONS from non-allowed origins with 403", async () => {
      const { app } = await startServer({
        CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
      });

      const response = await app.inject({
        method: "OPTIONS",
        url: "/health",
        headers: { origin: "http://evil.example.com" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("does not use wildcard for Access-Control-Allow-Origin", async () => {
      const { app } = await startServer({
        CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
      });

      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://localhost:3000" },
      });

      expect(response.headers["access-control-allow-origin"]).not.toBe("*");
    });

    it("allows requests with no Origin header (same-origin / non-browser)", async () => {
      const { app } = await startServer({
        CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
      });

      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
    });

    it("supports multiple allowed origins", async () => {
      const { app } = await startServer({
        CORS_ALLOWED_ORIGINS: ["http://localhost:3000", "https://kanix.example.com"],
      });

      const r1 = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://localhost:3000" },
      });
      expect(r1.statusCode).toBe(200);
      expect(r1.headers["access-control-allow-origin"]).toBe("http://localhost:3000");

      const r2 = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "https://kanix.example.com" },
      });
      expect(r2.statusCode).toBe(200);
      expect(r2.headers["access-control-allow-origin"]).toBe("https://kanix.example.com");
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe("rate limiting", () => {
    it("includes rate limit headers on every response", async () => {
      const { app } = await startServer({ RATE_LIMIT_MAX: 10 });

      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-ratelimit-limit"]).toBe("10");
      expect(response.headers["x-ratelimit-remaining"]).toBe("9");
      expect(response.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("decrements remaining count on each request", async () => {
      const { app } = await startServer({ RATE_LIMIT_MAX: 5 });

      const r1 = await app.inject({ method: "GET", url: "/health" });
      expect(r1.headers["x-ratelimit-remaining"]).toBe("4");

      const r2 = await app.inject({ method: "GET", url: "/health" });
      expect(r2.headers["x-ratelimit-remaining"]).toBe("3");

      const r3 = await app.inject({ method: "GET", url: "/health" });
      expect(r3.headers["x-ratelimit-remaining"]).toBe("2");
    });

    it("returns 429 with Retry-After when limit is exceeded", async () => {
      const { app } = await startServer({ RATE_LIMIT_MAX: 2, RATE_LIMIT_WINDOW_MS: 60000 });

      // Use up the limit
      await app.inject({ method: "GET", url: "/health" });
      await app.inject({ method: "GET", url: "/health" });

      // Third request should be rate limited
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBeDefined();
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      expect(response.headers["x-ratelimit-remaining"]).toBe("0");

      const body = response.json();
      expect(body.error).toBe("Rate limit exceeded");
    });
  });

  // -------------------------------------------------------------------------
  // Security headers
  // -------------------------------------------------------------------------

  describe("security headers", () => {
    it("includes Strict-Transport-Security header", async () => {
      const { app } = await startServer();

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.headers["strict-transport-security"]).toContain("max-age=");
      expect(response.headers["strict-transport-security"]).toContain("includeSubDomains");
    });

    it("includes Content-Security-Policy header", async () => {
      const { app } = await startServer();

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.headers["content-security-policy"]).toContain("default-src");
    });

    it("includes X-Content-Type-Options: nosniff", async () => {
      const { app } = await startServer();

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("includes X-Frame-Options: DENY", async () => {
      const { app } = await startServer();

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.headers["x-frame-options"]).toBe("DENY");
    });

    it("includes Referrer-Policy: strict-origin-when-cross-origin", async () => {
      const { app } = await startServer();

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    });

    it("includes all security headers on every response", async () => {
      const { app } = await startServer();

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.headers["strict-transport-security"]).toBeDefined();
      expect(response.headers["content-security-policy"]).toBeDefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    });
  });
});
