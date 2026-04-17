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
import {
  findInventoryBalances,
  findBalanceByVariantAndLocation,
  createInventoryAdjustment,
} from "./db/queries/inventory.js";
import { findActiveProductsWithDetails, findActiveProductBySlug } from "./db/queries/catalog.js";
import {
  insertAddress,
  findAddressesByCustomerId,
  updateAddress,
  deleteAddress,
  validateAddressFields,
} from "./db/queries/address.js";
import {
  createCart,
  findCartByToken,
  findActiveCartByCustomerId,
  addCartItem,
  removeCartItem,
  getCartWithItems,
} from "./db/queries/cart.js";
import {
  insertKitDefinition,
  findKitDefinitionById,
  listKitDefinitions,
  updateKitDefinition,
  setKitClassRequirements,
  findKitClassRequirements,
  addKitToCart,
} from "./db/queries/kit.js";
import {
  reserveInventory,
  consumeReservation,
  releaseReservation,
  findReservationById,
} from "./db/queries/reservation.js";
import { startReservationCleanup } from "./cron/reservation-cleanup.js";
import {
  createLowStockAlertService,
  type LowStockAlertService,
} from "./services/low-stock-alert.js";
import { createTaxAdapter, type TaxAdapter } from "./services/tax-adapter.js";
import { createShippingAdapter, type ShippingAdapter } from "./services/shipping-adapter.js";
import { sql } from "drizzle-orm";
import { createPaymentAdapter, type PaymentAdapter } from "./services/payment-adapter.js";
import { generateOrderNumber, createCheckoutOrder } from "./db/queries/checkout.js";
import type { CheckoutAddress } from "./db/queries/checkout.js";
import {
  transitionOrderStatus,
  findOrderById,
  findOrderStatusHistory,
} from "./db/queries/order-state-machine.js";
import type { OrderStatusType } from "./db/queries/order-state-machine.js";
import { cancelOrder } from "./db/queries/order-cancel.js";
import {
  hasEventBeenProcessed,
  findPaymentByIntentId,
  findPaymentByChargeId,
  storePaymentEvent,
  handlePaymentSucceeded,
  handlePaymentFailed,
  handleChargeRefunded,
  handleDisputeCreated,
} from "./db/queries/webhook.js";
import { processRefund, findRefundsByOrderId } from "./db/queries/refund.js";
import Stripe from "stripe";

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
  /** Override the reservation cleanup interval in ms (default 60 000). Set to 0 to disable. */
  reservationCleanupIntervalMs?: number;
  /** Override the low-stock alert service (useful for testing). */
  lowStockAlertService?: LowStockAlertService;
  /** Override the tax adapter (useful for testing). */
  taxAdapter?: TaxAdapter;
  /** Override the shipping adapter (useful for testing). */
  shippingAdapter?: ShippingAdapter;
  /** Override the payment adapter (useful for testing). */
  paymentAdapter?: PaymentAdapter;
}

export interface ServerInstance {
  app: FastifyInstance;
  shutdownManager: ShutdownManager;
  lowStockAlertService: LowStockAlertService;
  taxAdapter: TaxAdapter;
  shippingAdapter: ShippingAdapter;
  paymentAdapter: PaymentAdapter;
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
  const lowStockAlertService = options.lowStockAlertService ?? createLowStockAlertService();
  const taxAdapter =
    options.taxAdapter ??
    createTaxAdapter({
      stripeTaxEnabled: config.STRIPE_TAX_ENABLED,
      stripeSecretKey: config.STRIPE_SECRET_KEY,
    });
  const shippingAdapter =
    options.shippingAdapter ??
    createShippingAdapter({
      easyPostApiKey: config.EASYPOST_API_KEY,
    });
  const paymentAdapter =
    options.paymentAdapter ??
    createPaymentAdapter({
      stripeSecretKey: config.STRIPE_SECRET_KEY,
    });

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
  // Customer address CRUD — requires verified email
  // -------------------------------------------------------------------------

