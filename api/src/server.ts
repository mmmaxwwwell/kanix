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
  linkGitHubToCustomer,
  createGitHubUserFetcher,
  createRequireAdmin,
  requireCapability,
  registerAdminAuditLog,
  CAPABILITIES,
} from "./auth/index.js";
import type { GitHubUserFetcher } from "./auth/index.js";
import { insertProduct } from "./db/queries/product.js";
import { findOrdersByCustomerId } from "./db/queries/order.js";

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
  githubUserFetcher?: GitHubUserFetcher;
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
  const { config, processRef = process, database, githubUserFetcher } = options;

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
    githubOAuth:
      config.GITHUB_OAUTH_CLIENT_ID && config.GITHUB_OAUTH_CLIENT_SECRET
        ? {
            clientId: config.GITHUB_OAUTH_CLIENT_ID,
            clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET,
          }
        : undefined,
  });

  const resolvedGitHubFetcher =
    githubUserFetcher ??
    (config.GITHUB_OAUTH_CLIENT_ID && config.GITHUB_OAUTH_CLIENT_SECRET
      ? createGitHubUserFetcher(config.GITHUB_OAUTH_CLIENT_ID, config.GITHUB_OAUTH_CLIENT_SECRET)
      : undefined);

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
  // Link GitHub Account endpoint — requires verified email
  // -------------------------------------------------------------------------

  app.post(
    "/api/customer/link-github",
    { preHandler: [verifySession, requireVerifiedEmail] },
    async (request, reply) => {
      const session = request.session;
      if (!session) {
        return reply.status(401).send({
          error: "ERR_AUTHENTICATION_FAILED",
          message: "Authentication required",
        });
      }

      if (!database) {
        return reply.status(503).send({
          error: "ERR_SERVICE_UNAVAILABLE",
          message: "Database not available",
        });
      }

      if (!resolvedGitHubFetcher) {
        return reply.status(503).send({
          error: "ERR_SERVICE_UNAVAILABLE",
          message: "GitHub OAuth not configured",
        });
      }

      const body = request.body as { code?: string } | undefined;
      if (!body?.code || typeof body.code !== "string") {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "Missing required field: code",
        });
      }

      const userId = session.getUserId();
      const cust = await getCustomerByAuthSubject(database.db, userId);
      if (!cust) {
        return reply.status(404).send({
          error: "ERR_NOT_FOUND",
          message: "Customer record not found",
        });
      }

      if (cust.githubUserId) {
        return reply.status(409).send({
          error: "ERR_ALREADY_LINKED",
          message: "GitHub account already linked to this customer",
        });
      }

      let githubUser;
      try {
        githubUser = await resolvedGitHubFetcher(body.code);
      } catch {
        return reply.status(400).send({
          error: "ERR_GITHUB_OAUTH",
          message: "Failed to verify GitHub authorization code",
        });
      }

      const githubUserId = String(githubUser.id);
      const updated = await linkGitHubToCustomer(database.db, cust.id, githubUserId);

      if (!updated) {
        return reply.status(409).send({
          error: "ERR_DUPLICATE_LINK",
          message: "This GitHub account is already linked to another customer",
        });
      }

      return {
        customer: {
          id: updated.id,
          github_user_id: updated.githubUserId,
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // Customer orders endpoint — requires verified email
  // -------------------------------------------------------------------------

  app.get(
    "/api/customer/orders",
    { preHandler: [verifySession, requireVerifiedEmail] },
    async (request, reply) => {
      const session = request.session;
      if (!session) {
        return reply.status(401).send({
          error: "ERR_AUTHENTICATION_FAILED",
          message: "Authentication required",
        });
      }

      if (!database) {
        return reply.status(503).send({
          error: "ERR_SERVICE_UNAVAILABLE",
          message: "Database not available",
        });
      }

      const userId = session.getUserId();
      const cust = await getCustomerByAuthSubject(database.db, userId);
      if (!cust) {
        return reply.status(404).send({
          error: "ERR_NOT_FOUND",
          message: "Customer record not found",
        });
      }

      const orders = await findOrdersByCustomerId(database.db, cust.id);
      return { orders };
    },
  );

  // -------------------------------------------------------------------------
  // Admin endpoints — require admin auth + capability checks
  // -------------------------------------------------------------------------

  if (database) {
    const requireAdmin = createRequireAdmin(database.db);

    // Register audit log hook for all admin routes
    registerAdminAuditLog(app, database.db);

    // Admin profile — requires any admin auth (no specific capability)
    app.get(
      "/api/admin/me",
      { preHandler: [verifySession, requireAdmin] },
      async (request, reply) => {
        if (!request.adminContext) {
          return reply.status(403).send({
            error: "ERR_FORBIDDEN",
            message: "Admin access required",
          });
        }
        return {
          admin: {
            id: request.adminContext.adminUserId,
            email: request.adminContext.email,
            name: request.adminContext.name,
            capabilities: request.adminContext.capabilities,
          },
        };
      },
    );

    // Admin orders list — requires orders.read capability
    app.get(
      "/api/admin/orders",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.ORDERS_READ)],
      },
      async () => {
        // Placeholder — will be implemented in Phase 6
        return { orders: [] };
      },
    );

    // Admin inventory — requires inventory.read capability
    app.get(
      "/api/admin/inventory",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_READ)],
      },
      async () => {
        // Placeholder — will be implemented in Phase 5
        return { inventory: [] };
      },
    );

    // Admin create product — requires products.write capability
    app.post(
      "/api/admin/products",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const body = request.body as
          | {
              slug?: string;
              title?: string;
              description?: string;
              status?: string;
            }
          | undefined;

        if (!body?.slug || !body?.title) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Missing required fields: slug, title",
          });
        }

        const created = await insertProduct(database.db, {
          slug: body.slug,
          title: body.title,
          description: body.description,
          status: body.status ?? "draft",
        });

        // Set audit context for the onResponse hook
        request.auditContext = {
          action: "CREATE",
          entityType: "product",
          entityId: created.id,
          beforeJson: null,
          afterJson: created,
        };

        return reply.status(201).send({ product: created });
      },
    );
  }

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
