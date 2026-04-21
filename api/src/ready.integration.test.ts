import { describe, it, expect, afterEach, vi, beforeAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, markReady, markNotReady, type ReadyResponse } from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import type { Config } from "./config.js";
import { requireDatabaseUrl, getSuperTokensUri, assertSuperTokensUp } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();
const SUPERTOKENS_URI = getSuperTokensUri();

beforeAll(async () => {
  await assertSuperTokensUp();
});

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL: DATABASE_URL,
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "whsec_xxx",
    PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_xxx",
    STRIPE_TAX_ENABLED: false,
    SUPERTOKENS_API_KEY: "test-key",
    SUPERTOKENS_CONNECTION_URI: SUPERTOKENS_URI,
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

describe("/ready endpoint with Postgres and SuperTokens connectivity", () => {
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

  it("returns 503 before markReady() is called (not-ready at startup)", async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
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
    // Do NOT call markReady() — simulates pre-startup state

    const res = await fetch(`${address}/ready`);
    expect(res.status).toBe(503);

    const body = (await res.json()) as ReadyResponse;
    expect(body.status).toBe("not_ready");
    // When not ready, the endpoint short-circuits without dependency checks
    expect(body.dependencies).toBeUndefined();
  });

  it("returns 200 with status 'ready' when Postgres and SuperTokens are connected", async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
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

  it("returns 503 with database 'down' when Postgres is unreachable", async () => {
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
    expect(body.dependencies).toBeDefined();
    expect(body.dependencies!.database).toBe("down");
    // SuperTokens may or may not be up — the important thing is that
    // database failure produces a 503 with correct shape
    expect(typeof body.dependencies!.supertokens).toBe("string");
    expect(["up", "down"]).toContain(body.dependencies!.supertokens);
  });

  it("returns 503 with supertokens 'down' when SuperTokens is unreachable", async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const fakeProcess = createFakeProcess();
    const server = await createServer({
      config: testConfig({
        SUPERTOKENS_CONNECTION_URI: "http://localhost:19999",
      }),
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
    expect(body.dependencies).toBeDefined();
    expect(body.dependencies!.supertokens).toBe("down");
    expect(body.dependencies!.database).toBe("up");
  });

  it("returns 503 when both Postgres and SuperTokens are unreachable", async () => {
    dbConn = createDatabaseConnection("postgres://localhost:19999/nonexistent");
    const fakeProcess = createFakeProcess();
    const server = await createServer({
      config: testConfig({
        SUPERTOKENS_CONNECTION_URI: "http://localhost:19999",
      }),
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
    expect(body.dependencies).toBeDefined();
    expect(body.dependencies!.database).toBe("down");
    expect(body.dependencies!.supertokens).toBe("down");
  });

  it("transitions back to 503 after markNotReady() is called", async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
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

    // First: mark ready and confirm 200
    markReady();
    const readyRes = await fetch(`${address}/ready`);
    expect(readyRes.status).toBe(200);
    const readyBody = (await readyRes.json()) as ReadyResponse;
    expect(readyBody.status).toBe("ready");

    // Then: mark not ready (simulates shutdown or failure)
    markNotReady();
    const notReadyRes = await fetch(`${address}/ready`);
    expect(notReadyRes.status).toBe(503);
    const notReadyBody = (await notReadyRes.json()) as ReadyResponse;
    expect(notReadyBody.status).toBe("not_ready");
  });
});