  // GET /api/customer/addresses — list addresses for the authenticated customer
  app.get(
    "/api/customer/addresses",
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

      const addresses = await findAddressesByCustomerId(database.db, cust.id);
      return { addresses };
    },
  );

  // POST /api/customer/addresses — create a new address
  app.post(
    "/api/customer/addresses",
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

      const body = request.body as
        | {
            type?: string;
            full_name?: string;
            phone?: string;
            line1?: string;
            line2?: string;
            city?: string;
            state?: string;
            postal_code?: string;
            country?: string;
            is_default?: boolean;
          }
        | undefined;

      if (!body) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "Request body is required",
        });
      }

      const input = {
        customerId: cust.id,
        type: body.type ?? "",
        fullName: body.full_name ?? "",
        phone: body.phone,
        line1: body.line1 ?? "",
        line2: body.line2,
        city: body.city ?? "",
        state: body.state ?? "",
        postalCode: body.postal_code ?? "",
        country: body.country,
        isDefault: body.is_default,
      };

      const validationError = validateAddressFields(input);
      if (validationError) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: validationError,
        });
      }

      const created = await insertAddress(database.db, input);
      return reply.status(201).send({ address: created });
    },
  );

  // PATCH /api/customer/addresses/:id — update an address
  app.patch(
    "/api/customer/addresses/:id",
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

      const { id } = request.params as { id: string };
      const body = request.body as
        | {
            type?: string;
            full_name?: string;
            phone?: string | null;
            line1?: string;
            line2?: string | null;
            city?: string;
            state?: string;
            postal_code?: string;
            is_default?: boolean;
          }
        | undefined;

      if (!body || Object.keys(body).length === 0) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "Request body must contain at least one field to update",
        });
      }

      // Validate type if provided
      if (body.type !== undefined && !["shipping", "billing"].includes(body.type)) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "type must be 'shipping' or 'billing'",
        });
      }

      // Validate state if provided
      if (body.state !== undefined) {
        const stateUpper = body.state.toUpperCase();
        const US_STATE_CODES = new Set([
          "AL",
          "AK",
          "AZ",
          "AR",
          "CA",
          "CO",
          "CT",
          "DE",
          "FL",
          "GA",
          "HI",
          "ID",
          "IL",
          "IN",
          "IA",
          "KS",
          "KY",
          "LA",
          "ME",
          "MD",
          "MA",
          "MI",
          "MN",
          "MS",
          "MO",
          "MT",
          "NE",
          "NV",
          "NH",
          "NJ",
          "NM",
          "NY",
          "NC",
          "ND",
          "OH",
          "OK",
          "OR",
          "PA",
          "RI",
          "SC",
          "SD",
          "TN",
          "TX",
          "UT",
          "VT",
          "VA",
          "WA",
          "WV",
          "WI",
          "WY",
          "DC",
          "PR",
          "VI",
          "GU",
          "AS",
          "MP",
        ]);
        if (!US_STATE_CODES.has(stateUpper)) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: `Invalid US state code: ${body.state}`,
          });
        }
      }

      // Validate postal code if provided
      if (body.postal_code !== undefined && !/^\d{5}(-\d{4})?$/.test(body.postal_code)) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "Invalid US postal code format",
        });
      }

      const updates: Record<string, unknown> = {};
      if (body.type !== undefined) updates.type = body.type;
      if (body.full_name !== undefined) updates.fullName = body.full_name;
      if (body.phone !== undefined) updates.phone = body.phone;
      if (body.line1 !== undefined) updates.line1 = body.line1;
      if (body.line2 !== undefined) updates.line2 = body.line2;
      if (body.city !== undefined) updates.city = body.city;
      if (body.state !== undefined) updates.state = body.state;
      if (body.postal_code !== undefined) updates.postalCode = body.postal_code;
      if (body.is_default !== undefined) updates.isDefault = body.is_default;

      const updated = await updateAddress(database.db, id, cust.id, updates);
      if (!updated) {
        return reply.status(404).send({
          error: "ERR_NOT_FOUND",
          message: "Address not found",
        });
      }

      return { address: updated };
    },
  );

  // DELETE /api/customer/addresses/:id — delete an address
  app.delete(
    "/api/customer/addresses/:id",
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

      const { id } = request.params as { id: string };
      const deleted = await deleteAddress(database.db, id, cust.id);
      if (!deleted) {
        return reply.status(404).send({
          error: "ERR_NOT_FOUND",
          message: "Address not found",
        });
      }

      return reply.status(204).send();
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
        // Placeholder — will be expanded later
        return { orders: [] };
      },
    );

    // Get single order by ID
    app.get(
      "/api/admin/orders/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.ORDERS_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const found = await findOrderById(database.db, id);
        if (!found) {
          return reply
            .status(404)
            .send({ error: "ERR_ORDER_NOT_FOUND", message: "Order not found" });
        }
        return { order: found };
      },
    );

    // Transition an order's status (any of the four state machines)
    app.post(
      "/api/admin/orders/:id/transition",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.ORDERS_READ)],
        schema: {
          body: {
            type: "object",
            required: ["status_type", "new_value"],
            properties: {
              status_type: {
                type: "string",
                enum: ["status", "payment_status", "fulfillment_status", "shipping_status"],
              },
              new_value: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          status_type: OrderStatusType;
          new_value: string;
          reason?: string;
        };

        // Resolve admin user ID from request context
        const adminContext = (request as unknown as Record<string, unknown>).adminContext as
          | { adminUser: { id: string } }
          | undefined;
        const actorAdminUserId = adminContext?.adminUser?.id;

        try {
          const result = await transitionOrderStatus(database.db, {
            orderId: id,
            statusType: body.status_type,
            newValue: body.new_value,
            reason: body.reason,
            actorAdminUserId,
          });
          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({
              error: "ERR_INVALID_TRANSITION",
              message: error.message,
            });
          }
          if (error.code === "ERR_ORDER_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_ORDER_NOT_FOUND",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // Get order status history
    app.get(
      "/api/admin/orders/:id/history",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.ORDERS_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const found = await findOrderById(database.db, id);
        if (!found) {
          return reply
            .status(404)
            .send({ error: "ERR_ORDER_NOT_FOUND", message: "Order not found" });
        }
        const history = await findOrderStatusHistory(database.db, id);
        return { history };
      },
    );

    // -----------------------------------------------------------------------
    // Order Refunds
    // -----------------------------------------------------------------------

    // Create a refund for an order
    app.post(
      "/api/admin/orders/:id/refunds",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.ORDERS_REFUND)],
        schema: {
          body: {
            type: "object",
            required: ["amount", "reason"],
            properties: {
              amount: { type: "number" },
              reason: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id: orderId } = request.params as { id: string };
        const body = request.body as { amount: number; reason: string };

        // Verify order exists
        const found = await findOrderById(database.db, orderId);
        if (!found) {
          return reply
            .status(404)
            .send({ error: "ERR_ORDER_NOT_FOUND", message: "Order not found" });
        }

        const actorAdminUserId = request.adminContext?.adminUserId ?? "";

        try {
          const refundRecord = await processRefund(database.db, {
            orderId,
            amountMinor: body.amount,
            reason: body.reason,
            actorAdminUserId,
            createStripeRefund: async (paymentIntentId, amountMinor) => {
              return paymentAdapter.createRefund({
                paymentIntentId,
                amountMinor,
                reason: body.reason,
              });
            },
          });

          // Set audit context for automatic audit logging
          request.auditContext = {
            action: "refund.create",
            entityType: "order",
            entityId: orderId,
            afterJson: {
              refundId: refundRecord.id,
              amountMinor: refundRecord.amountMinor,
              reason: refundRecord.reason,
            },
          };

          return reply.status(201).send({ refund: refundRecord });
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_REFUND_EXCEEDS_PAYMENT") {
            return reply.status(400).send({
              error: "ERR_REFUND_EXCEEDS_PAYMENT",
              message: error.message,
            });
          }
          if (error.code === "ERR_PAYMENT_NOT_FOUND") {
            return reply.status(400).send({
              error: "ERR_PAYMENT_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_VALIDATION") {
            return reply.status(400).send({
              error: "ERR_VALIDATION",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // List refunds for an order
    app.get(
      "/api/admin/orders/:id/refunds",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.ORDERS_REFUND)],
      },
      async (request, reply) => {
        const { id: orderId } = request.params as { id: string };
        const found = await findOrderById(database.db, orderId);
        if (!found) {
          return reply
            .status(404)
            .send({ error: "ERR_ORDER_NOT_FOUND", message: "Order not found" });
        }
        const refunds = await findRefundsByOrderId(database.db, orderId);
        return { refunds };
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

          // Queue low-stock alert if applicable
          if (result.lowStock) {
            await lowStockAlertService.checkAndQueue(
              database.db,
              body.variant_id,
              result.balance.available,
              result.balance.safetyStock,
            );
          }

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

          // Check for low-stock after reservation decremented available
          const balanceAfter = await findBalanceByVariantAndLocation(
            database.db,
            body.variant_id,
            body.location_id,
          );
          if (balanceAfter && balanceAfter.available < balanceAfter.safetyStock) {
            await lowStockAlertService.checkAndQueue(
              database.db,
              body.variant_id,
              balanceAfter.available,
              balanceAfter.safetyStock,
            );
          }

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
    // Kit Definition CRUD — /admin/kits
    // -----------------------------------------------------------------------

    // List kit definitions
    app.get(
      "/api/admin/kits",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async () => {
        const kits = await listKitDefinitions(database.db);
        return { kits };
      },
    );

    // Create kit definition
    app.post(
      "/api/admin/kits",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const body = request.body as {
          slug?: string;
          title?: string;
          description?: string;
          price_minor?: number;
          status?: string;
          requirements?: Array<{ product_class_id: string; quantity: number }>;
        };

        if (!body.slug || !body.title || body.price_minor === undefined) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "slug, title, and price_minor are required",
          });
        }

        const kit = await insertKitDefinition(database.db, {
          slug: body.slug,
          title: body.title,
          description: body.description ?? null,
          priceMinor: body.price_minor,
          status: body.status ?? "draft",
        });

        // Set requirements if provided
        let requirements: Awaited<ReturnType<typeof setKitClassRequirements>> = [];
        if (body.requirements && body.requirements.length > 0) {
          requirements = await setKitClassRequirements(
            database.db,
            kit.id,
            body.requirements.map((r) => ({
              productClassId: r.product_class_id,
              quantity: r.quantity,
            })),
          );
        }

        request.auditContext = {
          action: "CREATE",
          entityType: "kit_definition",
          entityId: kit.id,
          beforeJson: null,
          afterJson: { ...kit, requirements },
        };

        return reply.status(201).send({ kit, requirements });
      },
    );

    // Get kit definition with requirements
    app.get(
      "/api/admin/kits/:kitId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async (request, reply) => {
        const { kitId } = request.params as { kitId: string };
        const kit = await findKitDefinitionById(database.db, kitId);
        if (!kit) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Kit definition not found",
          });
        }
        const requirements = await findKitClassRequirements(database.db, kitId);
        return { kit, requirements };
      },
    );

    // Update kit definition
    app.put(
      "/api/admin/kits/:kitId",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { kitId } = request.params as { kitId: string };
        const existing = await findKitDefinitionById(database.db, kitId);
        if (!existing) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Kit definition not found",
          });
        }

        const body = request.body as {
          slug?: string;
          title?: string;
          description?: string;
          price_minor?: number;
          status?: string;
          requirements?: Array<{ product_class_id: string; quantity: number }>;
        };

        const updated = await updateKitDefinition(database.db, kitId, {
          ...(body.slug !== undefined && { slug: body.slug }),
          ...(body.title !== undefined && { title: body.title }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.price_minor !== undefined && { priceMinor: body.price_minor }),
          ...(body.status !== undefined && { status: body.status }),
        });

        let requirements: Awaited<ReturnType<typeof setKitClassRequirements>> | undefined;
        if (body.requirements) {
          requirements = await setKitClassRequirements(
            database.db,
            kitId,
            body.requirements.map((r) => ({
              productClassId: r.product_class_id,
              quantity: r.quantity,
            })),
          );
        }

        request.auditContext = {
          action: "UPDATE",
          entityType: "kit_definition",
          entityId: kitId,
          beforeJson: existing,
          afterJson: { ...updated, requirements },
        };

        return { kit: updated, requirements };
      },
    );

    // Set kit class requirements
    app.put(
      "/api/admin/kits/:kitId/requirements",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const { kitId } = request.params as { kitId: string };
        const kit = await findKitDefinitionById(database.db, kitId);
        if (!kit) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Kit definition not found",
          });
        }

        const body = request.body as {
          requirements?: Array<{ product_class_id: string; quantity: number }>;
        };

        if (!body.requirements || !Array.isArray(body.requirements)) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "requirements array is required",
          });
        }

        const requirements = await setKitClassRequirements(
          database.db,
          kitId,
          body.requirements.map((r) => ({
            productClassId: r.product_class_id,
            quantity: r.quantity,
          })),
        );

        request.auditContext = {
          action: "UPDATE",
          entityType: "kit_class_requirement",
          entityId: kitId,
          beforeJson: null,
          afterJson: requirements,
        };

        return { requirements };
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
  // Public catalog API — no auth required
  // -------------------------------------------------------------------------

  if (database) {
    // GET /api/products — list active products with variants, media, availability
    app.get("/api/products", async (_request, reply) => {
      const products = await findActiveProductsWithDetails(database.db);
      return reply.status(200).send({ products });
    });

    // GET /api/products/:slug — product detail by slug
    app.get("/api/products/:slug", async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const found = await findActiveProductBySlug(database.db, slug);
      if (!found) {
        return reply.status(404).send({
          error: "ERR_NOT_FOUND",
          message: "Product not found",
        });
      }
      return reply.status(200).send({ product: found });
    });
  }

  // -------------------------------------------------------------------------
  // Cart API — guest carts via X-Cart-Token, authenticated via session
  // -------------------------------------------------------------------------

  if (database) {
    const db = database.db;

    // POST /api/cart — create a new guest cart (or return existing for authenticated user)
    app.post("/api/cart", async (request, reply) => {
      // Check if authenticated customer via session (optional)
      let customerId: string | undefined;
      const session = request.session;
      if (session) {
        try {
          const authSubject = session.getUserId();
          const customer = await getCustomerByAuthSubject(db, authSubject);
          if (customer) {
            customerId = customer.id;
            // Return existing active cart if one exists
            const existing = await findActiveCartByCustomerId(db, customerId);
            if (existing) {
              const cartWithItems = await getCartWithItems(db, existing.id);
              return reply.status(200).send({ cart: cartWithItems });
            }
          }
        } catch {
          // Session invalid — create guest cart
        }
      }

      const newCart = await createCart(db, customerId);
      const cartWithItems = await getCartWithItems(db, newCart.id);
      return reply.status(201).send({ cart: cartWithItems });
    });

    // Helper to resolve cart from X-Cart-Token header
    async function resolveCart(request: {
      headers: Record<string, string | string[] | undefined>;
    }) {
      const token = request.headers["x-cart-token"] as string | undefined;
      if (!token) return undefined;
      return findCartByToken(db, token);
    }

    // POST /api/cart/items — add item to cart
    app.post("/api/cart/items", async (request, reply) => {
      const cartRow = await resolveCart(request);
      if (!cartRow) {
        return reply.status(404).send({
          error: "ERR_CART_NOT_FOUND",
          message: "Cart not found. Create a cart first or provide a valid X-Cart-Token.",
        });
      }

      const body = request.body as {
        variant_id?: string;
        quantity?: number;
      };

      if (!body.variant_id) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "variant_id is required",
        });
      }

      const quantity = body.quantity ?? 1;
      if (quantity < 1) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "quantity must be at least 1",
        });
      }

      try {
        const item = await addCartItem(db, cartRow.id, body.variant_id, quantity);
        const cartWithItems = await getCartWithItems(db, cartRow.id);
        return reply.status(201).send({ item, cart: cartWithItems });
      } catch (err: unknown) {
        const appErr = err as { code?: string; message?: string };
        if (appErr.code === "ERR_VARIANT_NOT_FOUND") {
          return reply.status(404).send({
            error: "ERR_VARIANT_NOT_FOUND",
            message: "Variant not found",
          });
        }
        if (appErr.code === "ERR_VARIANT_NOT_AVAILABLE") {
          return reply.status(400).send({
            error: "ERR_VARIANT_NOT_AVAILABLE",
            message: "Variant is not available for purchase",
          });
        }
        if (appErr.code === "ERR_INVENTORY_INSUFFICIENT") {
          return reply.status(400).send({
            error: "ERR_INVENTORY_INSUFFICIENT",
            message: appErr.message ?? "Insufficient inventory",
          });
        }
        throw err;
      }
    });

    // DELETE /api/cart/items/:id — remove item from cart
    app.delete("/api/cart/items/:id", async (request, reply) => {
      const cartRow = await resolveCart(request);
      if (!cartRow) {
        return reply.status(404).send({
          error: "ERR_CART_NOT_FOUND",
          message: "Cart not found",
        });
      }

      const { id } = request.params as { id: string };
      const removed = await removeCartItem(db, id, cartRow.id);
      if (!removed) {
        return reply.status(404).send({
          error: "ERR_CART_ITEM_NOT_FOUND",
          message: "Cart item not found",
        });
      }

      const cartWithItems = await getCartWithItems(db, cartRow.id);
      return reply.status(200).send({ cart: cartWithItems });
    });

    // POST /api/cart/kits — add kit to cart with selected variants per class
    app.post("/api/cart/kits", async (request, reply) => {
      const cartRow = await resolveCart(request);
      if (!cartRow) {
        return reply.status(404).send({
          error: "ERR_CART_NOT_FOUND",
          message: "Cart not found. Create a cart first or provide a valid X-Cart-Token.",
        });
      }

      const body = request.body as {
        kit_definition_id?: string;
        selections?: Array<{ product_class_id: string; variant_id: string }>;
      };

      if (!body.kit_definition_id) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "kit_definition_id is required",
        });
      }

      if (!body.selections || !Array.isArray(body.selections) || body.selections.length === 0) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "selections array is required and must not be empty",
        });
      }

      try {
        const result = await addKitToCart(db, cartRow.id, body.kit_definition_id, body.selections);
        const cartWithItems = await getCartWithItems(db, cartRow.id);
        return reply.status(201).send({ kit: result, cart: cartWithItems });
      } catch (err: unknown) {
        const appErr = err as { code?: string; message?: string; alternatives?: string[] };
        if (appErr.code === "ERR_KIT_NOT_FOUND") {
          return reply.status(404).send({
            error: "ERR_KIT_NOT_FOUND",
            message: "Kit definition not found",
          });
        }
        if (appErr.code === "ERR_KIT_NOT_AVAILABLE") {
          return reply.status(400).send({
            error: "ERR_KIT_NOT_AVAILABLE",
            message: "Kit is not available",
          });
        }
        if (appErr.code === "ERR_KIT_INCOMPLETE") {
          return reply.status(400).send({
            error: "ERR_KIT_INCOMPLETE",
            message: appErr.message ?? "Kit requirements not satisfied",
          });
        }
        if (appErr.code === "ERR_KIT_EXCESS_SELECTIONS") {
          return reply.status(400).send({
            error: "ERR_KIT_EXCESS_SELECTIONS",
            message: appErr.message ?? "Too many selections",
          });
        }
        if (appErr.code === "ERR_KIT_INVALID_CLASS") {
          return reply.status(400).send({
            error: "ERR_KIT_INVALID_CLASS",
            message: appErr.message ?? "Invalid class selection",
          });
        }
        if (appErr.code === "ERR_VARIANT_NOT_FOUND") {
          return reply.status(404).send({
            error: "ERR_VARIANT_NOT_FOUND",
            message: "Variant not found",
          });
        }
        if (appErr.code === "ERR_VARIANT_NOT_AVAILABLE") {
          return reply.status(400).send({
            error: "ERR_VARIANT_NOT_AVAILABLE",
            message: "Variant is not available",
          });
        }
        if (appErr.code === "ERR_KIT_CLASS_MISMATCH") {
          return reply.status(400).send({
            error: "ERR_KIT_CLASS_MISMATCH",
            message: appErr.message ?? "Variant does not belong to specified class",
          });
        }
        if (appErr.code === "ERR_KIT_COMPONENT_OUT_OF_STOCK") {
          return reply.status(400).send({
            error: "ERR_KIT_COMPONENT_OUT_OF_STOCK",
            message: appErr.message ?? "Component out of stock",
            alternatives: appErr.alternatives ?? [],
          });
        }
        throw err;
      }
    });

    // GET /api/cart — get cart with current prices + availability
    app.get("/api/cart", async (request, reply) => {
      const cartRow = await resolveCart(request);
      if (!cartRow) {
        return reply.status(404).send({
          error: "ERR_CART_NOT_FOUND",
          message: "Cart not found. Provide a valid X-Cart-Token header.",
        });
      }

      const cartWithItems = await getCartWithItems(db, cartRow.id);
      return reply.status(200).send({ cart: cartWithItems });
    });
  }

  // -------------------------------------------------------------------------
  // Checkout API
  // -------------------------------------------------------------------------

  if (database) {
    const db = database.db;

    // Warehouse origin address for shipping calculations
    const warehouseAddress = {
      line1: "1234 Warehouse Way",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    };

    app.post("/api/checkout", async (request, reply) => {
      const body = request.body as {
        cart_token?: string;
        email?: string;
        shipping_address?: CheckoutAddress;
        billing_address?: CheckoutAddress;
      };

      // Validate required fields
      if (!body.cart_token) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "cart_token is required",
        });
      }
      if (!body.email) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "email is required",
        });
      }
      if (!body.shipping_address) {
        return reply.status(400).send({
          error: "ERR_VALIDATION",
          message: "shipping_address is required",
        });
      }

      const shippingAddr = body.shipping_address;

      // US-only address validation
      const country = shippingAddr.country ?? "US";
      if (country !== "US") {
        return reply.status(400).send({
          error: "ERR_NON_US_ADDRESS",
          message: "Only US addresses are supported",
        });
      }

      // Validate address fields
      if (!shippingAddr.full_name?.trim()) {
        return reply
          .status(400)
          .send({ error: "ERR_VALIDATION", message: "shipping_address.full_name is required" });
      }
      if (!shippingAddr.line1?.trim()) {
        return reply
          .status(400)
          .send({ error: "ERR_VALIDATION", message: "shipping_address.line1 is required" });
      }
      if (!shippingAddr.city?.trim()) {
        return reply
          .status(400)
          .send({ error: "ERR_VALIDATION", message: "shipping_address.city is required" });
      }
      if (!shippingAddr.state?.trim()) {
        return reply
          .status(400)
          .send({ error: "ERR_VALIDATION", message: "shipping_address.state is required" });
      }
      if (!shippingAddr.postal_code?.trim()) {
        return reply
          .status(400)
          .send({ error: "ERR_VALIDATION", message: "shipping_address.postal_code is required" });
      }

      // Resolve and validate cart
      const cartRow = await findCartByToken(db, body.cart_token);
      if (!cartRow) {
        return reply.status(404).send({
          error: "ERR_CART_NOT_FOUND",
          message: "Cart not found",
        });
      }

      const cartWithItems = await getCartWithItems(db, cartRow.id);
      if (!cartWithItems || cartWithItems.items.length === 0) {
        return reply.status(400).send({
          error: "ERR_CART_EMPTY",
          message: "Cart is empty",
        });
      }

      // Check for stale items (price changes or insufficient stock)
      const staleItems = cartWithItems.items.filter(
        (item) => item.priceChanged || item.insufficientStock,
      );
      if (staleItems.length > 0) {
        return reply.status(400).send({
          error: "ERR_CART_STALE",
          message: "Cart contains items with price changes or insufficient stock",
          stale_items: staleItems.map((item) => ({
            variant_id: item.variantId,
            sku: item.sku,
            price_changed: item.priceChanged,
            insufficient_stock: item.insufficientStock,
          })),
        });
      }

      // Resolve customer if authenticated
      let customerId: string | undefined;
      const session = request.session;
      if (session) {
        try {
          const authSubject = session.getUserId();
          const customer = await getCustomerByAuthSubject(db, authSubject);
          if (customer) customerId = customer.id;
        } catch {
          // Guest checkout
        }
      }

      // 1. Create inventory reservations (15 min TTL)
      const reservationIds: string[] = [];
      try {
        // Find the default location (first available)
        const balances = await findInventoryBalances(db, {});
        const defaultLocationId = balances[0]?.locationId;
        if (!defaultLocationId) {
          return reply.status(500).send({
            error: "ERR_NO_INVENTORY_LOCATION",
            message: "No inventory location configured",
          });
        }

        for (const item of cartWithItems.items) {
          const result = await reserveInventory(db, {
            variantId: item.variantId,
            locationId: defaultLocationId,
            quantity: item.quantity,
            ttlMs: 15 * 60 * 1000, // 15 minutes
            reservationReason: "checkout",
            cartId: cartWithItems.id,
          });
          reservationIds.push(result.reservation.id);
        }
      } catch (err: unknown) {
        // Release any reservations already made
        for (const rid of reservationIds) {
          try {
            await releaseReservation(db, rid);
          } catch {
            // Best-effort cleanup
          }
        }
        const appErr = err as { code?: string; message?: string };
        if (appErr.code === "ERR_INVENTORY_INSUFFICIENT") {
          return reply.status(400).send({
            error: "ERR_INVENTORY_INSUFFICIENT",
            message: appErr.message ?? "Insufficient inventory",
          });
        }
        throw err;
      }

      // 2. Calculate shipping via shipping adapter
      let shippingAmountMinor: number;
      try {
        const shippingResult = await shippingAdapter.calculateRate(
          warehouseAddress,
          {
            line1: shippingAddr.line1,
            city: shippingAddr.city,
            state: shippingAddr.state,
            postalCode: shippingAddr.postal_code,
            country: country,
          },
          cartWithItems.items.map((item) => ({
            weightOz: 16, // Default 1 lb per item
            quantity: item.quantity,
          })),
        );
        shippingAmountMinor = shippingResult.shippingAmountMinor;
      } catch (err) {
        // Release reservations on failure
        for (const rid of reservationIds) {
          try {
            await releaseReservation(db, rid);
          } catch {
            /* best-effort */
          }
        }
        throw err;
      }

      // 3. Calculate tax via tax adapter
      let taxAmountMinor: number;
      let taxCalculationId: string | null;
      try {
        const taxResult = await taxAdapter.calculate(
          cartWithItems.items.map((item) => ({
            amount: item.lineTotalMinor,
            reference: item.sku,
            quantity: item.quantity,
          })),
          {
            line1: shippingAddr.line1,
            line2: shippingAddr.line2,
            city: shippingAddr.city,
            state: shippingAddr.state,
            postalCode: shippingAddr.postal_code,
            country: country,
          },
        );
        taxAmountMinor = taxResult.taxAmountMinor;
        taxCalculationId = taxResult.calculationId;
      } catch (err) {
        // Release reservations on failure
        for (const rid of reservationIds) {
          try {
            await releaseReservation(db, rid);
          } catch {
            /* best-effort */
          }
        }
        throw err;
      }

      // 4. Compute totals
      const subtotalMinor = cartWithItems.subtotalMinor;
      const totalMinor = subtotalMinor + taxAmountMinor + shippingAmountMinor;

      // 5. Create Stripe PaymentIntent via payment adapter
      let paymentIntentId: string;
      let clientSecret: string;
      try {
        const piResult = await paymentAdapter.createPaymentIntent({
          amountMinor: totalMinor,
          currency: "usd",
          metadata: {
            cart_id: cartWithItems.id,
            ...(taxCalculationId ? { tax_calculation_id: taxCalculationId } : {}),
          },
        });
        paymentIntentId = piResult.id;
        clientSecret = piResult.clientSecret;
      } catch (err) {
        // Release reservations on failure
        for (const rid of reservationIds) {
          try {
            await releaseReservation(db, rid);
          } catch {
            /* best-effort */
          }
        }
        const stripeErr = err as { type?: string; code?: string };
        if (stripeErr.type === "StripeConnectionError" || stripeErr.type === "StripeAPIError") {
          return reply.status(502).send({
            error: "ERR_EXTERNAL_SERVICE_UNAVAILABLE",
            message: "Payment service is temporarily unavailable",
          });
        }
        throw err;
      }

      // 6. Generate order number and create order
      const orderNumber = await generateOrderNumber(db);
      const newOrder = await createCheckoutOrder(db, {
        orderNumber,
        email: body.email,
        customerId,
        cartWithItems,
        shippingAddress: shippingAddr,
        billingAddress: body.billing_address,
        subtotalMinor,
        taxMinor: taxAmountMinor,
        shippingMinor: shippingAmountMinor,
        totalMinor,
        stripePaymentIntentId: paymentIntentId,
      });

      // 7. Update reservations with order ID
      for (const rid of reservationIds) {
        try {
          await db.execute(
            sql`UPDATE inventory_reservation SET order_id = ${newOrder.id} WHERE id = ${rid}`,
          );
        } catch {
          // Non-critical — reservations still protect inventory
        }
      }

      return reply.status(201).send({
        order: {
          id: newOrder.id,
          order_number: newOrder.orderNumber,
          email: newOrder.email,
          status: newOrder.status,
          payment_status: newOrder.paymentStatus,
          subtotal_minor: newOrder.subtotalMinor,
          tax_minor: newOrder.taxMinor,
          shipping_minor: newOrder.shippingMinor,
          total_minor: newOrder.totalMinor,
        },
        client_secret: clientSecret,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Stripe Webhook Handler
  // -------------------------------------------------------------------------

  if (database) {
    const db = database.db;

    app.post("/webhooks/stripe", {
      // Use preParsing hook to capture raw body for signature verification
      config: { rawBody: true },
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const rawBody = Buffer.concat(chunks);
        (request as unknown as Record<string, unknown>).rawBody = rawBody;
        // Return a readable stream with the raw body so Fastify can still parse JSON
        const { Readable } = await import("node:stream");
        return Readable.from(rawBody);
      },
      handler: async (request, reply) => {
        const signature = request.headers["stripe-signature"] as string | undefined;
        if (!signature) {
          return reply.status(401).send({
            error: "ERR_MISSING_SIGNATURE",
            message: "Missing stripe-signature header",
          });
        }

        const rawBody = (request as unknown as Record<string, unknown>).rawBody as Buffer;

        // Verify webhook signature
        let event: Stripe.Event;
        try {
          const stripe = new Stripe(config.STRIPE_SECRET_KEY);
          event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "Invalid signature";
          return reply.status(401).send({
            error: "ERR_INVALID_SIGNATURE",
            message: errMsg,
          });
        }

        // Idempotency check: skip if event already processed
        const alreadyProcessed = await hasEventBeenProcessed(db, event.id);
        if (alreadyProcessed) {
          return reply.status(200).send({ received: true, duplicate: true });
        }

        // Route by event type
        const eventType = event.type;

        if (eventType === "payment_intent.succeeded") {
          const pi = event.data.object as Stripe.PaymentIntent;
          const paymentRecord = await findPaymentByIntentId(db, pi.id);
          if (!paymentRecord) {
            logger.warn({ piId: pi.id }, "No payment found for PaymentIntent");
            return reply.status(200).send({ received: true, skipped: true });
          }

          // Extract charge ID from the latest charge
          const chargeId =
            typeof pi.latest_charge === "string"
              ? pi.latest_charge
              : (pi.latest_charge as Stripe.Charge | null)?.id;

          // Store event record
          await storePaymentEvent(db, {
            paymentId: paymentRecord.id,
            providerEventId: event.id,
            eventType,
            payloadJson: event.data.object,
          });

          await handlePaymentSucceeded(db, paymentRecord, chargeId ?? undefined);
        } else if (eventType === "payment_intent.payment_failed") {
          const pi = event.data.object as Stripe.PaymentIntent;
          const paymentRecord = await findPaymentByIntentId(db, pi.id);
          if (!paymentRecord) {
            logger.warn({ piId: pi.id }, "No payment found for PaymentIntent");
            return reply.status(200).send({ received: true, skipped: true });
          }

          await storePaymentEvent(db, {
            paymentId: paymentRecord.id,
            providerEventId: event.id,
            eventType,
            payloadJson: event.data.object,
          });

          await handlePaymentFailed(db, paymentRecord);
        } else if (eventType === "charge.refunded") {
          const charge = event.data.object as Stripe.Charge;
          const paymentRecord = await findPaymentByChargeId(db, charge.id);
          if (!paymentRecord) {
            // Try to find by payment intent ID
            const piId =
              typeof charge.payment_intent === "string"
                ? charge.payment_intent
                : (charge.payment_intent as Stripe.PaymentIntent | null)?.id;
            if (piId) {
              const byPi = await findPaymentByIntentId(db, piId);
              if (byPi) {
                await storePaymentEvent(db, {
                  paymentId: byPi.id,
                  providerEventId: event.id,
                  eventType,
                  payloadJson: event.data.object,
                });
                const refundAmount = charge.amount_refunded;
                await handleChargeRefunded(db, byPi, refundAmount);
                return reply.status(200).send({ received: true });
              }
            }
            logger.warn({ chargeId: charge.id }, "No payment found for charge");
            return reply.status(200).send({ received: true, skipped: true });
          }

          await storePaymentEvent(db, {
            paymentId: paymentRecord.id,
            providerEventId: event.id,
            eventType,
            payloadJson: event.data.object,
          });

          const refundAmount = charge.amount_refunded;
          await handleChargeRefunded(db, paymentRecord, refundAmount);
        } else if (eventType === "charge.dispute.created") {
          const disputeObj = event.data.object as Stripe.Dispute;
          const chargeId =
            typeof disputeObj.charge === "string"
              ? disputeObj.charge
              : (disputeObj.charge as Stripe.Charge | null)?.id;

          let paymentRecord: { id: string; orderId: string; amountMinor: number } | null = null;
          if (chargeId) {
            paymentRecord = await findPaymentByChargeId(db, chargeId);
          }
          if (!paymentRecord) {
            // Try via payment_intent
            const piId =
              typeof disputeObj.payment_intent === "string"
                ? disputeObj.payment_intent
                : (disputeObj.payment_intent as Stripe.PaymentIntent | null)?.id;
            if (piId) {
              paymentRecord = await findPaymentByIntentId(db, piId);
            }
          }
          if (!paymentRecord) {
            logger.warn({ disputeId: disputeObj.id }, "No payment found for dispute");
            return reply.status(200).send({ received: true, skipped: true });
          }

          await storePaymentEvent(db, {
            paymentId: paymentRecord.id,
            providerEventId: event.id,
            eventType,
            payloadJson: event.data.object,
          });

          await handleDisputeCreated(db, paymentRecord, {
            providerDisputeId: disputeObj.id,
            reason: disputeObj.reason ?? undefined,
            amountMinor: disputeObj.amount,
            currency: disputeObj.currency.toUpperCase(),
            openedAt: new Date(disputeObj.created * 1000),
            dueBy: disputeObj.evidence_details?.due_by
              ? new Date(disputeObj.evidence_details.due_by * 1000)
              : undefined,
          });
        } else {
          // Unhandled event type — acknowledge receipt
          logger.info({ eventType }, "Unhandled Stripe webhook event type");
        }

        return reply.status(200).send({ received: true });
      },
    });
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
  // Reservation cleanup cron
  // -------------------------------------------------------------------------

  const cleanupIntervalMs = options.reservationCleanupIntervalMs ?? undefined;
  if (database && cleanupIntervalMs !== 0) {
    const cleanup = startReservationCleanup({
      db: database.db,
      logger: createLogger({ level: config.LOG_LEVEL, module: "reservation-cleanup" }),
      intervalMs: cleanupIntervalMs,
    });
    shutdownManager.register({
      name: "stop reservation cleanup cron",
      fn: async () => {
        cleanup.stop();
      },
    });
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  async function start(): Promise<string> {
    const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
    logger.info(`Server listening on ${address}`);
    return address;
  }

  return {
    app,
    shutdownManager,
    lowStockAlertService,
    taxAdapter,
    shippingAdapter,
    paymentAdapter,
    start,
  };
}
