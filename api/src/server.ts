import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { DatabaseConnection } from "./db/connection.js";
import { checkDatabaseConnectivity } from "./db/queries/health.js";
import { createLogger, generateCorrelationId, withCorrelationId } from "./logger.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerSecurityMiddleware, clearRateLimiterState } from "./security.js";
import { createShutdownManager, isShuttingDown, type ShutdownManager } from "./shutdown.js";
import { ajvOptions } from "./validation.js";
import {
  initSuperTokens,
  registerAuthMiddleware,
  verifySession,
  requireVerifiedEmail,
  getCustomerByAuthSubject,
} from "./auth/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok" | "error";
  uptime: number;
  version: string;
  ready: boolean;
  dependencies: {
    database: "connected" | "disconnected";
  };
}

export interface ReadyResponse {
  status: "ready" | "not_ready";
  dependencies?: {
    database: "up" | "down";
  };
}

export interface CreateServerOptions {
  config: Config;
  processRef?: NodeJS.Process;
  database?: DatabaseConnection;
}

export interface ServerInstance {
  app: FastifyInstance;
  shutdownManager: ShutdownManager;
  start(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Readiness state
// ---------------------------------------------------------------------------

let serverReady = false;

export function markReady(): void {
  serverReady = true;
}

export function markNotReady(): void {
  serverReady = false;
}

export function isReady(): boolean {
  return serverReady && !isShuttingDown();
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

const APP_VERSION = "0.1.0";

export async function createServer(options: CreateServerOptions): Promise<ServerInstance> {
  const { config, processRef = process, database } = options;

  const logger = createLogger({
    level: config.LOG_LEVEL,
    module: "server",
  });

  const app = Fastify({
    logger: false, // We manage our own Pino logger
    ajv: ajvOptions,
  });

  // -------------------------------------------------------------------------
  // SuperTokens initialization + auth middleware
  // -------------------------------------------------------------------------

  initSuperTokens({
    connectionUri: config.SUPERTOKENS_CONNECTION_URI,
    apiKey: config.SUPERTOKENS_API_KEY,
    appName: "Kanix",
    apiDomain: `http://localhost:${config.PORT}`,
    websiteDomain: config.CORS_ALLOWED_ORIGINS[0] ?? "http://localhost:3000",
    db: database?.db,
  });

  await registerAuthMiddleware(app);

  // -------------------------------------------------------------------------
  // Security middleware — CORS, rate limiting, security headers
  // -------------------------------------------------------------------------

  const { rateLimiter } = registerSecurityMiddleware(app, config);

  // -------------------------------------------------------------------------
  // Global error handler — validation, AppError, and unknown errors
  // -------------------------------------------------------------------------

  registerErrorHandler(app);

  // -------------------------------------------------------------------------
  // Correlation ID hook — attach to every request
  // -------------------------------------------------------------------------

  app.addHook("onRequest", async (request) => {
    const incomingId =
      (request.headers["x-correlation-id"] as string | undefined) ?? generateCorrelationId();
    request.log = withCorrelationId(logger, incomingId);
  });

  // -------------------------------------------------------------------------
  // Health endpoints
  // -------------------------------------------------------------------------

  app.get("/health", async () => {
    const dbConnected = database ? await checkDatabaseConnectivity(database.db) : false;
    const response: HealthResponse = {
      status: "ok",
      uptime: process.uptime(),
      version: APP_VERSION,
      ready: isReady(),
      dependencies: {
        database: dbConnected ? "connected" : "disconnected",
      },
    };
    return response;
  });

  app.get("/ready", async (_request, reply) => {
    if (!isReady()) {
      const response: ReadyResponse = { status: "not_ready" };
      return reply.status(503).send(response);
    }

    const dbConnected = database ? await checkDatabaseConnectivity(database.db) : false;
    if (!dbConnected) {
      const response: ReadyResponse = {
        status: "not_ready",
        dependencies: { database: "down" },
      };
      return reply.status(503).send(response);
    }

    const response: ReadyResponse = { status: "ready" };
    return reply.status(200).send(response);
  });

  // -------------------------------------------------------------------------
  // Protected customer endpoint — requires verified email
  // -------------------------------------------------------------------------

  app.get(
    "/api/customer/me",
    { preHandler: [verifySession, requireVerifiedEmail] },
    async (request, reply) => {
      const session = request.session;
      if (!session) {
        return reply.status(401).send({
          error: "ERR_AUTHENTICATION_FAILED",
          message: "Authentication required",
        });
      }
      const userId = session.getUserId();

      if (!database) {
        return reply.status(503).send({
          error: "ERR_SERVICE_UNAVAILABLE",
          message: "Database not available",
        });
      }

      const cust = await getCustomerByAuthSubject(database.db, userId);
      if (!cust) {
        return reply.status(404).send({
          error: "ERR_NOT_FOUND",
          message: "Customer record not found",
        });
      }

      return { customer: cust };
    },
  );

  // -------------------------------------------------------------------------
  // Shutdown manager
  // -------------------------------------------------------------------------

  const shutdownManager = createShutdownManager({
    logger,
    processRef,
  });

  if (database) {
    shutdownManager.register({
      name: "close database connection",
      fn: async () => {
        await database.close();
      },
    });
  }

  shutdownManager.register({
    name: "close Fastify server",
    fn: async () => {
      await app.close();
    },
  });

  shutdownManager.register({
    name: "clear rate limiter state",
    fn: async () => {
      clearRateLimiterState(rateLimiter);
    },
  });

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  async function start(): Promise<string> {
    const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
    logger.info(`Server listening on ${address}`);
    return address;
  }

  return { app, shutdownManager, start };
}
