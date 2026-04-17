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
  checkSuperTokensConnectivity,
  CAPABILITIES,
} from "./auth/index.js";
import type { GitHubUserFetcher } from "./auth/index.js";
import {
  insertProduct,
  findProductById,
  findAllProducts,
  updateProduct,
  isValidProductTransition,
  insertProductMedia,
  findMediaByProductId,
  findMediaById,
  updateProductMedia,
  deleteProductMedia,
  reorderProductMedia,
  insertCollection,
  findCollectionById,
  findAllCollections,
  updateCollection,
  addProductToCollection,
  removeProductFromCollection,
  findProductsByCollectionId,
} from "./db/queries/product.js";
import { findOrdersByCustomerId } from "./db/queries/order.js";
import {
  insertVariant,
  findVariantById,
  findVariantsByProductId,
  updateVariant,
  isValidVariantTransition,
} from "./db/queries/variant.js";
import {
  insertProductClass,
  findProductClassById,
  listProductClasses,
  updateProductClass,
  deleteProductClass,
  assignProductToClass,
  removeProductFromClass,
} from "./db/queries/product-class.js";
import { findInventoryBalances, createInventoryAdjustment } from "./db/queries/inventory.js";
import {
  reserveInventory,
  consumeReservation,
  releaseReservation,
  findReservationById,
} from "./db/queries/reservation.js";

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
    database?: "up" | "down";
    supertokens?: "up" | "down";
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

    const [dbConnected, stConnected] = await Promise.all([
      database ? checkDatabaseConnectivity(database.db) : Promise.resolve(false),
      checkSuperTokensConnectivity(config.SUPERTOKENS_CONNECTION_URI),
    ]);

    if (!dbConnected || !stConnected) {
      const response: ReadyResponse = {
        status: "not_ready",
        dependencies: {
          database: dbConnected ? "up" : "down",
          supertokens: stConnected ? "up" : "down",
        },
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

    // -----------------------------------------------------------------------
    // Inventory Balances + Adjustments
    // -----------------------------------------------------------------------

    // List inventory balances with optional filters
    app.get(
      "/api/admin/inventory/balances",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_READ)],
      },
      async (request) => {
        const query = request.query as {
          variant_id?: string;
          location_id?: string;
          low_stock_only?: string;
        };
        const balances = await findInventoryBalances(database.db, {
          variantId: query.variant_id,
          locationId: query.location_id,
          lowStockOnly: query.low_stock_only === "true",
        });
        return { balances };
      },
    );

    // Create inventory adjustment
    app.post(
      "/api/admin/inventory/adjustments",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_ADJUST)],
      },
      async (request, reply) => {
        const body = request.body as {
          variant_id: string;
          location_id: string;
          adjustment_type: string;
          quantity_delta: number;
          reason: string;
          notes?: string;
          idempotency_key?: string;
        };

        // Validate required fields
        if (
          !body.variant_id ||
          !body.location_id ||
          !body.adjustment_type ||
          body.quantity_delta == null ||
          !body.reason
        ) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message:
              "Missing required fields: variant_id, location_id, adjustment_type, quantity_delta, reason",
          });
        }

        const validTypes = ["restock", "shrinkage", "correction", "damage", "return"];
        if (!validTypes.includes(body.adjustment_type)) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: `Invalid adjustment_type. Must be one of: ${validTypes.join(", ")}`,
          });
        }

        if (!Number.isInteger(body.quantity_delta) || body.quantity_delta === 0) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "quantity_delta must be a non-zero integer",
          });
        }

        try {
          const result = await createInventoryAdjustment(database.db, {
            variantId: body.variant_id,
            locationId: body.location_id,
            adjustmentType: body.adjustment_type as
              | "restock"
              | "shrinkage"
              | "correction"
              | "damage"
              | "return",
            quantityDelta: body.quantity_delta,
            reason: body.reason,
            notes: body.notes,
            actorAdminUserId: request.adminContext?.adminUserId ?? "",
            idempotencyKey: body.idempotency_key,
          });

          // Set audit context for the audit log middleware
          request.auditContext = {
            action: "CREATE",
            entityType: "inventory_adjustment",
            entityId: result.adjustment.id,
            afterJson: {
              adjustmentType: body.adjustment_type,
              quantityDelta: body.quantity_delta,
              variantId: body.variant_id,
              locationId: body.location_id,
            },
          };

          return reply.status(201).send({
            adjustment: result.adjustment,
            movement: result.movement,
            balance: result.balance,
            low_stock: result.lowStock,
          });
        } catch (err: unknown) {
          // CHECK constraint violation means available would go negative
          const pgErr = err as { code?: string; constraint?: string };
          if (pgErr.code === "23514" && pgErr.constraint?.includes("ck_inventory_balance")) {
            return reply.status(422).send({
              error: "ERR_INVENTORY_INSUFFICIENT",
              message: "Adjustment would result in negative inventory balance",
            });
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // Inventory Reservations
    // -----------------------------------------------------------------------

    // Reserve inventory
    app.post(
      "/api/admin/inventory/reservations",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_ADJUST)],
      },
      async (request, reply) => {
        const body = request.body as {
          variant_id: string;
          location_id: string;
          quantity: number;
          ttl_ms: number;
          reservation_reason?: string;
          order_id?: string;
          cart_id?: string;
        };

        if (!body.variant_id || !body.location_id || body.quantity == null || body.ttl_ms == null) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Missing required fields: variant_id, location_id, quantity, ttl_ms",
          });
        }

        if (!Number.isInteger(body.quantity) || body.quantity < 1) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "quantity must be a positive integer",
          });
        }

        if (!Number.isInteger(body.ttl_ms) || body.ttl_ms < 1) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "ttl_ms must be a positive integer",
          });
        }

        try {
          const result = await reserveInventory(database.db, {
            variantId: body.variant_id,
            locationId: body.location_id,
            quantity: body.quantity,
            ttlMs: body.ttl_ms,
            reservationReason: body.reservation_reason,
            orderId: body.order_id,
            cartId: body.cart_id,
          });

          request.auditContext = {
            action: "CREATE",
            entityType: "inventory_reservation",
            entityId: result.reservation.id,
            afterJson: {
              variantId: body.variant_id,
              locationId: body.location_id,
              quantity: body.quantity,
              ttlMs: body.ttl_ms,
            },
          };

          return reply.status(201).send({
            reservation: result.reservation,
            movement: result.movement,
          });
        } catch (err: unknown) {
          const appErr = err as { code?: string };
          if (appErr.code === "ERR_INVENTORY_INSUFFICIENT") {
            return reply.status(422).send({
              error: "ERR_INVENTORY_INSUFFICIENT",
              message: "Insufficient inventory to reserve",
            });
          }
          if (appErr.code === "ERR_INVENTORY_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_INVENTORY_NOT_FOUND",
              message: "No inventory balance found for variant/location",
            });
          }
          throw err;
        }
      },
    );

    // Consume reservation
    app.post(
      "/api/admin/inventory/reservations/:id/consume",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_ADJUST)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
          const result = await consumeReservation(database.db, id);

          request.auditContext = {
            action: "UPDATE",
            entityType: "inventory_reservation",
            entityId: id,
            afterJson: { status: "consumed" },
          };

          return reply.status(200).send({
            reservation: result.reservation,
            movement: result.movement,
          });
        } catch (err: unknown) {
          const appErr = err as { code?: string };
          if (appErr.code === "ERR_RESERVATION_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_RESERVATION_NOT_FOUND",
              message: "Reservation not found",
            });
          }
          if (appErr.code === "ERR_INVALID_STATUS_TRANSITION") {
            return reply.status(422).send({
              error: "ERR_INVALID_STATUS_TRANSITION",
              message: (err as Error).message,
            });
          }
          throw err;
        }
      },
    );

    // Release reservation
    app.post(
      "/api/admin/inventory/reservations/:id/release",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_ADJUST)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
          const result = await releaseReservation(database.db, id);

          request.auditContext = {
            action: "UPDATE",
            entityType: "inventory_reservation",
            entityId: id,
            afterJson: { status: "released" },
          };

          return reply.status(200).send({
            reservation: result.reservation,
            movement: result.movement,
          });
        } catch (err: unknown) {
          const appErr = err as { code?: string };
          if (appErr.code === "ERR_RESERVATION_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_RESERVATION_NOT_FOUND",
              message: "Reservation not found",
            });
          }
          if (appErr.code === "ERR_INVALID_STATUS_TRANSITION") {
            return reply.status(422).send({
              error: "ERR_INVALID_STATUS_TRANSITION",
              message: (err as Error).message,
            });
          }
          throw err;
        }
      },
    );

    // Get reservation by ID
    app.get(
      "/api/admin/inventory/reservations/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const reservation = await findReservationById(database.db, id);
        if (!reservation) {
          return reply.status(404).send({
            error: "ERR_RESERVATION_NOT_FOUND",
            message: "Reservation not found",
          });
        }
        return { reservation };
      },
    );

    // -----------------------------------------------------------------------
    // Product CRUD
    // -----------------------------------------------------------------------

    // List products — requires products.read
    app.get(
      "/api/admin/products",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async () => {
        const products = await findAllProducts(database.db);
        return { products };
      },
    );

    // Get single product — requires products.read
    app.get(
      "/api/admin/products/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const found = await findProductById(database.db, id);
        if (!found) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found",
          });
        }
        const media = await findMediaByProductId(database.db, id);
        return { product: found, media };
      },
    );

    // Create product — requires products.write
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
              subtitle?: string;
              description?: string;
              brand?: string;
              status?: string;
            }
          | undefined;

        if (!body?.slug || !body?.title) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Missing required fields: slug, title",
          });
        }

        const status = body.status ?? "draft";
        if (!["draft", "active", "archived"].includes(status)) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Invalid status. Must be one of: draft, active, archived",
          });
        }

        const created = await insertProduct(database.db, {
          slug: body.slug,
          title: body.title,
          subtitle: body.subtitle,
          description: body.description,
          brand: body.brand,
          status,
        });

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

    // Update product — requires products.write
    app.patch(
      "/api/admin/products/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as
          | {
              slug?: string;
              title?: string;
              subtitle?: string;
              description?: string;
              brand?: string;
              status?: string;
            }
          | undefined;

        if (!body || Object.keys(body).length === 0) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Request body must contain at least one field to update",
          });
        }

        const existing = await findProductById(database.db, id);
        if (!existing) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found",
          });
        }

        // Validate status transition if status is being changed
        if (body.status && body.status !== existing.status) {
          if (!isValidProductTransition(existing.status, body.status)) {
            return reply.status(400).send({
              error: "ERR_INVALID_STATUS_TRANSITION",
              message: `Cannot transition product from '${existing.status}' to '${body.status}'`,
            });
          }
        }

        const updateData: Record<string, unknown> = {};
        if (body.slug !== undefined) updateData.slug = body.slug;
        if (body.title !== undefined) updateData.title = body.title;
        if (body.subtitle !== undefined) updateData.subtitle = body.subtitle;
        if (body.description !== undefined) updateData.description = body.description;
        if (body.brand !== undefined) updateData.brand = body.brand;
        if (body.status !== undefined) updateData.status = body.status;

        const updated = await updateProduct(database.db, id, updateData);

        request.auditContext = {
          action: "UPDATE",
          entityType: "product",
          entityId: id,
          beforeJson: existing,
          afterJson: updated,
        };

        return { product: updated };
      },
    );

    // -----------------------------------------------------------------------
    // Variant routes — POST/GET/PATCH /admin/products/:id/variants
    // -----------------------------------------------------------------------

    // List variants for a product
    app.get(
      "/api/admin/products/:id/variants",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const prod = await findProductById(database.db, id);
        if (!prod) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found",
          });
        }
        const variants = await findVariantsByProductId(database.db, id);
        return { variants };
      },
    );

    // Create a variant for a product
    app.post(
      "/api/admin/products/:id/variants",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { id: productId } = request.params as { id: string };
        const prod = await findProductById(database.db, productId);
        if (!prod) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found",
          });
        }

        const body = request.body as
          | {
              sku?: string;
              title?: string;
              material?: string;
              price_minor?: number;
              currency?: string;
              weight?: string;
              dimensions?: Record<string, unknown>;
              barcode?: string;
              status?: string;
            }
          | undefined;

        if (!body?.sku || !body?.title || body?.price_minor == null) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Missing required fields: sku, title, price_minor",
          });
        }

        if (typeof body.price_minor !== "number" || body.price_minor <= 0) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "price_minor must be a positive integer",
          });
        }

        const optionValues = body.material ? { material: body.material } : {};

        const created = await insertVariant(database.db, {
          productId,
          sku: body.sku,
          title: body.title,
          optionValuesJson: optionValues,
          priceMinor: body.price_minor,
          currency: body.currency ?? "USD",
          weight: body.weight ?? null,
          dimensionsJson: body.dimensions ?? null,
          barcode: body.barcode ?? null,
          status: body.status ?? "draft",
        });

        request.auditContext = {
          action: "CREATE",
          entityType: "product_variant",
          entityId: created.id,
          beforeJson: null,
          afterJson: created,
        };

        return reply.status(201).send({ variant: created });
      },
    );

    // Update a variant (including status transitions)
    app.patch(
      "/api/admin/products/:id/variants/:variantId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { id: productId, variantId } = request.params as {
          id: string;
          variantId: string;
        };

        const prod = await findProductById(database.db, productId);
        if (!prod) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found",
          });
        }

        const existing = await findVariantById(database.db, variantId);
        if (!existing || existing.productId !== productId) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Variant not found",
          });
        }

        const body = request.body as
          | {
              sku?: string;
              title?: string;
              material?: string;
              price_minor?: number;
              currency?: string;
              weight?: string;
              dimensions?: Record<string, unknown>;
              barcode?: string;
              status?: string;
            }
          | undefined;

        if (!body || Object.keys(body).length === 0) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "No fields to update",
          });
        }

        // Validate status transition if status is being changed
        if (body.status && body.status !== existing.status) {
          if (!isValidVariantTransition(existing.status, body.status)) {
            return reply.status(400).send({
              error: "ERR_INVALID_TRANSITION",
              message: `Cannot transition variant from '${existing.status}' to '${body.status}'`,
            });
          }
          // Guard: draft → active requires SKU and price
          if (body.status === "active") {
            const finalSku = body.sku ?? existing.sku;
            const finalPrice = body.price_minor ?? existing.priceMinor;
            if (!finalSku || !finalPrice) {
              return reply.status(400).send({
                error: "ERR_VALIDATION",
                message: "SKU and price must be set before activating a variant",
              });
            }
          }
        }

        if (
          body.price_minor != null &&
          (typeof body.price_minor !== "number" || body.price_minor <= 0)
        ) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "price_minor must be a positive integer",
          });
        }

        const updateData: Record<string, unknown> = {};
        if (body.sku !== undefined) updateData.sku = body.sku;
        if (body.title !== undefined) updateData.title = body.title;
        if (body.material !== undefined) updateData.optionValuesJson = { material: body.material };
        if (body.price_minor !== undefined) updateData.priceMinor = body.price_minor;
        if (body.currency !== undefined) updateData.currency = body.currency;
        if (body.weight !== undefined) updateData.weight = body.weight;
        if (body.dimensions !== undefined) updateData.dimensionsJson = body.dimensions;
        if (body.barcode !== undefined) updateData.barcode = body.barcode;
        if (body.status !== undefined) updateData.status = body.status;

        const updated = await updateVariant(database.db, variantId, updateData);

        request.auditContext = {
          action: "UPDATE",
          entityType: "product_variant",
          entityId: variantId,
          beforeJson: existing,
          afterJson: updated,
        };

        return { variant: updated };
      },
    );

    // -----------------------------------------------------------------------
    // Product Class CRUD — /admin/product-classes
    // -----------------------------------------------------------------------

    // List product classes
    app.get(
      "/api/admin/product-classes",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async () => {
        const classes = await listProductClasses(database.db);
        return { product_classes: classes };
      },
    );

    // Create product class
    app.post(
      "/api/admin/product-classes",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const body = request.body as
          | { name?: string; slug?: string; description?: string; sort_order?: number }
          | undefined;

        if (!body?.name || !body?.slug) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Missing required fields: name, slug",
          });
        }

        const created = await insertProductClass(database.db, {
          name: body.name,
          slug: body.slug,
          description: body.description,
          sortOrder: body.sort_order ?? 0,
        });

        request.auditContext = {
          action: "CREATE",
          entityType: "product_class",
          entityId: created.id,
          beforeJson: null,
          afterJson: created,
        };

        return reply.status(201).send({ product_class: created });
      },
    );

    // Get product class by ID
    app.get(
      "/api/admin/product-classes/:classId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async (request, reply) => {
        const { classId } = request.params as { classId: string };
        const pc = await findProductClassById(database.db, classId);
        if (!pc) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product class not found",
          });
        }
        return { product_class: pc };
      },
    );

    // Update product class
    app.patch(
      "/api/admin/product-classes/:classId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { classId } = request.params as { classId: string };
        const existing = await findProductClassById(database.db, classId);
        if (!existing) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product class not found",
          });
        }

        const body = request.body as
          | { name?: string; slug?: string; description?: string; sort_order?: number }
          | undefined;

        if (!body || Object.keys(body).length === 0) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "No fields to update",
          });
        }

        const updateData: Record<string, unknown> = {};
        if (body.name !== undefined) updateData.name = body.name;
        if (body.slug !== undefined) updateData.slug = body.slug;
        if (body.description !== undefined) updateData.description = body.description;
        if (body.sort_order !== undefined) updateData.sortOrder = body.sort_order;

        const updated = await updateProductClass(database.db, classId, updateData);

        request.auditContext = {
          action: "UPDATE",
          entityType: "product_class",
          entityId: classId,
          beforeJson: existing,
          afterJson: updated,
        };

        return { product_class: updated };
      },
    );

    // Delete product class
    app.delete(
      "/api/admin/product-classes/:classId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { classId } = request.params as { classId: string };
        const existing = await findProductClassById(database.db, classId);
        if (!existing) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product class not found",
          });
        }

        await deleteProductClass(database.db, classId);

        request.auditContext = {
          action: "DELETE",
          entityType: "product_class",
          entityId: classId,
          beforeJson: existing,
          afterJson: null,
        };

        return reply.status(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // Product Class Membership — assign/remove products from classes
    // -----------------------------------------------------------------------

    // Assign product to class
    app.post(
      "/api/admin/products/:id/classes/:classId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { id: productId, classId } = request.params as {
          id: string;
          classId: string;
        };

        const prod = await findProductById(database.db, productId);
        if (!prod) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found",
          });
        }

        const pc = await findProductClassById(database.db, classId);
        if (!pc) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product class not found",
          });
        }

        const membership = await assignProductToClass(database.db, productId, classId);

        request.auditContext = {
          action: "CREATE",
          entityType: "product_class_membership",
          entityId: `${productId}:${classId}`,
          beforeJson: null,
          afterJson: membership,
        };

        return reply.status(201).send({ membership });
      },
    );

    // Remove product from class
    app.delete(
      "/api/admin/products/:id/classes/:classId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { id: productId, classId } = request.params as {
          id: string;
          classId: string;
        };

        const removed = await removeProductFromClass(database.db, productId, classId);
        if (!removed) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Membership not found",
          });
        }

        request.auditContext = {
          action: "DELETE",
          entityType: "product_class_membership",
          entityId: `${productId}:${classId}`,
          beforeJson: { productId, productClassId: classId },
          afterJson: null,
        };

        return reply.status(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // Product Media
    // -----------------------------------------------------------------------

    // List media for a product — requires products.read
    app.get(
      "/api/admin/products/:id/media",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const prod = await findProductById(database.db, id);
        if (!prod) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found",
          });
        }
        const media = await findMediaByProductId(database.db, id);
        return { media };
      },
    );

    // Add media to product — requires products.write
    app.post(
      "/api/admin/products/:id/media",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as
          | { url?: string; alt_text?: string; sort_order?: number; variant_id?: string }
          | undefined;

        if (!body?.url) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Missing required field: url",
          });
        }

        const prod = await findProductById(database.db, id);
        if (!prod) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found",
          });
        }

        const created = await insertProductMedia(database.db, {
          productId: id,
          url: body.url,
          altText: body.alt_text,
          sortOrder: body.sort_order ?? 0,
          variantId: body.variant_id,
        });

        request.auditContext = {
          action: "CREATE",
          entityType: "product_media",
          entityId: created.id,
          beforeJson: null,
          afterJson: created,
        };

        return reply.status(201).send({ media: created });
      },
    );

    // Update media — requires products.write
    app.patch(
      "/api/admin/products/:productId/media/:mediaId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { productId, mediaId } = request.params as { productId: string; mediaId: string };
        const body = request.body as
          | { url?: string; alt_text?: string; sort_order?: number; variant_id?: string }
          | undefined;

        if (!body || Object.keys(body).length === 0) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Request body must contain at least one field to update",
          });
        }

        const existing = await findMediaById(database.db, mediaId);
        if (!existing || existing.productId !== productId) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Media not found",
          });
        }

        const updateData: Record<string, unknown> = {};
        if (body.url !== undefined) updateData.url = body.url;
        if (body.alt_text !== undefined) updateData.altText = body.alt_text;
        if (body.sort_order !== undefined) updateData.sortOrder = body.sort_order;
        if (body.variant_id !== undefined) updateData.variantId = body.variant_id;

        const updated = await updateProductMedia(database.db, mediaId, updateData);

        request.auditContext = {
          action: "UPDATE",
          entityType: "product_media",
          entityId: mediaId,
          beforeJson: existing,
          afterJson: updated,
        };

        return { media: updated };
      },
    );

    // Delete media — requires products.write
    app.delete(
      "/api/admin/products/:productId/media/:mediaId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { productId, mediaId } = request.params as { productId: string; mediaId: string };

        const existing = await findMediaById(database.db, mediaId);
        if (!existing || existing.productId !== productId) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Media not found",
          });
        }

        await deleteProductMedia(database.db, mediaId);

        request.auditContext = {
          action: "DELETE",
          entityType: "product_media",
          entityId: mediaId,
          beforeJson: existing,
          afterJson: null,
        };

        return reply.status(204).send();
      },
    );

    // Reorder media — requires products.write
    app.post(
      "/api/admin/products/:id/media/reorder",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { media_ids?: string[] } | undefined;

        if (!body?.media_ids || !Array.isArray(body.media_ids)) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Missing required field: media_ids (array of media IDs)",
          });
        }

        const prod = await findProductById(database.db, id);
        if (!prod) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found",
          });
        }

        const updated = await reorderProductMedia(database.db, id, body.media_ids);
        return { media: updated };
      },
    );

    // -----------------------------------------------------------------------
    // Collection CRUD
    // -----------------------------------------------------------------------

    // List collections — requires products.read
    app.get(
      "/api/admin/collections",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async () => {
        const collections = await findAllCollections(database.db);
        return { collections };
      },
    );

    // Get single collection — requires products.read
    app.get(
      "/api/admin/collections/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const found = await findCollectionById(database.db, id);
        if (!found) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Collection not found",
          });
        }
        const products = await findProductsByCollectionId(database.db, id);
        return { collection: found, products };
      },
    );

    // Create collection — requires products.write
    app.post(
      "/api/admin/collections",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const body = request.body as
          | { slug?: string; title?: string; description?: string; status?: string }
          | undefined;

        if (!body?.slug || !body?.title) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Missing required fields: slug, title",
          });
        }

        const created = await insertCollection(database.db, {
          slug: body.slug,
          title: body.title,
          description: body.description,
          status: body.status ?? "draft",
        });

        request.auditContext = {
          action: "CREATE",
          entityType: "collection",
          entityId: created.id,
          beforeJson: null,
          afterJson: created,
        };

        return reply.status(201).send({ collection: created });
      },
    );

    // Update collection — requires products.write
    app.patch(
      "/api/admin/collections/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as
          | { slug?: string; title?: string; description?: string; status?: string }
          | undefined;

        if (!body || Object.keys(body).length === 0) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Request body must contain at least one field to update",
          });
        }

        const existing = await findCollectionById(database.db, id);
        if (!existing) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Collection not found",
          });
        }

        const updated = await updateCollection(database.db, id, body);

        request.auditContext = {
          action: "UPDATE",
          entityType: "collection",
          entityId: id,
          beforeJson: existing,
          afterJson: updated,
        };

        return { collection: updated };
      },
    );

    // Add product to collection — requires products.write
    app.post(
      "/api/admin/collections/:id/products",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { product_id?: string; sort_order?: number } | undefined;

        if (!body?.product_id) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "Missing required field: product_id",
          });
        }

        const col = await findCollectionById(database.db, id);
        if (!col) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Collection not found",
          });
        }

        const prod = await findProductById(database.db, body.product_id);
        if (!prod) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found",
          });
        }

        const association = await addProductToCollection(database.db, {
          collectionId: id,
          productId: body.product_id,
          sortOrder: body.sort_order ?? 0,
        });

        request.auditContext = {
          action: "CREATE",
          entityType: "collection_product",
          entityId: id,
          beforeJson: null,
          afterJson: association,
        };

        return reply.status(201).send({ collection_product: association });
      },
    );

    // Remove product from collection — requires products.write
    app.delete(
      "/api/admin/collections/:collectionId/products/:productId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { collectionId, productId } = request.params as {
          collectionId: string;
          productId: string;
        };

        const removed = await removeProductFromCollection(database.db, collectionId, productId);
        if (!removed) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Product not found in this collection",
          });
        }

        request.auditContext = {
          action: "DELETE",
          entityType: "collection_product",
          entityId: collectionId,
          beforeJson: { collectionId, productId },
          afterJson: null,
        };

        return reply.status(204).send();
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
