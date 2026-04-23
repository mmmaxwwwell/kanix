/**
 * Shared integration-test harness.
 *
 * Replaces the ~30-line boilerplate (testConfig + createFakeProcess +
 * beforeAll/afterAll) that every `*.integration.test.ts` used to carry.
 *
 * Critically, `stopTestServer` runs the full shutdown hook chain — closing
 * the DB pool, stopping the reservation-cleanup cron, clearing rate-limiter
 * state, tearing down WS connections, etc. Without this, each test file
 * leaked a server's worth of intervals and state into its vitest worker
 * (visible as runaway memory on full-suite runs).
 */
import { EventEmitter } from "node:events";
import {
  createServer,
  markReady,
  markNotReady,
  type ServerInstance,
  type CreateServerOptions,
} from "./server.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { resetShutdownState } from "./shutdown.js";
import type { Config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { assertSuperTokensUp, getSuperTokensUri, requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();
const SUPERTOKENS_URI = getSuperTokensUri();

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 0,
    LOG_LEVEL: "ERROR",
    NODE_ENV: "test",
    DATABASE_URL,
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
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW_MS: 60000,
    ...overrides,
  };
}

export function createFakeProcess(): NodeJS.Process {
  return new EventEmitter() as unknown as NodeJS.Process;
}

export interface TestServer {
  app: FastifyInstance;
  dbConn: DatabaseConnection;
  address: string;
  server: ServerInstance;
}

export interface CreateTestServerOptions {
  /** Extra fields merged into the canonical testConfig. */
  configOverrides?: Partial<Config>;
  /**
   * Extra fields merged into the createServer call. `config`, `processRef`,
   * `database`, `exitFn`, and `reservationCleanupIntervalMs` all have sensible
   * test defaults — override here to use a stub adapter, a custom admin alert
   * service, a mock GitHub fetcher, etc.
   */
  serverOverrides?: Partial<Omit<CreateServerOptions, "config">>;
  /**
   * Pass an existing DatabaseConnection (e.g. when a test wants to run
   * queries before `beforeAll`). Defaults to a fresh connection.
   */
  dbConn?: DatabaseConnection;
  /**
   * If true, skip `server.start()` so the test can use `app.inject(...)`
   * without binding a port. `address` will be an empty string.
   */
  skipListen?: boolean;
}

/**
 * Build a configured server ready for integration tests. Call
 * `stopTestServer` in afterAll (or afterEach) to release resources.
 *
 * Defaults: reservation-cleanup cron disabled, exitFn is a no-op, processRef
 * is a fresh EventEmitter, DATABASE_URL / SUPERTOKENS_CONNECTION_URI read from
 * env. Canonical testConfig values otherwise.
 */
export async function createTestServer(options: CreateTestServerOptions = {}): Promise<TestServer> {
  await assertSuperTokensUp();

  const dbConn = options.dbConn ?? createDatabaseConnection(DATABASE_URL);

  const server = await createServer({
    config: testConfig(options.configOverrides),
    processRef: createFakeProcess(),
    database: dbConn,
    exitFn: () => {},
    reservationCleanupIntervalMs: 0,
    ...options.serverOverrides,
  });

  const address = options.skipListen ? "" : await server.start();
  markReady();

  return { app: server.app, dbConn, address, server };
}

/**
 * Tear down a test server created by `createTestServer`. Runs every shutdown
 * hook registered by the server (DB pool, reservation cron, rate limiter, WS,
 * …) and marks the readiness flag off. Safe to call multiple times.
 */
export async function stopTestServer(ts: TestServer | undefined): Promise<void> {
  if (!ts) return;
  markNotReady();
  try {
    await ts.server.stop();
  } catch {
    // Hooks log their own failures; swallow so afterAll doesn't mask a real
    // test failure.
  }
  // `server.stop()` already closes the DB pool (one of the registered hooks),
  // so no explicit dbConn.close() is needed.
  resetShutdownState();
}
