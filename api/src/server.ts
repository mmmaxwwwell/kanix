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
  unlinkGitHubFromCustomer,
  createGitHubUserFetcher,
  createRequireAdmin,
  requireCapability,
  registerAdminAuditLog,
  registerAuthEventLogger,
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
  findAdjustmentByIdempotencyKey,
  findAdjustmentsByVariant,
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
  flagCartsForKitRevalidation,
  findActiveKitsWithDetails,
} from "./db/queries/kit.js";
import {
  reserveInventory,
  consumeReservation,
  releaseReservation,
  findReservationById,
  listReservations,
  getReservationStats,
  forceReleaseReservation,
} from "./db/queries/reservation.js";
import { startReservationCleanup } from "./cron/reservation-cleanup.js";
import {
  createLowStockAlertService,
  type LowStockAlertService,
} from "./services/low-stock-alert.js";
import { createAdminAlertService, type AdminAlertService } from "./services/admin-alert.js";
import { createNotificationService, type NotificationService } from "./services/notification.js";
import { createTaxAdapter, type TaxAdapter } from "./services/tax-adapter.js";
import { createShippingAdapter, type ShippingAdapter } from "./services/shipping-adapter.js";
import { sql, eq } from "drizzle-orm";
import { customer } from "./db/schema/customer.js";
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
import { resendOrderConfirmation } from "./db/queries/order-resend-confirmation.js";
import {
  listFulfillmentTasks,
  findFulfillmentTaskById,
  findFulfillmentTasksByOrderId,
  transitionFulfillmentTaskStatus,
  assignFulfillmentTask,
  blockFulfillmentTask,
  unblockFulfillmentTask,
  cancelFulfillmentTask,
} from "./db/queries/fulfillment-task.js";
import {
  createShipment,
  findShipmentById,
  findShipmentsByOrderId,
  findShipmentLinesByShipmentId,
  findShipmentPackagesByShipmentId,
  buyShipmentLabel,
  voidShipmentLabel,
  transitionShipmentStatus,
  findLabelPurchasesByShipmentId,
  findShipmentByTrackingNumber,
  hasShipmentEventBeenProcessed,
  storeShipmentEvent,
  handleTrackingUpdate,
  refreshShipmentTracking,
  markShipmentShipped,
} from "./db/queries/shipment.js";
import {
  insertPolicySnapshot,
  findPoliciesByType,
  findCurrentPolicyByType,
  createCheckoutAcknowledgments,
  validateCheckoutPolicies,
} from "./db/queries/policy.js";
import {
  hasEventBeenProcessed,
  findPaymentByIntentId,
  findPaymentByChargeId,
  storePaymentEvent,
  handlePaymentSucceeded,
  handlePaymentFailed,
  handleChargeRefunded,
  handleDisputeCreated,
  handleDisputeClosed,
} from "./db/queries/webhook.js";
import { processRefund, findRefundsByOrderId } from "./db/queries/refund.js";
import {
  createSupportTicket,
  findTicketById,
  listSupportTickets,
  listTicketsByCustomerId,
  transitionTicketStatus,
  createTicketMessage,
  listTicketMessages,
  findTicketStatusHistory,
  dismissDuplicate,
  mergeTicket,
  createTicketAttachment,
  findAttachmentById,
  listAttachmentsByTicketId,
  createWarrantyClaim,
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
} from "./db/queries/support-ticket.js";
import { createStorageAdapter, type StorageAdapter } from "./services/storage-adapter.js";
import {
  findEvidenceByOrderId,
  findEvidenceById,
  computeReadinessSummary,
  findDisputeById,
  generateEvidenceBundle,
  createEvidenceRecord,
  listEvidence,
} from "./db/queries/evidence.js";
import {
  createContributor,
  findContributorById,
  listContributors,
  linkContributorDesign,
  listDesignsByContributor,
  processOrderCompletionSales,
  clawbackRoyaltyByOrderLine,
  clawbackRoyaltiesByOrderId,
  setContributorDonation,
  recordMilestone,
  listMilestonesByContributor,
  createTaxDocument,
  findTaxDocumentById,
  listTaxDocumentsByContributor,
  updateTaxDocumentStatus,
  createPayout,
  findContributorByCustomerId,
  getContributorDashboard,
  TAX_DOCUMENT_TYPES,
  type MilestoneType,
  type TaxDocumentType,
  MILESTONE_TYPES,
} from "./db/queries/contributor.js";
import { getDashboardSummary, getDashboardAlerts } from "./db/queries/dashboard.js";
import {
  listCustomers,
  getCustomerDetail,
  getCustomerOrders,
  getCustomerTickets,
  getCustomerAddresses,
  getCustomerAuditTrail,
  banCustomer,
  unbanCustomer,
  redactCustomerPII,
} from "./db/queries/customer.js";
import { getShippingSettings, updateShippingSettings } from "./db/queries/setting.js";
import { listAuthEvents } from "./db/queries/auth-event.js";
import type { ShippingSettings } from "./db/queries/setting.js";
import {
  getAlertPreference,
  upsertAlertPreference,
  getAllAdminAlertTargets,
} from "./db/queries/alert-preference.js";
import {
  createNotificationDispatchService,
  type NotificationDispatchService,
} from "./services/notification-dispatch.js";
import type { AlertChannel } from "./services/notification-dispatch.js";
import { registerWebSocket, type WsManager } from "./ws/manager.js";
import { createDomainEventPublisher } from "./ws/events.js";
import Stripe from "stripe";
import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

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
  /**
   * Override the function the shutdown manager calls after running hooks.
   * Defaults to `process.exit`. Pass a no-op for tests so hooks run without
   * terminating the worker.
   */
  exitFn?: (code: number) => void;
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
  /** Override the admin alert service (useful for testing). */
  adminAlertService?: AdminAlertService;
  /** Override the notification service (useful for testing). */
  notificationService?: NotificationService;
  /** Override the notification dispatch service (useful for testing). */
  notificationDispatch?: NotificationDispatchService;
  /** Override the storage adapter (useful for testing). */
  storageAdapter?: StorageAdapter;
}

export interface ServerInstance {
  app: FastifyInstance;
  shutdownManager: ShutdownManager;
  lowStockAlertService: LowStockAlertService;
  adminAlertService: AdminAlertService;
  taxAdapter: TaxAdapter;
  shippingAdapter: ShippingAdapter;
  paymentAdapter: PaymentAdapter;
  notificationService: NotificationService;
  notificationDispatch: NotificationDispatchService;
  storageAdapter: StorageAdapter;
  wsManager?: WsManager;
  domainEvents: import("./ws/events.js").DomainEventPublisher;
  start(): Promise<string>;
  /**
   * Run every registered shutdown hook (close DB pool, stop the reservation
   * cleanup cron, clear rate limiter state, close WS connections, …) without
   * terminating the process. Use from test `afterAll` so integration-test
   * workers don't leak a server's worth of intervals and state per file.
   */
  stop(): Promise<void>;
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
  const adminAlertService = options.adminAlertService ?? createAdminAlertService();
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
  const notificationService = options.notificationService ?? createNotificationService();
  const storageAdapter = options.storageAdapter ?? createStorageAdapter();

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
    adminAlertService,
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

  // Register auth event logger (login, logout, signup, failed_login)
  if (database) {
    registerAuthEventLogger(app, database.db);
  }

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
  // Public Stripe config — publishable key for client-side SDK init
  // -------------------------------------------------------------------------

  app.get("/api/customer/stripe/config", async (_request, reply) => {
    return reply.status(200).send({
      publishableKey: config.PUBLIC_STRIPE_PUBLISHABLE_KEY,
    });
  });

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

      // Idempotent: same customer re-linking the same GitHub ID → 200
      if (cust.githubUserId === githubUserId) {
        return {
          customer: {
            id: cust.id,
            github_user_id: cust.githubUserId,
          },
        };
      }

      // Already linked to a DIFFERENT GitHub ID
      if (cust.githubUserId) {
        return reply.status(409).send({
          error: "ERR_ALREADY_LINKED",
          message: "GitHub account already linked to this customer",
        });
      }

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
  // Unlink GitHub Account endpoint — requires verified email
  // -------------------------------------------------------------------------

  app.delete(
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

      const userId = session.getUserId();
      const cust = await getCustomerByAuthSubject(database.db, userId);
      if (!cust) {
        return reply.status(404).send({
          error: "ERR_NOT_FOUND",
          message: "Customer record not found",
        });
      }

      if (!cust.githubUserId) {
        return reply.status(409).send({
          error: "ERR_NOT_LINKED",
          message: "No GitHub account linked to this customer",
        });
      }

      const updated = await unlinkGitHubFromCustomer(database.db, cust.id);
      if (!updated) {
        return reply.status(500).send({
          error: "ERR_INTERNAL",
          message: "Failed to unlink GitHub account",
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

    // Admin audit log — auth events (login, logout, signup, failed_login, password_reset)
    app.get(
      "/api/admin/audit-log",
      {
        preHandler: [verifySession, requireAdmin],
      },
      async (request) => {
        const query = request.query as {
          actor_id?: string;
          event_type?: string;
          from?: string;
          to?: string;
          page?: string;
          limit?: string;
        };
        const result = await listAuthEvents(database.db, {
          actorId: query.actor_id,
          eventType: query.event_type,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
          page: query.page ? parseInt(query.page, 10) : undefined,
          limit: query.limit ? parseInt(query.limit, 10) : undefined,
        });
        return result;
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
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.ORDERS_MANAGE)],
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

        const actorAdminUserId = request.adminContext?.adminUserId ?? "";

        try {
          const result = await transitionOrderStatus(database.db, {
            orderId: id,
            statusType: body.status_type,
            newValue: body.new_value,
            reason: body.reason,
            actorAdminUserId,
          });
          // Track per-design sales on order completion
          if (body.status_type === "status" && body.new_value === "completed") {
            try {
              await processOrderCompletionSales(database.db, id);
            } catch {
              // Non-fatal: sales tracking failure should not block status transition
            }
          }
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
    // Order Cancellation
    // -----------------------------------------------------------------------

    // Cancel an order (admin)
    app.post(
      "/api/admin/orders/:id/cancel",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.ORDERS_CANCEL)],
        schema: {
          body: {
            type: "object",
            required: ["reason"],
            properties: {
              reason: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id: orderId } = request.params as { id: string };
        const body = request.body as { reason: string };

        const actorAdminUserId = request.adminContext?.adminUserId ?? "";

        try {
          const result = await cancelOrder(database.db, {
            orderId,
            reason: body.reason,
            actorAdminUserId,
            paymentAdapter,
          });

          // Set audit context for automatic audit logging
          request.auditContext = {
            action: "order.cancel",
            entityType: "order",
            entityId: orderId,
            afterJson: {
              reason: body.reason,
              reservationsReleased: result.reservationsReleased,
              refundInitiated: result.refundInitiated,
              refundId: result.refundId,
            },
          };

          return { ...result };
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_ORDER_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_ORDER_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_ORDER_ALREADY_SHIPPED") {
            return reply.status(400).send({
              error: "ERR_ORDER_ALREADY_SHIPPED",
              message: error.message,
            });
          }
          if (error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({
              error: "ERR_INVALID_TRANSITION",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // Resend order confirmation email
    app.post(
      "/api/admin/orders/:id/resend-confirmation",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.ORDERS_MANAGE)],
      },
      async (request, reply) => {
        const { id: orderId } = request.params as { id: string };

        try {
          const result = await resendOrderConfirmation(database.db, orderId, notificationService);

          request.auditContext = {
            action: "order.resend_confirmation",
            entityType: "order",
            entityId: orderId,
            afterJson: { email: result.email },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_ORDER_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_ORDER_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_RATE_LIMIT_EXCEEDED") {
            return reply.status(429).send({
              error: "ERR_RATE_LIMIT_EXCEEDED",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // Fulfillment Tasks
    // -----------------------------------------------------------------------

    // List fulfillment tasks with optional filters
    app.get(
      "/api/admin/fulfillment-tasks",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.FULFILLMENT_READ)],
      },
      async (request) => {
        const query = request.query as {
          status?: string;
          priority?: string;
          assigned_admin_user_id?: string;
        };
        const tasks = await listFulfillmentTasks(database.db, {
          status: query.status,
          priority: query.priority,
          assignedAdminUserId: query.assigned_admin_user_id,
        });
        return { tasks };
      },
    );

    // Get fulfillment task by ID
    app.get(
      "/api/admin/fulfillment-tasks/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.FULFILLMENT_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const task = await findFulfillmentTaskById(database.db, id);
        if (!task) {
          return reply
            .status(404)
            .send({ error: "ERR_TASK_NOT_FOUND", message: "Fulfillment task not found" });
        }
        return { task };
      },
    );

    // Get fulfillment tasks for an order
    app.get(
      "/api/admin/orders/:id/fulfillment-tasks",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.FULFILLMENT_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const found = await findOrderById(database.db, id);
        if (!found) {
          return reply
            .status(404)
            .send({ error: "ERR_ORDER_NOT_FOUND", message: "Order not found" });
        }
        const tasks = await findFulfillmentTasksByOrderId(database.db, id);
        return { tasks };
      },
    );

    // Transition fulfillment task status
    app.post(
      "/api/admin/fulfillment-tasks/:id/transition",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["new_status"],
            properties: {
              new_status: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { new_status: string; reason?: string };
        const actorAdminUserId = request.adminContext?.adminUserId ?? "";

        try {
          const result = await transitionFulfillmentTaskStatus(database.db, {
            taskId: id,
            newStatus: body.new_status,
            reason: body.reason,
            actorAdminUserId,
          });

          request.auditContext = {
            action: "fulfillment_task.transition",
            entityType: "fulfillment_task",
            entityId: id,
            afterJson: {
              oldStatus: result.oldStatus,
              newStatus: result.newStatus,
            },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({
              error: "ERR_INVALID_TRANSITION",
              message: error.message,
            });
          }
          if (error.code === "ERR_REASON_REQUIRED") {
            return reply.status(400).send({
              error: "ERR_REASON_REQUIRED",
              message: error.message,
            });
          }
          if (error.code === "ERR_TASK_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_TASK_NOT_FOUND",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // Block fulfillment task (with optional inventory adjustment)
    app.post(
      "/api/admin/fulfillment-tasks/:id/block",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["reason"],
            properties: {
              reason: { type: "string" },
              inventory_adjustment: {
                type: "object",
                required: ["variant_id", "location_id", "adjustment_type", "quantity_delta"],
                properties: {
                  variant_id: { type: "string" },
                  location_id: { type: "string" },
                  adjustment_type: { type: "string", enum: ["shrinkage", "correction", "damage"] },
                  quantity_delta: { type: "number" },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          reason: string;
          inventory_adjustment?: {
            variant_id: string;
            location_id: string;
            adjustment_type: "shrinkage" | "correction" | "damage";
            quantity_delta: number;
          };
        };
        const actorAdminUserId = request.adminContext?.adminUserId ?? "";

        try {
          const result = await blockFulfillmentTask(database.db, {
            taskId: id,
            reason: body.reason,
            actorAdminUserId,
            inventoryAdjustment: body.inventory_adjustment
              ? {
                  variantId: body.inventory_adjustment.variant_id,
                  locationId: body.inventory_adjustment.location_id,
                  adjustmentType: body.inventory_adjustment.adjustment_type,
                  quantityDelta: body.inventory_adjustment.quantity_delta,
                }
              : undefined,
          });

          request.auditContext = {
            action: "fulfillment_task.block",
            entityType: "fulfillment_task",
            entityId: id,
            afterJson: {
              oldStatus: result.task.oldStatus,
              newStatus: result.task.newStatus,
              reason: body.reason,
              hasInventoryAdjustment: !!result.inventoryAdjustmentResult,
            },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_INVALID_TRANSITION" || error.code === "ERR_REASON_REQUIRED") {
            return reply.status(400).send({ error: error.code, message: error.message });
          }
          if (error.code === "ERR_TASK_NOT_FOUND") {
            return reply.status(404).send({ error: error.code, message: error.message });
          }
          throw err;
        }
      },
    );

    // Unblock fulfillment task (returns to previous active state)
    app.post(
      "/api/admin/fulfillment-tasks/:id/unblock",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
          const result = await unblockFulfillmentTask(database.db, id);

          request.auditContext = {
            action: "fulfillment_task.unblock",
            entityType: "fulfillment_task",
            entityId: id,
            afterJson: {
              oldStatus: result.oldStatus,
              newStatus: result.newStatus,
            },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({ error: error.code, message: error.message });
          }
          if (error.code === "ERR_TASK_NOT_FOUND") {
            return reply.status(404).send({ error: error.code, message: error.message });
          }
          throw err;
        }
      },
    );

    // Cancel fulfillment task (with auto inventory return after picking)
    app.post(
      "/api/admin/fulfillment-tasks/:id/cancel",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["location_id"],
            properties: {
              reason: { type: "string" },
              location_id: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { reason?: string; location_id: string };
        const actorAdminUserId = request.adminContext?.adminUserId ?? "";

        try {
          const result = await cancelFulfillmentTask(database.db, {
            taskId: id,
            reason: body.reason,
            actorAdminUserId,
            locationId: body.location_id,
          });

          request.auditContext = {
            action: "fulfillment_task.cancel",
            entityType: "fulfillment_task",
            entityId: id,
            afterJson: {
              oldStatus: result.task.oldStatus,
              newStatus: result.task.newStatus,
              inventoryAdjustmentsCount: result.inventoryAdjustments.length,
            },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({ error: error.code, message: error.message });
          }
          if (error.code === "ERR_TASK_NOT_FOUND") {
            return reply.status(404).send({ error: error.code, message: error.message });
          }
          throw err;
        }
      },
    );

    // Assign fulfillment task to admin user
    app.post(
      "/api/admin/fulfillment-tasks/:id/assign",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["admin_user_id"],
            properties: {
              admin_user_id: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { admin_user_id: string };

        try {
          const result = await assignFulfillmentTask(database.db, id, body.admin_user_id);

          request.auditContext = {
            action: "fulfillment_task.assign",
            entityType: "fulfillment_task",
            entityId: id,
            afterJson: {
              assignedAdminUserId: body.admin_user_id,
            },
          };

          return { task: result };
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_TASK_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_TASK_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({
              error: "ERR_INVALID_TRANSITION",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // Shipments
    // -----------------------------------------------------------------------

    // Create a draft shipment for an order
    app.post(
      "/api/admin/shipments",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["order_id", "packages", "lines"],
            properties: {
              order_id: { type: "string" },
              packages: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    weight: { type: "number" },
                    dimensions: {
                      type: "object",
                      properties: {
                        length: { type: "number" },
                        width: { type: "number" },
                        height: { type: "number" },
                      },
                    },
                    package_type: { type: "string" },
                  },
                },
              },
              lines: {
                type: "array",
                items: {
                  type: "object",
                  required: ["order_line_id", "quantity"],
                  properties: {
                    order_line_id: { type: "string" },
                    quantity: { type: "integer", minimum: 1 },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const body = request.body as {
          order_id: string;
          packages: {
            weight?: number;
            dimensions?: { length?: number; width?: number; height?: number };
            package_type?: string;
          }[];
          lines: { order_line_id: string; quantity: number }[];
        };

        try {
          const result = await createShipment(database.db, {
            orderId: body.order_id,
            packages: body.packages.map((p) => ({
              weight: p.weight,
              dimensions: p.dimensions,
              packageType: p.package_type,
            })),
            lines: body.lines.map((l) => ({
              orderLineId: l.order_line_id,
              quantity: l.quantity,
            })),
          });

          request.auditContext = {
            action: "shipment.create",
            entityType: "shipment",
            entityId: result.shipment.id,
            afterJson: {
              orderId: body.order_id,
              shipmentNumber: result.shipment.shipmentNumber,
              packageCount: result.packages.length,
              lineCount: result.lines.length,
            },
          };

          return reply.status(201).send(result);
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_ORDER_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_ORDER_NOT_FOUND",
              message: error.message,
            });
          }
          if (
            error.code === "ERR_ORDER_LINE_NOT_FOUND" ||
            error.code === "ERR_ORDER_LINE_MISMATCH"
          ) {
            return reply.status(400).send({
              error: error.code,
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // Get shipment by ID
    app.get(
      "/api/admin/shipments/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.FULFILLMENT_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const found = await findShipmentById(database.db, id);
        if (!found) {
          return reply
            .status(404)
            .send({ error: "ERR_SHIPMENT_NOT_FOUND", message: "Shipment not found" });
        }
        const packages = await findShipmentPackagesByShipmentId(database.db, id);
        const lines = await findShipmentLinesByShipmentId(database.db, id);
        const purchases = await findLabelPurchasesByShipmentId(database.db, id);
        return { shipment: found, packages, lines, purchases };
      },
    );

    // Get shipments for an order
    app.get(
      "/api/admin/orders/:id/shipments",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.FULFILLMENT_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const found = await findOrderById(database.db, id);
        if (!found) {
          return reply
            .status(404)
            .send({ error: "ERR_ORDER_NOT_FOUND", message: "Order not found" });
        }
        const shipments = await findShipmentsByOrderId(database.db, id);
        return { shipments };
      },
    );

    // Buy label for a shipment
    app.post(
      "/api/admin/shipments/:id/buy-label",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["provider_shipment_id", "rate_id"],
            properties: {
              provider_shipment_id: { type: "string" },
              rate_id: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { provider_shipment_id: string; rate_id: string };

        try {
          const result = await buyShipmentLabel(
            database.db,
            {
              shipmentId: id,
              providerShipmentId: body.provider_shipment_id,
              rateId: body.rate_id,
            },
            shippingAdapter,
          );

          request.auditContext = {
            action: "shipment.buy_label",
            entityType: "shipment",
            entityId: id,
            afterJson: {
              trackingNumber: result.label.trackingNumber,
              carrier: result.label.carrier,
              service: result.label.service,
              costMinor: result.purchase.costMinor,
            },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_SHIPMENT_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_SHIPMENT_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_INVALID_STATE" || error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({
              error: error.code,
              message: error.message,
            });
          }
          if (error.code === "ERR_LABEL_PURCHASE_FAILED") {
            return reply.status(502).send({
              error: "ERR_LABEL_PURCHASE_FAILED",
              message: error.message,
              shipmentStatus: (err as { shipmentStatus?: string }).shipmentStatus,
            });
          }
          throw err;
        }
      },
    );

    // Void label for a shipment
    app.post(
      "/api/admin/shipments/:id/void-label",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
          const result = await voidShipmentLabel(database.db, id, shippingAdapter);

          request.auditContext = {
            action: "shipment.void_label",
            entityType: "shipment",
            entityId: id,
            afterJson: {
              status: result.shipment.status,
              refunded: result.refunded,
              refundedCostMinor: result.refundedCostMinor,
              labelCostCredited: result.labelCostCredited,
            },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_SHIPMENT_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_SHIPMENT_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_INVALID_STATE" || error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({
              error: error.code,
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // Transition shipment status
    app.post(
      "/api/admin/shipments/:id/transition",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["new_status"],
            properties: {
              new_status: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { new_status: string };

        try {
          const result = await transitionShipmentStatus(database.db, id, body.new_status);

          // Publish shipment.delivered domain event when status transitions to delivered
          if (result.newStatus === "delivered") {
            domainEvents.publish("shipment.delivered", "shipment", id, {
              oldStatus: result.oldStatus,
              newStatus: result.newStatus,
            });
          }

          request.auditContext = {
            action: "shipment.transition",
            entityType: "shipment",
            entityId: id,
            afterJson: {
              oldStatus: result.oldStatus,
              newStatus: result.newStatus,
            },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_SHIPMENT_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_SHIPMENT_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({
              error: "ERR_INVALID_TRANSITION",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // Refresh tracking for a shipment
    app.post(
      "/api/admin/shipments/:id/refresh-tracking",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
          const result = await refreshShipmentTracking(
            database.db,
            id,
            shippingAdapter,
            adminAlertService,
          );

          request.auditContext = {
            action: "shipment.refresh_tracking",
            entityType: "shipment",
            entityId: id,
            afterJson: {
              newEventsStored: result.newEventsStored,
              shipmentTransitioned: result.shipmentTransitioned,
              orderTransitioned: result.orderTransitioned,
              trackingStatus: result.tracking.status,
            },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_SHIPMENT_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_SHIPMENT_NOT_FOUND",
              message: error.message,
            });
          }
          if (
            error.code === "ERR_INVALID_STATE" ||
            error.code === "ERR_NO_LABEL" ||
            error.code === "ERR_NO_TRACKER"
          ) {
            return reply.status(400).send({
              error: error.code,
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // Mark shipment as shipped
    app.post(
      "/api/admin/shipments/:id/mark-shipped",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.FULFILLMENT_MANAGE),
        ],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
          const result = await markShipmentShipped(database.db, id);

          request.auditContext = {
            action: "shipment.mark_shipped",
            entityType: "shipment",
            entityId: id,
            afterJson: {
              status: result.status,
              shippedAt: result.shippedAt.toISOString(),
            },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_SHIPMENT_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_SHIPMENT_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({
              error: "ERR_INVALID_TRANSITION",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // Support Tickets — Admin
    // -----------------------------------------------------------------------

    // POST /api/admin/support-tickets — admin creates a ticket
    app.post(
      "/api/admin/support-tickets",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_MANAGE)],
        schema: {
          body: {
            type: "object",
            required: ["subject", "category", "source"],
            properties: {
              customer_id: { type: "string" },
              order_id: { type: "string" },
              shipment_id: { type: "string" },
              subject: { type: "string" },
              category: { type: "string" },
              priority: { type: "string" },
              source: { type: "string" },
              force_duplicate: { type: "boolean" },
            },
          },
        },
      },
      async (request) => {
        const body = request.body as {
          customer_id?: string;
          order_id?: string;
          shipment_id?: string;
          subject: string;
          category: string;
          priority?: string;
          source: string;
          force_duplicate?: boolean;
        };

        const ticket = await createSupportTicket(database.db, {
          customerId: body.customer_id,
          orderId: body.order_id,
          shipmentId: body.shipment_id,
          subject: body.subject,
          category: body.category,
          priority: body.priority,
          source: body.source,
          forceDuplicate: body.force_duplicate,
        });

        request.auditContext = {
          action: "support_ticket.create",
          entityType: "support_ticket",
          entityId: ticket.id,
          afterJson: { ticketNumber: ticket.ticketNumber, status: ticket.status },
        };

        return { ticket };
      },
    );

    // GET /api/admin/support-tickets — list tickets with optional filters
    app.get(
      "/api/admin/support-tickets",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_READ)],
      },
      async (request) => {
        const query = request.query as {
          status?: string;
          priority?: string;
          customer_id?: string;
          order_id?: string;
        };
        const tickets = await listSupportTickets(database.db, {
          status: query.status,
          priority: query.priority,
          customerId: query.customer_id,
          orderId: query.order_id,
        });
        return { tickets };
      },
    );

    // GET /api/admin/support-tickets/:id — get single ticket
    app.get(
      "/api/admin/support-tickets/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const ticket = await findTicketById(database.db, id);
        if (!ticket) {
          return reply
            .status(404)
            .send({ error: "ERR_TICKET_NOT_FOUND", message: "Support ticket not found" });
        }
        return { ticket };
      },
    );

    // POST /api/admin/support-tickets/:id/transition — transition ticket status
    app.post(
      "/api/admin/support-tickets/:id/transition",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_MANAGE)],
        schema: {
          body: {
            type: "object",
            required: ["new_status"],
            properties: {
              new_status: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { new_status: string; reason?: string };
        const actorAdminUserId = request.adminContext?.adminUserId ?? "";

        try {
          const result = await transitionTicketStatus(database.db, {
            ticketId: id,
            newStatus: body.new_status,
            reason: body.reason,
            actorAdminUserId,
          });

          // Publish ticket.updated domain event
          const ticketForEvent = await findTicketById(database.db, id);
          domainEvents.publish(
            "ticket.updated",
            "ticket",
            id,
            { oldStatus: result.oldStatus, newStatus: result.newStatus },
            ticketForEvent?.customerId ?? undefined,
          );

          request.auditContext = {
            action: "support_ticket.transition",
            entityType: "support_ticket",
            entityId: id,
            afterJson: {
              oldStatus: result.oldStatus,
              newStatus: result.newStatus,
            },
          };

          return result;
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_TICKET_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_TICKET_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_INVALID_TRANSITION") {
            return reply.status(400).send({
              error: "ERR_INVALID_TRANSITION",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // GET /api/admin/support-tickets/:id/messages — list messages (including internal notes)
    app.get(
      "/api/admin/support-tickets/:id/messages",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const ticket = await findTicketById(database.db, id);
        if (!ticket) {
          return reply
            .status(404)
            .send({ error: "ERR_TICKET_NOT_FOUND", message: "Support ticket not found" });
        }
        const messages = await listTicketMessages(database.db, id, {
          includeInternalNotes: true,
        });
        return { messages };
      },
    );

    // POST /api/admin/support-tickets/:id/messages — admin reply (customer-visible)
    app.post(
      "/api/admin/support-tickets/:id/messages",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_MANAGE)],
        schema: {
          body: {
            type: "object",
            required: ["body"],
            properties: {
              body: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { body: string };
        const actorAdminUserId = request.adminContext?.adminUserId ?? "";

        try {
          const message = await createTicketMessage(database.db, {
            ticketId: id,
            authorType: "admin",
            adminUserId: actorAdminUserId,
            body: body.body,
            isInternalNote: false,
          });

          // Publish ticket.updated domain event for new message
          const ticketForMsg = await findTicketById(database.db, id);
          domainEvents.publish(
            "ticket.updated",
            "ticket",
            id,
            { reason: "message_added", messageId: message.id },
            ticketForMsg?.customerId ?? undefined,
          );

          request.auditContext = {
            action: "support_ticket_message.create",
            entityType: "support_ticket",
            entityId: id,
            afterJson: { messageId: message.id, authorType: "admin" },
          };

          return { message };
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_TICKET_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_TICKET_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_TICKET_CLOSED") {
            return reply.status(400).send({
              error: "ERR_TICKET_CLOSED",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // POST /api/admin/support-tickets/:id/internal-notes — admin internal note
    app.post(
      "/api/admin/support-tickets/:id/internal-notes",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_MANAGE)],
        schema: {
          body: {
            type: "object",
            required: ["body"],
            properties: {
              body: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { body: string };
        const actorAdminUserId = request.adminContext?.adminUserId ?? "";

        try {
          const message = await createTicketMessage(database.db, {
            ticketId: id,
            authorType: "admin",
            adminUserId: actorAdminUserId,
            body: body.body,
            isInternalNote: true,
          });

          request.auditContext = {
            action: "support_ticket_internal_note.create",
            entityType: "support_ticket",
            entityId: id,
            afterJson: { messageId: message.id, isInternalNote: true },
          };

          return { message };
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_TICKET_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_TICKET_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_TICKET_CLOSED") {
            return reply.status(400).send({
              error: "ERR_TICKET_CLOSED",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // GET /api/admin/support-tickets/:id/history — status transition history
    app.get(
      "/api/admin/support-tickets/:id/history",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const ticket = await findTicketById(database.db, id);
        if (!ticket) {
          return reply
            .status(404)
            .send({ error: "ERR_TICKET_NOT_FOUND", message: "Support ticket not found" });
        }
        const history = await findTicketStatusHistory(database.db, id);
        return { history };
      },
    );

    // POST /api/admin/support-tickets/:id/dismiss-duplicate — dismiss duplicate flag
    app.post(
      "/api/admin/support-tickets/:id/dismiss-duplicate",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_MANAGE)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
          const ticket = await dismissDuplicate(database.db, id);

          request.auditContext = {
            action: "support_ticket.dismiss_duplicate",
            entityType: "support_ticket",
            entityId: id,
            afterJson: { duplicateDismissed: true },
          };

          return { ticket };
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_TICKET_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_TICKET_NOT_FOUND",
              message: error.message,
            });
          }
          if (error.code === "ERR_NOT_DUPLICATE") {
            return reply.status(400).send({
              error: "ERR_NOT_DUPLICATE",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // POST /api/admin/support-tickets/:id/merge — merge ticket into another
    app.post(
      "/api/admin/support-tickets/:id/merge",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_MANAGE)],
        schema: {
          body: {
            type: "object",
            required: ["target_ticket_id"],
            properties: {
              target_ticket_id: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { target_ticket_id: string };
        const actorAdminUserId = request.adminContext?.adminUserId ?? "";

        try {
          const ticket = await mergeTicket(
            database.db,
            id,
            body.target_ticket_id,
            actorAdminUserId,
          );

          request.auditContext = {
            action: "support_ticket.merge",
            entityType: "support_ticket",
            entityId: id,
            afterJson: {
              mergedIntoTicketId: body.target_ticket_id,
              status: "closed",
            },
          };

          return { ticket };
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_TICKET_NOT_FOUND") {
            return reply.status(404).send({
              error: "ERR_TICKET_NOT_FOUND",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // Support Tickets — Customer
    // -----------------------------------------------------------------------

    // POST /api/support/tickets — customer creates a ticket
    app.post(
      "/api/support/tickets",
      {
        preHandler: [verifySession, requireVerifiedEmail],
        schema: {
          body: {
            type: "object",
            required: ["subject", "category"],
            properties: {
              order_id: { type: "string" },
              shipment_id: { type: "string" },
              subject: { type: "string" },
              category: { type: "string" },
              priority: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const session = (request as unknown as { session: { getUserId: () => string } }).session;
        const authSubject = session.getUserId();
        const customerRow = await getCustomerByAuthSubject(database.db, authSubject);
        if (!customerRow) {
          return reply
            .status(401)
            .send({ error: "ERR_NOT_CUSTOMER", message: "Customer not found" });
        }

        const body = request.body as {
          order_id?: string;
          shipment_id?: string;
          subject: string;
          category: string;
          priority?: string;
        };

        const ticket = await createSupportTicket(database.db, {
          customerId: customerRow.id,
          orderId: body.order_id,
          shipmentId: body.shipment_id,
          subject: body.subject,
          category: body.category,
          priority: body.priority,
          source: "customer_app",
        });

        return { ticket };
      },
    );

    // GET /api/support/tickets — customer lists their tickets
    app.get(
      "/api/support/tickets",
      {
        preHandler: [verifySession, requireVerifiedEmail],
      },
      async (request, reply) => {
        const session = (request as unknown as { session: { getUserId: () => string } }).session;
        const authSubject = session.getUserId();
        const customerRow = await getCustomerByAuthSubject(database.db, authSubject);
        if (!customerRow) {
          return reply
            .status(401)
            .send({ error: "ERR_NOT_CUSTOMER", message: "Customer not found" });
        }

        const tickets = await listTicketsByCustomerId(database.db, customerRow.id);
        return { tickets };
      },
    );

    // GET /api/support/tickets/:id — customer gets a single ticket
    app.get(
      "/api/support/tickets/:id",
      {
        preHandler: [verifySession, requireVerifiedEmail],
      },
      async (request, reply) => {
        const session = (request as unknown as { session: { getUserId: () => string } }).session;
        const authSubject = session.getUserId();
        const customerRow = await getCustomerByAuthSubject(database.db, authSubject);
        if (!customerRow) {
          return reply
            .status(401)
            .send({ error: "ERR_NOT_CUSTOMER", message: "Customer not found" });
        }

        const { id } = request.params as { id: string };
        const ticket = await findTicketById(database.db, id);
        if (!ticket || ticket.customerId !== customerRow.id) {
          return reply
            .status(404)
            .send({ error: "ERR_TICKET_NOT_FOUND", message: "Support ticket not found" });
        }

        return { ticket };
      },
    );

    // POST /api/support/tickets/:id/messages — customer adds a message
    app.post(
      "/api/support/tickets/:id/messages",
      {
        preHandler: [verifySession, requireVerifiedEmail],
        schema: {
          body: {
            type: "object",
            required: ["body"],
            properties: {
              body: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const session = (request as unknown as { session: { getUserId: () => string } }).session;
        const authSubject = session.getUserId();
        const customerRow = await getCustomerByAuthSubject(database.db, authSubject);
        if (!customerRow) {
          return reply
            .status(401)
            .send({ error: "ERR_NOT_CUSTOMER", message: "Customer not found" });
        }

        const { id } = request.params as { id: string };
        const ticket = await findTicketById(database.db, id);
        if (!ticket || ticket.customerId !== customerRow.id) {
          return reply
            .status(404)
            .send({ error: "ERR_TICKET_NOT_FOUND", message: "Support ticket not found" });
        }

        try {
          const message = await createTicketMessage(database.db, {
            ticketId: id,
            authorType: "customer",
            customerId: customerRow.id,
            body: (request.body as { body: string }).body,
            isInternalNote: false,
          });

          return { message };
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_TICKET_CLOSED") {
            return reply.status(400).send({
              error: "ERR_TICKET_CLOSED",
              message: error.message,
            });
          }
          throw err;
        }
      },
    );

    // GET /api/support/tickets/:id/messages — customer views messages (no internal notes)
    app.get(
      "/api/support/tickets/:id/messages",
      {
        preHandler: [verifySession, requireVerifiedEmail],
      },
      async (request, reply) => {
        const session = (request as unknown as { session: { getUserId: () => string } }).session;
        const authSubject = session.getUserId();
        const customerRow = await getCustomerByAuthSubject(database.db, authSubject);
        if (!customerRow) {
          return reply
            .status(401)
            .send({ error: "ERR_NOT_CUSTOMER", message: "Customer not found" });
        }

        const { id } = request.params as { id: string };
        const ticket = await findTicketById(database.db, id);
        if (!ticket || ticket.customerId !== customerRow.id) {
          return reply
            .status(404)
            .send({ error: "ERR_TICKET_NOT_FOUND", message: "Support ticket not found" });
        }

        // Customer never sees internal notes
        const messages = await listTicketMessages(database.db, id, {
          includeInternalNotes: false,
        });
        return { messages };
      },
    );

    // -----------------------------------------------------------------------
    // Ticket Attachments (T062)
    // -----------------------------------------------------------------------

    // POST /api/admin/support-tickets/:id/attachments — admin uploads attachment
    app.post(
      "/api/admin/support-tickets/:id/attachments",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_MANAGE)],
        schema: {
          body: {
            type: "object",
            required: ["fileName", "contentType", "data"],
            properties: {
              fileName: { type: "string", minLength: 1 },
              contentType: { type: "string" },
              data: { type: "string", description: "Base64-encoded file data" },
              messageId: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          fileName: string;
          contentType: string;
          data: string;
          messageId?: string;
        };

        if (!(ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(body.contentType)) {
          return reply.status(400).send({
            error: "ERR_INVALID_CONTENT_TYPE",
            message: `Invalid content type: ${body.contentType}. Allowed: ${ALLOWED_ATTACHMENT_TYPES.join(", ")}`,
          });
        }

        const fileBuffer = Buffer.from(body.data, "base64");
        if (fileBuffer.length > MAX_ATTACHMENT_SIZE_BYTES) {
          return reply.status(400).send({
            error: "ERR_FILE_TOO_LARGE",
            message: `File size exceeds maximum of ${MAX_ATTACHMENT_SIZE_BYTES} bytes`,
          });
        }

        const storageKey = `tickets/${id}/${randomUUID()}/${body.fileName}`;
        await storageAdapter.put(storageKey, fileBuffer, body.contentType);

        try {
          const attachment = await createTicketAttachment(database.db, {
            ticketId: id,
            messageId: body.messageId,
            storageKey,
            fileName: body.fileName,
            contentType: body.contentType,
            sizeBytes: fileBuffer.length,
          });

          request.auditContext = {
            action: "attachment.upload",
            entityType: "support_ticket_attachment",
            entityId: attachment.id,
          };

          return reply.status(201).send({ attachment });
        } catch (err: unknown) {
          // Clean up stored file on DB failure
          await storageAdapter.delete(storageKey);
          const errObj = err as { code?: string; message?: string };
          if (
            errObj.code === "ERR_TICKET_NOT_FOUND" ||
            errObj.code === "ERR_TOO_MANY_ATTACHMENTS" ||
            errObj.code === "ERR_INVALID_CONTENT_TYPE"
          ) {
            const status = errObj.code === "ERR_TICKET_NOT_FOUND" ? 404 : 400;
            return reply.status(status).send({ error: errObj.code, message: errObj.message });
          }
          throw err;
        }
      },
    );

    // GET /api/admin/support-tickets/:id/attachments — list attachments
    app.get(
      "/api/admin/support-tickets/:id/attachments",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_READ)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const ticket = await findTicketById(database.db, id);
        if (!ticket) {
          return reply
            .status(404)
            .send({ error: "ERR_TICKET_NOT_FOUND", message: "Support ticket not found" });
        }
        const attachments = await listAttachmentsByTicketId(database.db, id);
        return { attachments };
      },
    );

    // GET /api/admin/support-tickets/:id/attachments/:attachmentId/download — download attachment
    app.get(
      "/api/admin/support-tickets/:id/attachments/:attachmentId/download",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SUPPORT_READ)],
      },
      async (request, reply) => {
        const { id, attachmentId } = request.params as { id: string; attachmentId: string };
        const attachment = await findAttachmentById(database.db, attachmentId);
        if (!attachment || attachment.ticketId !== id) {
          return reply
            .status(404)
            .send({ error: "ERR_ATTACHMENT_NOT_FOUND", message: "Attachment not found" });
        }

        const file = await storageAdapter.get(attachment.storageKey);
        if (!file) {
          return reply
            .status(404)
            .send({ error: "ERR_FILE_NOT_FOUND", message: "File not found in storage" });
        }

        return reply
          .header("Content-Type", attachment.contentType)
          .header("Content-Disposition", `attachment; filename="${attachment.fileName}"`)
          .send(file.data);
      },
    );

    // POST /api/support/tickets/:id/attachments — customer uploads attachment
    app.post(
      "/api/support/tickets/:id/attachments",
      {
        preHandler: [verifySession, requireVerifiedEmail],
        schema: {
          body: {
            type: "object",
            required: ["fileName", "contentType", "data"],
            properties: {
              fileName: { type: "string", minLength: 1 },
              contentType: { type: "string" },
              data: { type: "string", description: "Base64-encoded file data" },
              messageId: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const session = (request as unknown as { session: { getUserId: () => string } }).session;
        const authSubject = session.getUserId();
        const customerRow = await getCustomerByAuthSubject(database.db, authSubject);
        if (!customerRow) {
          return reply
            .status(401)
            .send({ error: "ERR_NOT_CUSTOMER", message: "Customer not found" });
        }

        const { id } = request.params as { id: string };
        const ticket = await findTicketById(database.db, id);
        if (!ticket || ticket.customerId !== customerRow.id) {
          return reply
            .status(404)
            .send({ error: "ERR_TICKET_NOT_FOUND", message: "Support ticket not found" });
        }

        const body = request.body as {
          fileName: string;
          contentType: string;
          data: string;
          messageId?: string;
        };

        if (!(ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(body.contentType)) {
          return reply.status(400).send({
            error: "ERR_INVALID_CONTENT_TYPE",
            message: `Invalid content type: ${body.contentType}. Allowed: ${ALLOWED_ATTACHMENT_TYPES.join(", ")}`,
          });
        }

        const fileBuffer = Buffer.from(body.data, "base64");
        if (fileBuffer.length > MAX_ATTACHMENT_SIZE_BYTES) {
          return reply.status(400).send({
            error: "ERR_FILE_TOO_LARGE",
            message: `File size exceeds maximum of ${MAX_ATTACHMENT_SIZE_BYTES} bytes`,
          });
        }

        const storageKey = `tickets/${id}/${randomUUID()}/${body.fileName}`;
        await storageAdapter.put(storageKey, fileBuffer, body.contentType);

        try {
          const attachment = await createTicketAttachment(database.db, {
            ticketId: id,
            messageId: body.messageId,
            storageKey,
            fileName: body.fileName,
            contentType: body.contentType,
            sizeBytes: fileBuffer.length,
          });

          return reply.status(201).send({ attachment });
        } catch (err: unknown) {
          await storageAdapter.delete(storageKey);
          const errObj = err as { code?: string; message?: string };
          if (
            errObj.code === "ERR_TICKET_NOT_FOUND" ||
            errObj.code === "ERR_TOO_MANY_ATTACHMENTS" ||
            errObj.code === "ERR_INVALID_CONTENT_TYPE"
          ) {
            const status = errObj.code === "ERR_TICKET_NOT_FOUND" ? 404 : 400;
            return reply.status(status).send({ error: errObj.code, message: errObj.message });
          }
          throw err;
        }
      },
    );

    // GET /api/support/tickets/:id/attachments — customer lists attachments
    app.get(
      "/api/support/tickets/:id/attachments",
      {
        preHandler: [verifySession, requireVerifiedEmail],
      },
      async (request, reply) => {
        const session = (request as unknown as { session: { getUserId: () => string } }).session;
        const authSubject = session.getUserId();
        const customerRow = await getCustomerByAuthSubject(database.db, authSubject);
        if (!customerRow) {
          return reply
            .status(401)
            .send({ error: "ERR_NOT_CUSTOMER", message: "Customer not found" });
        }

        const { id } = request.params as { id: string };
        const ticket = await findTicketById(database.db, id);
        if (!ticket || ticket.customerId !== customerRow.id) {
          return reply
            .status(404)
            .send({ error: "ERR_TICKET_NOT_FOUND", message: "Support ticket not found" });
        }

        const attachments = await listAttachmentsByTicketId(database.db, id);
        return { attachments };
      },
    );

    // GET /api/support/tickets/:id/attachments/:attachmentId/download — customer downloads
    app.get(
      "/api/support/tickets/:id/attachments/:attachmentId/download",
      {
        preHandler: [verifySession, requireVerifiedEmail],
      },
      async (request, reply) => {
        const session = (request as unknown as { session: { getUserId: () => string } }).session;
        const authSubject = session.getUserId();
        const customerRow = await getCustomerByAuthSubject(database.db, authSubject);
        if (!customerRow) {
          return reply.status(403).send({ error: "ERR_FORBIDDEN", message: "Not authorized" });
        }

        const { id, attachmentId } = request.params as { id: string; attachmentId: string };
        const ticket = await findTicketById(database.db, id);
        if (!ticket || ticket.customerId !== customerRow.id) {
          return reply
            .status(403)
            .send({ error: "ERR_FORBIDDEN", message: "Not authorized to access this attachment" });
        }

        const attachment = await findAttachmentById(database.db, attachmentId);
        if (!attachment || attachment.ticketId !== id) {
          return reply
            .status(404)
            .send({ error: "ERR_ATTACHMENT_NOT_FOUND", message: "Attachment not found" });
        }

        const file = await storageAdapter.get(attachment.storageKey);
        if (!file) {
          return reply
            .status(404)
            .send({ error: "ERR_FILE_NOT_FOUND", message: "File not found in storage" });
        }

        return reply
          .header("Content-Type", attachment.contentType)
          .header("Content-Disposition", `attachment; filename="${attachment.fileName}"`)
          .send(file.data);
      },
    );

    // -----------------------------------------------------------------------
    // Warranty Claims (T063 — FR-055)
    // -----------------------------------------------------------------------

    // POST /api/support/warranty-claims — customer files a warranty claim
    app.post(
      "/api/support/warranty-claims",
      {
        preHandler: [verifySession, requireVerifiedEmail],
        schema: {
          body: {
            type: "object",
            required: ["order_id", "order_line_id", "description"],
            properties: {
              order_id: { type: "string" },
              order_line_id: { type: "string" },
              description: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const session = (request as unknown as { session: { getUserId: () => string } }).session;
        const authSubject = session.getUserId();
        const customerRow = await getCustomerByAuthSubject(database.db, authSubject);
        if (!customerRow) {
          return reply
            .status(401)
            .send({ error: "ERR_NOT_CUSTOMER", message: "Customer not found" });
        }

        const body = request.body as {
          order_id: string;
          order_line_id: string;
          description: string;
        };

        try {
          const result = await createWarrantyClaim(database.db, {
            customerId: customerRow.id,
            orderId: body.order_id,
            orderLineId: body.order_line_id,
            description: body.description,
          });

          return {
            ticket: result.ticket,
            material_limitation_flagged: result.materialLimitationFlagged,
            material_limitation_note: result.materialLimitationNote,
          };
        } catch (err) {
          const errObj = err as { code?: string; message?: string };
          if (errObj.code === "ERR_ORDER_NOT_FOUND") {
            return reply.status(404).send({ error: errObj.code, message: errObj.message });
          }
          if (errObj.code === "ERR_ORDER_LINE_NOT_FOUND") {
            return reply.status(404).send({ error: errObj.code, message: errObj.message });
          }
          if (errObj.code === "ERR_ORDER_NOT_DELIVERED") {
            return reply.status(400).send({ error: errObj.code, message: errObj.message });
          }
          if (errObj.code === "ERR_WARRANTY_EXPIRED") {
            return reply.status(400).send({ error: errObj.code, message: errObj.message });
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // Dispute Evidence Bundle (T066 — FR-060, FR-061)
    // -----------------------------------------------------------------------

    // POST /api/admin/disputes/:id/generate-bundle — generate evidence bundle
    app.post(
      "/api/admin/disputes/:id/generate-bundle",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.DISPUTES_MANAGE)],
      },
      async (request, reply) => {
        const { id: disputeId } = request.params as { id: string };

        try {
          const result = (await generateEvidenceBundle(database.db, disputeId)) as {
            bundleId: string;
            disputeId: string;
            readiness: {
              tracking_history_present: boolean;
              delivery_proof_present: boolean;
              customer_communication_present: boolean;
              policy_acceptance_present: boolean;
              payment_receipt_present: boolean;
              complete: boolean;
              missing_types: string[];
            };
            evidenceCount: number;
            storageKey: string;
            _content: unknown;
          };

          // Store the bundle content via storage adapter
          const bundleBuffer = Buffer.from(JSON.stringify(result._content, null, 2), "utf-8");
          await storageAdapter.put(result.storageKey, bundleBuffer, "application/json");

          request.auditContext = {
            action: "dispute.generate_bundle",
            entityType: "dispute",
            entityId: disputeId,
            afterJson: {
              bundleId: result.bundleId,
              evidenceCount: result.evidenceCount,
              storageKey: result.storageKey,
            },
          };

          return {
            bundle_id: result.bundleId,
            dispute_id: result.disputeId,
            evidence_count: result.evidenceCount,
            storage_key: result.storageKey,
            readiness: result.readiness,
          };
        } catch (err) {
          const errObj = err as { code?: string; message?: string; readiness?: unknown };
          if (errObj.code === "ERR_DISPUTE_NOT_FOUND") {
            return reply.status(404).send({ error: errObj.code, message: errObj.message });
          }
          if (errObj.code === "ERR_EVIDENCE_INCOMPLETE") {
            return reply.status(422).send({
              error: errObj.code,
              message: errObj.message,
              readiness: errObj.readiness,
            });
          }
          throw err;
        }
      },
    );

    // GET /api/admin/disputes/:id/readiness — get evidence readiness summary
    app.get(
      "/api/admin/disputes/:id/readiness",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.DISPUTES_READ)],
      },
      async (request, reply) => {
        const { id: disputeId } = request.params as { id: string };

        const disputeRow = await findDisputeById(database.db, disputeId);
        if (!disputeRow) {
          return reply.status(404).send({
            error: "ERR_DISPUTE_NOT_FOUND",
            message: `Dispute ${disputeId} not found`,
          });
        }

        const records = await findEvidenceByOrderId(database.db, disputeRow.orderId);
        const readiness = computeReadinessSummary(records);

        return { dispute_id: disputeId, readiness };
      },
    );

    // POST /api/admin/disputes/:id/evidence — attach manual evidence
    app.post(
      "/api/admin/disputes/:id/evidence",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.DISPUTES_MANAGE)],
        schema: {
          body: {
            type: "object",
            required: ["type"],
            properties: {
              type: { type: "string", minLength: 1 },
              textContent: { type: "string" },
              fileName: { type: "string", minLength: 1 },
              contentType: { type: "string" },
              data: { type: "string", description: "Base64-encoded file data" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id: disputeId } = request.params as { id: string };
        const body = request.body as {
          type: string;
          textContent?: string;
          fileName?: string;
          contentType?: string;
          data?: string;
        };

        // Validate dispute exists
        const disputeRow = await findDisputeById(database.db, disputeId);
        if (!disputeRow) {
          return reply.status(404).send({
            error: "ERR_DISPUTE_NOT_FOUND",
            message: `Dispute ${disputeId} not found`,
          });
        }

        // Must provide either textContent or file data
        if (!body.textContent && !body.data) {
          return reply.status(400).send({
            error: "ERR_MISSING_CONTENT",
            message:
              "Either textContent or file data (fileName + contentType + data) must be provided",
          });
        }

        let storageKey: string | undefined;

        // Handle file upload if provided
        if (body.data) {
          if (!body.fileName || !body.contentType) {
            return reply.status(400).send({
              error: "ERR_MISSING_FILE_METADATA",
              message: "fileName and contentType are required when uploading a file",
            });
          }

          const fileBuffer = Buffer.from(body.data, "base64");
          storageKey = `evidence/${disputeId}/${randomUUID()}/${body.fileName}`;
          await storageAdapter.put(storageKey, fileBuffer, body.contentType);
        }

        try {
          const record = await createEvidenceRecord(database.db, {
            orderId: disputeRow.orderId,
            disputeId,
            type: body.type as Parameters<typeof createEvidenceRecord>[1]["type"],
            storageKey,
            textContent: body.textContent,
            metadataJson: {
              source: "manual",
              adminAttached: true,
              ...(body.fileName ? { fileName: body.fileName, contentType: body.contentType } : {}),
            },
          });

          request.auditContext = {
            action: "evidence.manual_attach",
            entityType: "evidence_record",
            entityId: record.id,
            afterJson: {
              disputeId,
              type: body.type,
              storageKey: storageKey ?? null,
            },
          };

          return reply.status(201).send({ evidence: record });
        } catch (err) {
          // Clean up stored file on DB failure
          if (storageKey) {
            await storageAdapter.delete(storageKey);
          }
          throw err;
        }
      },
    );

    // GET /api/admin/evidence — list evidence records with optional filters
    app.get(
      "/api/admin/evidence",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.DISPUTES_READ)],
      },
      async (request) => {
        const query = request.query as {
          type?: string;
          order_id?: string;
          shipment_id?: string;
          ticket_id?: string;
          dispute_id?: string;
        };

        const records = await listEvidence(database.db, {
          type: query.type,
          orderId: query.order_id,
          shipmentId: query.shipment_id,
          supportTicketId: query.ticket_id,
          disputeId: query.dispute_id,
        });

        return { evidence: records, total: records.length };
      },
    );

    // GET /api/admin/evidence/:id — get single evidence record
    app.get(
      "/api/admin/evidence/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.DISPUTES_READ)],
      },
      async (request, reply) => {
        const { id: evidenceId } = request.params as { id: string };

        const record = await findEvidenceById(database.db, evidenceId);
        if (!record) {
          return reply.status(404).send({
            error: "ERR_EVIDENCE_NOT_FOUND",
            message: `Evidence record ${evidenceId} not found`,
          });
        }

        // If there's a file, generate a download URL (or return storage key)
        let downloadUrl: string | null = null;
        if (record.storageKey) {
          const file = await storageAdapter.get(record.storageKey);
          if (file) {
            downloadUrl = `/api/admin/evidence/${evidenceId}/download`;
          }
        }

        return { evidence: record, download_url: downloadUrl };
      },
    );

    // GET /api/admin/evidence/:id/download — download evidence file
    app.get(
      "/api/admin/evidence/:id/download",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.DISPUTES_READ)],
      },
      async (request, reply) => {
        const { id: evidenceId } = request.params as { id: string };

        const record = await findEvidenceById(database.db, evidenceId);
        if (!record || !record.storageKey) {
          return reply.status(404).send({
            error: "ERR_EVIDENCE_NOT_FOUND",
            message: `Evidence record or file not found`,
          });
        }

        const file = await storageAdapter.get(record.storageKey);
        if (!file) {
          return reply.status(404).send({
            error: "ERR_FILE_NOT_FOUND",
            message: "Evidence file not found in storage",
          });
        }

        const metadata = record.metadataJson as { fileName?: string; contentType?: string } | null;
        const contentType = metadata?.contentType ?? file.contentType;
        const fileName = metadata?.fileName ?? "evidence-file";

        return reply
          .header("Content-Type", contentType)
          .header("Content-Disposition", `attachment; filename="${fileName}"`)
          .send(file.data);
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

        // Accept idempotency_key from header (preferred) or body
        const idempotencyKey =
          (request.headers["idempotency_key"] as string | undefined) ??
          (request.headers["idempotency-key"] as string | undefined) ??
          body.idempotency_key;

        // Check for existing adjustment with this idempotency key
        if (idempotencyKey) {
          const existing = await findAdjustmentByIdempotencyKey(database.db, idempotencyKey);
          if (existing) {
            return reply.status(200).send({
              adjustment: existing.adjustment,
              movement: existing.movement,
              balance: existing.balance,
              low_stock: existing.lowStock,
            });
          }
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
            idempotencyKey: idempotencyKey,
          });

          // Queue low-stock alert if applicable
          if (result.lowStock) {
            await lowStockAlertService.checkAndQueue(
              database.db,
              body.variant_id,
              result.balance.available,
              result.balance.safetyStock,
            );

            // Publish inventory.low_stock domain event
            domainEvents.publish("inventory.low_stock", "inventory", body.variant_id, {
              available: result.balance.available,
              safetyStock: result.balance.safetyStock,
              locationId: body.location_id,
            });

            // Dispatch notification to admins based on alert preferences
            const targets = await getAllAdminAlertTargets(database.db);
            notificationDispatch.dispatchAlert(targets, {
              subject: `Low stock alert: ${body.variant_id}`,
              body: `Variant ${body.variant_id} has ${result.balance.available} units available (safety stock: ${result.balance.safetyStock})`,
              templateId: "low_stock_alert",
              entity: "inventory",
              entityId: body.variant_id,
              eventType: "inventory.low_stock",
              data: {
                available: result.balance.available,
                safetyStock: result.balance.safetyStock,
                locationId: body.location_id,
              },
            });
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
          const appErr = err as { code?: string; constraint?: string; message?: string };
          // Application-level insufficient inventory check (from query pre-check)
          if (appErr.code === "ERR_INVENTORY_INSUFFICIENT") {
            return reply.status(422).send({
              error: "ERR_INVENTORY_INSUFFICIENT",
              message: appErr.message ?? "Adjustment would result in negative inventory balance",
            });
          }
          // Unique constraint violation on idempotency_key (concurrent duplicate)
          if (appErr.code === "23505" && idempotencyKey) {
            const existing = await findAdjustmentByIdempotencyKey(database.db, idempotencyKey);
            if (existing) {
              return reply.status(200).send({
                adjustment: existing.adjustment,
                movement: existing.movement,
                balance: existing.balance,
                low_stock: existing.lowStock,
              });
            }
          }
          // CHECK constraint violation means available would go negative (safety net)
          if (appErr.code === "23514" && appErr.constraint?.includes("ck_inventory_balance")) {
            return reply.status(422).send({
              error: "ERR_INVENTORY_INSUFFICIENT",
              message: "Adjustment would result in negative inventory balance",
            });
          }
          throw err;
        }
      },
    );

    // List adjustment history for a variant
    app.get(
      "/api/admin/inventory/adjustments",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_READ)],
      },
      async (request) => {
        const query = request.query as { variant_id?: string };
        if (!query.variant_id) {
          return { adjustments: [] };
        }
        const adjustments = await findAdjustmentsByVariant(database.db, query.variant_id);
        return { adjustments };
      },
    );

    // Bulk inventory adjustments
    app.post(
      "/api/admin/inventory/adjustments/bulk",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_ADJUST)],
      },
      async (request, reply) => {
        const body = request.body as {
          adjustments: Array<{
            variant_id: string;
            location_id: string;
            adjustment_type: string;
            quantity_delta: number;
            reason: string;
            notes?: string;
          }>;
        };

        if (!Array.isArray(body.adjustments) || body.adjustments.length === 0) {
          return reply.status(400).send({
            error: "ERR_VALIDATION",
            message: "adjustments must be a non-empty array",
          });
        }

        const validTypes = ["restock", "shrinkage", "correction", "damage", "return"];
        const results = [];
        const errors = [];

        for (let i = 0; i < body.adjustments.length; i++) {
          const adj = body.adjustments[i];
          if (!adj.variant_id || !adj.location_id || !adj.adjustment_type || adj.quantity_delta == null || !adj.reason) {
            errors.push({ index: i, error: "ERR_VALIDATION", message: "Missing required fields" });
            continue;
          }
          if (!validTypes.includes(adj.adjustment_type)) {
            errors.push({ index: i, error: "ERR_VALIDATION", message: `Invalid adjustment_type: ${adj.adjustment_type}` });
            continue;
          }
          if (!Number.isInteger(adj.quantity_delta) || adj.quantity_delta === 0) {
            errors.push({ index: i, error: "ERR_VALIDATION", message: "quantity_delta must be a non-zero integer" });
            continue;
          }

          try {
            const result = await createInventoryAdjustment(database.db, {
              variantId: adj.variant_id,
              locationId: adj.location_id,
              adjustmentType: adj.adjustment_type as "restock" | "shrinkage" | "correction" | "damage" | "return",
              quantityDelta: adj.quantity_delta,
              reason: adj.reason,
              notes: adj.notes,
              actorAdminUserId: request.adminContext?.adminUserId ?? "",
            });
            results.push({ index: i, adjustment: result.adjustment, balance: result.balance });
          } catch (err: unknown) {
            const appErr = err as { code?: string };
            if (appErr.code === "ERR_INVENTORY_INSUFFICIENT") {
              errors.push({ index: i, error: "ERR_INVENTORY_INSUFFICIENT", message: "Would result in negative balance" });
            } else {
              errors.push({ index: i, error: "ERR_INTERNAL", message: "Unexpected error" });
            }
          }
        }

        // Set audit context for the bulk operation (use first result's ID if available)
        if (results.length > 0) {
          request.auditContext = {
            action: "CREATE",
            entityType: "inventory_adjustment",
            entityId: results[0].adjustment.id,
            afterJson: { bulkCount: results.length, bulkErrors: errors.length },
          };
        }

        return reply.status(results.length > 0 ? 201 : 400).send({ results, errors });
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

    // List reservations with filters
    app.get(
      "/api/admin/inventory/reservations/list",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_READ)],
      },
      async (request) => {
        const query = request.query as {
          variant_id?: string;
          status?: string;
          expires_before?: string;
        };
        const reservations = await listReservations(database.db, {
          variantId: query.variant_id,
          status: query.status,
          expiresBefore: query.expires_before ? new Date(query.expires_before) : undefined,
        });
        return { reservations };
      },
    );

    // Reservation stats
    app.get(
      "/api/admin/inventory/reservations/stats",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_READ)],
      },
      async (request) => {
        const query = request.query as { variant_id?: string };
        const stats = await getReservationStats(database.db, query.variant_id);
        return { stats };
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

    // Force-release reservation (admin override)
    app.post(
      "/api/admin/inventory/reservations/:id/force-release",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.INVENTORY_ADJUST)],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
          const result = await forceReleaseReservation(database.db, id);

          request.auditContext = {
            action: "UPDATE",
            entityType: "inventory_reservation",
            entityId: id,
            afterJson: { status: "released", forceRelease: true },
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

        let created;
        try {
          created = await insertProduct(database.db, {
            slug: body.slug,
            title: body.title,
            subtitle: body.subtitle,
            description: body.description,
            brand: body.brand,
            status,
          });
        } catch (err: unknown) {
          const drizzleErr = err as { cause?: { code?: string } ; code?: string };
          const pgCode = drizzleErr.cause?.code ?? drizzleErr.code;
          if (pgCode === "23505") {
            return reply.status(400).send({
              error: "ERR_SLUG_COLLISION",
              message: `A product with slug '${body.slug}' already exists`,
            });
          }
          throw err;
        }

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

        // Propagate archive to all non-archived variants
        if (body.status === "archived" && existing.status !== "archived") {
          const variants = await findVariantsByProductId(database.db, id);
          for (const v of variants) {
            if (v.status !== "archived") {
              await updateVariant(database.db, v.id, { status: "archived" });
            }
          }
        }

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

        // Flag active carts containing this kit for re-validation
        await flagCartsForKitRevalidation(database.db, kitId);

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

        // Flag active carts containing this kit for re-validation
        await flagCartsForKitRevalidation(database.db, kitId);

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

    // -----------------------------------------------------------------------
    // Policy Snapshot routes — /admin/policies
    // -----------------------------------------------------------------------

    // Create a new policy snapshot — requires products.write (content management)
    app.post(
      "/api/admin/policies",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_WRITE)],
      },
      async (request, reply) => {
        const body = request.body as {
          policy_type?: string;
          version?: number;
          content_html?: string;
          content_text?: string;
          effective_at?: string;
        };

        if (!body.policy_type?.trim()) {
          return reply
            .status(400)
            .send({ error: "ERR_VALIDATION", message: "policy_type is required" });
        }
        if (body.version == null || typeof body.version !== "number") {
          return reply
            .status(400)
            .send({ error: "ERR_VALIDATION", message: "version is required (integer)" });
        }
        if (!body.content_html?.trim()) {
          return reply
            .status(400)
            .send({ error: "ERR_VALIDATION", message: "content_html is required" });
        }
        if (!body.content_text?.trim()) {
          return reply
            .status(400)
            .send({ error: "ERR_VALIDATION", message: "content_text is required" });
        }
        if (!body.effective_at) {
          return reply
            .status(400)
            .send({ error: "ERR_VALIDATION", message: "effective_at is required" });
        }

        try {
          const snapshot = await insertPolicySnapshot(database.db, {
            policyType: body.policy_type,
            version: body.version,
            contentHtml: body.content_html,
            contentText: body.content_text,
            effectiveAt: new Date(body.effective_at),
          });

          request.auditContext = {
            action: "CREATE",
            entityType: "policy_snapshot",
            entityId: snapshot.id,
            beforeJson: null,
            afterJson: snapshot,
          };

          return reply.status(201).send({ policy_snapshot: snapshot });
        } catch (err: unknown) {
          const dbErr = err as { constraint?: string };
          if (dbErr.constraint === "uq_policy_snapshot_type_version") {
            return reply.status(409).send({
              error: "ERR_DUPLICATE_VERSION",
              message: `Version ${body.version} already exists for policy type ${body.policy_type}`,
            });
          }
          throw err;
        }
      },
    );

    // List policy snapshots by type — requires products.read
    app.get(
      "/api/admin/policies",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async (request, reply) => {
        const query = request.query as { policy_type?: string };
        if (!query.policy_type?.trim()) {
          return reply
            .status(400)
            .send({ error: "ERR_VALIDATION", message: "policy_type query param is required" });
        }

        const snapshots = await findPoliciesByType(database.db, query.policy_type);
        return reply.send({ policy_snapshots: snapshots });
      },
    );

    // Get current effective policy by type — requires products.read
    app.get(
      "/api/admin/policies/current",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.PRODUCTS_READ)],
      },
      async (request, reply) => {
        const query = request.query as { policy_type?: string };
        if (!query.policy_type?.trim()) {
          return reply
            .status(400)
            .send({ error: "ERR_VALIDATION", message: "policy_type query param is required" });
        }

        const snapshot = await findCurrentPolicyByType(database.db, query.policy_type);
        if (!snapshot) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: `No effective policy found for type ${query.policy_type}`,
          });
        }
        return reply.send({ policy_snapshot: snapshot });
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

    // GET /api/kits — list active kits with requirements and products per class
    app.get("/api/kits", async (_request, reply) => {
      const kits = await findActiveKitsWithDetails(database.db);
      return reply.status(200).send({ kits });
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

      // Validate that all required policy snapshots exist
      const missingPolicies = await validateCheckoutPolicies(db);
      if (missingPolicies.length > 0) {
        return reply.status(400).send({
          error: "ERR_MISSING_POLICY",
          message: `Missing required policies: ${missingPolicies.join(", ")}`,
          missing_policies: missingPolicies,
        });
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

      // Check for kit validation warnings
      if (cartWithItems.kitWarnings && cartWithItems.kitWarnings.length > 0) {
        return reply.status(400).send({
          error: "ERR_KIT_VALIDATION_FAILED",
          message: "Cart contains kits that need to be updated",
          kit_warnings: cartWithItems.kitWarnings,
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
        if (
          stripeErr.type === "StripeConnectionError" ||
          stripeErr.type === "StripeAPIError" ||
          stripeErr.type === "StripeTimeoutError" ||
          stripeErr.code === "ECONNREFUSED" ||
          stripeErr.code === "ETIMEDOUT"
        ) {
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

      // Publish order.placed domain event
      domainEvents.publish(
        "order.placed",
        "order",
        newOrder.id,
        {
          orderNumber: newOrder.orderNumber,
          email: newOrder.email,
          totalMinor: newOrder.totalMinor,
        },
        customerId,
      );

      // 7. Create policy acknowledgments (policies validated at checkout start)
      await createCheckoutAcknowledgments(db, newOrder.id);

      // 8. Update reservations with order ID
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

          await handlePaymentSucceeded(db, paymentRecord, chargeId ?? undefined, adminAlertService);

          // Publish payment.succeeded domain event
          domainEvents.publish("payment.succeeded", "payment", paymentRecord.id, {
            orderId: paymentRecord.orderId,
            amountMinor: paymentRecord.amountMinor,
          });
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

          // Publish dispute.opened domain event
          domainEvents.publish("dispute.opened", "dispute", disputeObj.id, {
            reason: disputeObj.reason ?? null,
            amountMinor: disputeObj.amount,
            orderId: paymentRecord.orderId,
          });
        } else if (eventType === "charge.dispute.closed") {
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
            const piId =
              typeof disputeObj.payment_intent === "string"
                ? disputeObj.payment_intent
                : (disputeObj.payment_intent as Stripe.PaymentIntent | null)?.id;
            if (piId) {
              paymentRecord = await findPaymentByIntentId(db, piId);
            }
          }
          if (!paymentRecord) {
            logger.warn({ disputeId: disputeObj.id }, "No payment found for dispute close");
            return reply.status(200).send({ received: true, skipped: true });
          }

          await storePaymentEvent(db, {
            paymentId: paymentRecord.id,
            providerEventId: event.id,
            eventType,
            payloadJson: event.data.object,
          });

          await handleDisputeClosed(db, {
            providerDisputeId: disputeObj.id,
            stripeStatus: disputeObj.status === "won" ? "won" : "lost",
            closedAt: new Date(),
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
  // EasyPost Webhook Handler
  // -------------------------------------------------------------------------

  if (database) {
    const db = database.db;

    app.post("/webhooks/easypost", {
      config: { rawBody: true },
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const rawBody = Buffer.concat(chunks);
        (request as unknown as Record<string, unknown>).rawBody = rawBody;
        const { Readable } = await import("node:stream");
        return Readable.from(rawBody);
      },
      handler: async (request, reply) => {
        const rawBody = (request as unknown as Record<string, unknown>).rawBody as Buffer;
        const bodyString = rawBody.toString("utf8");

        // Verify webhook signature if secret is configured
        if (config.EASYPOST_WEBHOOK_SECRET) {
          const hmacSignature = request.headers["x-hmac-signature"] as string | undefined;
          if (!hmacSignature) {
            return reply.status(401).send({
              error: "ERR_MISSING_SIGNATURE",
              message: "Missing x-hmac-signature header",
            });
          }

          const expectedSig = createHmac("sha256", config.EASYPOST_WEBHOOK_SECRET)
            .update(bodyString)
            .digest("hex");

          // EasyPost sends HMAC-SHA256 hex digest
          const sigToCompare = hmacSignature.startsWith("hmac-sha256-hex=")
            ? hmacSignature.slice("hmac-sha256-hex=".length)
            : hmacSignature;

          try {
            const sigBuf = Buffer.from(sigToCompare, "hex");
            const expectedBuf = Buffer.from(expectedSig, "hex");
            if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
              return reply.status(401).send({
                error: "ERR_INVALID_SIGNATURE",
                message: "Invalid webhook signature",
              });
            }
          } catch {
            return reply.status(401).send({
              error: "ERR_INVALID_SIGNATURE",
              message: "Invalid webhook signature format",
            });
          }
        }

        // Parse the event payload
        let event: {
          id: string;
          description: string;
          result: {
            id: string;
            tracking_code: string;
            status: string;
            tracking_details?: {
              status: string;
              message: string;
              datetime: string;
              tracking_location?: {
                city: string | null;
                state: string | null;
              };
            }[];
          };
        };
        try {
          event = JSON.parse(bodyString);
        } catch {
          return reply.status(400).send({
            error: "ERR_INVALID_PAYLOAD",
            message: "Invalid JSON payload",
          });
        }

        // Only handle tracker events
        if (!event.description?.startsWith("tracker.")) {
          logger.info({ description: event.description }, "Unhandled EasyPost webhook event type");
          return reply.status(200).send({ received: true, skipped: true });
        }

        // Idempotency check
        if (event.id) {
          const alreadyProcessed = await hasShipmentEventBeenProcessed(db, event.id);
          if (alreadyProcessed) {
            return reply.status(200).send({ received: true, duplicate: true });
          }
        }

        const tracker = event.result;
        if (!tracker?.tracking_code) {
          logger.warn("EasyPost webhook missing tracking_code");
          return reply.status(200).send({ received: true, skipped: true });
        }

        // Find the shipment by tracking number
        const shipmentRecord = await findShipmentByTrackingNumber(db, tracker.tracking_code);
        if (!shipmentRecord) {
          logger.warn(
            { trackingCode: tracker.tracking_code },
            "No shipment found for tracking code",
          );
          return reply.status(200).send({ received: true, skipped: true });
        }

        // Store the shipment event
        const latestDetail = tracker.tracking_details?.length
          ? tracker.tracking_details[tracker.tracking_details.length - 1]
          : null;

        await storeShipmentEvent(db, {
          shipmentId: shipmentRecord.id,
          providerEventId: event.id,
          status: tracker.status,
          description: latestDetail?.message ?? tracker.status,
          occurredAt: latestDetail?.datetime ? new Date(latestDetail.datetime) : new Date(),
          rawPayloadJson: event,
        });

        // Update shipment and order status
        await handleTrackingUpdate(db, shipmentRecord, tracker.status, adminAlertService);

        return reply.status(200).send({ received: true });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Admin contributor routes [FR-069, FR-070]
  // -------------------------------------------------------------------------

  if (database) {
    const db = database.db;
    const requireAdmin = createRequireAdmin(db);

    // POST /api/admin/contributors — create contributor from CLA bot data
    app.post(
      "/api/admin/contributors",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["github_username", "github_user_id"],
            properties: {
              github_username: { type: "string" },
              github_user_id: { type: "string" },
              customer_id: { type: "string" },
              cla_accepted_at: { type: "string" },
            },
          },
        },
      },
      async (request) => {
        const body = request.body as {
          github_username: string;
          github_user_id: string;
          customer_id?: string;
          cla_accepted_at?: string;
        };

        const contrib = await createContributor(db, {
          githubUsername: body.github_username,
          githubUserId: body.github_user_id,
          customerId: body.customer_id ?? null,
          claAcceptedAt: body.cla_accepted_at ? new Date(body.cla_accepted_at) : null,
        });

        request.auditContext = {
          action: "contributor.create",
          entityType: "contributor",
          entityId: contrib.id,
          afterJson: { githubUsername: contrib.githubUsername, status: contrib.status },
        };

        return { contributor: contrib };
      },
    );

    // GET /api/admin/contributors — list all contributors
    app.get(
      "/api/admin/contributors",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_READ),
        ],
      },
      async () => {
        const contributors = await listContributors(db);
        return { contributors };
      },
    );

    // GET /api/admin/contributors/:id — get single contributor
    app.get(
      "/api/admin/contributors/:id",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_READ),
        ],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const contrib = await findContributorById(db, id);
        if (!contrib) {
          return reply.status(404).send({ error: "Contributor not found" });
        }
        return { contributor: contrib };
      },
    );

    // POST /api/admin/contributors/:id/designs — link contributor to product
    app.post(
      "/api/admin/contributors/:id/designs",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["product_id"],
            properties: {
              product_id: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { product_id: string };

        // Verify contributor exists
        const contrib = await findContributorById(db, id);
        if (!contrib) {
          return reply.status(404).send({ error: "Contributor not found" });
        }

        const design = await linkContributorDesign(db, {
          contributorId: id,
          productId: body.product_id,
        });

        request.auditContext = {
          action: "contributor_design.create",
          entityType: "contributor_design",
          entityId: design.id,
          afterJson: { contributorId: id, productId: body.product_id },
        };

        return { design };
      },
    );

    // GET /api/admin/contributors/:id/designs — list designs for contributor
    app.get(
      "/api/admin/contributors/:id/designs",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_READ),
        ],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        // Verify contributor exists
        const contrib = await findContributorById(db, id);
        if (!contrib) {
          return reply.status(404).send({ error: "Contributor not found" });
        }

        const designs = await listDesignsByContributor(db, id);
        return { designs };
      },
    );

    // PUT /api/admin/contributors/:id/donation — configure 501(c)(3) donation [FR-076]
    app.put(
      "/api/admin/contributors/:id/donation",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["charity_name", "charity_ein"],
            properties: {
              charity_name: { type: "string" },
              charity_ein: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { charity_name: string; charity_ein: string };

        const contrib = await findContributorById(db, id);
        if (!contrib) {
          return reply.status(404).send({ error: "Contributor not found" });
        }

        const updated = await setContributorDonation(db, id, body.charity_name, body.charity_ein);

        request.auditContext = {
          action: "contributor.donation.configure",
          entityType: "contributor",
          entityId: id,
          afterJson: { charityName: body.charity_name, charityEin: body.charity_ein },
        };

        return { contributor: updated };
      },
    );

    // DELETE /api/admin/contributors/:id/donation — clear donation preference
    app.delete(
      "/api/admin/contributors/:id/donation",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_MANAGE),
        ],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        const contrib = await findContributorById(db, id);
        if (!contrib) {
          return reply.status(404).send({ error: "Contributor not found" });
        }

        const updated = await setContributorDonation(db, id, null, null);

        request.auditContext = {
          action: "contributor.donation.clear",
          entityType: "contributor",
          entityId: id,
        };

        return { contributor: updated };
      },
    );

    // POST /api/admin/contributors/royalties/clawback — clawback royalty by order line [FR-072]
    app.post(
      "/api/admin/contributors/royalties/clawback",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            properties: {
              order_line_id: { type: "string" },
              order_id: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const body = request.body as { order_line_id?: string; order_id?: string };

        if (body.order_line_id) {
          const result = await clawbackRoyaltyByOrderLine(db, body.order_line_id);
          if (!result) {
            return reply.status(404).send({ error: "No royalty found for this order line" });
          }

          request.auditContext = {
            action: "contributor.royalty.clawback",
            entityType: "contributor_royalty",
            entityId: result.id,
            afterJson: { status: "clawed_back", amountMinor: result.amountMinor },
          };

          return { royalty: result };
        }

        if (body.order_id) {
          const result = await clawbackRoyaltiesByOrderId(db, body.order_id);

          request.auditContext = {
            action: "contributor.royalty.clawback_order",
            entityType: "order",
            entityId: body.order_id,
            afterJson: { clawedBack: result.clawedBack },
          };

          return result;
        }

        return reply.status(400).send({ error: "Either order_line_id or order_id is required" });
      },
    );

    // GET /api/admin/contributors/:id/milestones — list milestones [FR-073]
    app.get(
      "/api/admin/contributors/:id/milestones",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_READ),
        ],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const contrib = await findContributorById(db, id);
        if (!contrib) {
          return reply.status(404).send({ error: "Contributor not found" });
        }
        const milestones = await listMilestonesByContributor(db, id);
        return { milestones };
      },
    );

    // POST /api/admin/contributors/:id/milestones — manually record milestone [FR-073]
    app.post(
      "/api/admin/contributors/:id/milestones",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["milestone_type"],
            properties: {
              milestone_type: { type: "string", enum: [...MILESTONE_TYPES] },
              notes: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { milestone_type: MilestoneType; notes?: string };

        const contrib = await findContributorById(db, id);
        if (!contrib) {
          return reply.status(404).send({ error: "Contributor not found" });
        }

        const milestone = await recordMilestone(db, id, body.milestone_type, body.notes);

        request.auditContext = {
          action: "contributor.milestone.record",
          entityType: "contributor_milestone",
          entityId: milestone.id,
          afterJson: { milestoneType: milestone.milestoneType },
        };

        return { milestone };
      },
    );

    // POST /api/contributors/tax-documents — upload tax document [FR-074]
    app.post(
      "/api/contributors/tax-documents",
      {
        preHandler: [verifySession, requireVerifiedEmail],
        schema: {
          body: {
            type: "object",
            required: ["contributor_id", "document_type", "file_name", "file_data", "content_type"],
            properties: {
              contributor_id: { type: "string" },
              document_type: { type: "string", enum: [...TAX_DOCUMENT_TYPES] },
              file_name: { type: "string" },
              file_data: { type: "string" }, // base64
              content_type: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const body = request.body as {
          contributor_id: string;
          document_type: TaxDocumentType;
          file_name: string;
          file_data: string;
          content_type: string;
        };

        const contrib = await findContributorById(db, body.contributor_id);
        if (!contrib) {
          return reply.status(404).send({ error: "Contributor not found" });
        }

        // Verify the authenticated user owns this contributor account
        const session = request.session;
        if (!session) {
          return reply.status(401).send({ error: "Authentication required" });
        }
        const userId = session.getUserId();
        const cust = await getCustomerByAuthSubject(db, userId);
        if (!cust || cust.id !== contrib.customerId) {
          return reply
            .status(403)
            .send({ error: "Not authorized to upload documents for this contributor" });
        }

        const fileBuffer = Buffer.from(body.file_data, "base64");
        const storageKey = `tax-documents/${body.contributor_id}/${randomUUID()}/${body.file_name}`;

        await storageAdapter.put(storageKey, fileBuffer, body.content_type);

        let taxDoc;
        try {
          taxDoc = await createTaxDocument(db, {
            contributorId: body.contributor_id,
            documentType: body.document_type,
            storageKey,
          });
        } catch (err) {
          await storageAdapter.delete(storageKey);
          throw err;
        }

        return { tax_document: taxDoc };
      },
    );

    // GET /api/contributors/dashboard — contributor dashboard [FR-075]
    app.get(
      "/api/contributors/dashboard",
      {
        preHandler: [verifySession, requireVerifiedEmail],
      },
      async (request, reply) => {
        const session = request.session;
        if (!session) {
          return reply.status(401).send({
            error: "ERR_AUTHENTICATION_FAILED",
            message: "Authentication required",
          });
        }

        const userId = session.getUserId();
        const cust = await getCustomerByAuthSubject(db, userId);
        if (!cust) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Customer record not found",
          });
        }

        // Find contributor linked to this customer
        const contrib = await findContributorByCustomerId(db, cust.id);
        if (!contrib) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "No contributor account linked to this customer",
          });
        }

        const dashboard = await getContributorDashboard(db, contrib.id);
        if (!dashboard) {
          return reply.status(404).send({
            error: "ERR_NOT_FOUND",
            message: "Contributor not found",
          });
        }

        return { dashboard };
      },
    );

    // GET /api/admin/contributors/:id/tax-documents — list tax documents [FR-074]
    app.get(
      "/api/admin/contributors/:id/tax-documents",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_READ),
        ],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const contrib = await findContributorById(db, id);
        if (!contrib) {
          return reply.status(404).send({ error: "Contributor not found" });
        }
        const documents = await listTaxDocumentsByContributor(db, id);
        return { tax_documents: documents };
      },
    );

    // PUT /api/admin/contributors/tax-documents/:id/status — approve/reject [FR-074]
    app.put(
      "/api/admin/contributors/tax-documents/:id/status",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["status"],
            properties: {
              status: { type: "string", enum: ["approved", "rejected"] },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { status: "approved" | "rejected" };

        const existing = await findTaxDocumentById(db, id);
        if (!existing) {
          return reply.status(404).send({ error: "Tax document not found" });
        }

        if (existing.status !== "pending_review") {
          return reply.status(409).send({ error: `Tax document is already ${existing.status}` });
        }

        const updated = await updateTaxDocumentStatus(db, id, body.status);

        request.auditContext = {
          action: `contributor.tax_document.${body.status}`,
          entityType: "contributor_tax_document",
          entityId: id,
          afterJson: { status: body.status },
        };

        return { tax_document: updated };
      },
    );

    // POST /api/admin/contributors/:id/payouts — create payout (blocked without tax doc) [FR-074]
    app.post(
      "/api/admin/contributors/:id/payouts",
      {
        preHandler: [
          verifySession,
          requireAdmin,
          requireCapability(CAPABILITIES.CONTRIBUTORS_MANAGE),
        ],
        schema: {
          body: {
            type: "object",
            required: ["amount_minor", "payout_method"],
            properties: {
              amount_minor: { type: "number" },
              payout_method: { type: "string" },
            },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { amount_minor: number; payout_method: string };

        const contrib = await findContributorById(db, id);
        if (!contrib) {
          return reply.status(404).send({ error: "Contributor not found" });
        }

        try {
          const payout = await createPayout(db, {
            contributorId: id,
            amountMinor: body.amount_minor,
            payoutMethod: body.payout_method,
          });

          request.auditContext = {
            action: "contributor.payout.create",
            entityType: "contributor_payout",
            entityId: payout.id,
            afterJson: { amountMinor: payout.amountMinor, payoutMethod: payout.payoutMethod },
          };

          return { payout };
        } catch (err: unknown) {
          const error = err as { code?: string; message?: string };
          if (error.code === "ERR_TAX_DOC_REQUIRED") {
            return reply.status(403).send({ error: error.message });
          }
          throw err;
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // Admin dashboard routes [FR-081]
  // -------------------------------------------------------------------------

  if (database) {
    const db = database.db;
    const requireAdmin = createRequireAdmin(db);

    // GET /api/admin/dashboard/summary
    app.get<{ Querystring: { from?: string; to?: string } }>(
      "/api/admin/dashboard/summary",
      {
        preHandler: [verifySession, requireAdmin],
      },
      async (request, reply) => {
        const { from, to } = request.query;
        const options: { from?: Date; to?: Date } = {};
        if (from) {
          const d = new Date(from);
          if (isNaN(d.getTime()))
            return reply.status(400).send({ error: "Invalid 'from' date" });
          options.from = d;
        }
        if (to) {
          const d = new Date(to);
          if (isNaN(d.getTime()))
            return reply.status(400).send({ error: "Invalid 'to' date" });
          options.to = d;
        }
        const summary = await getDashboardSummary(db, options);
        return summary;
      },
    );

    // GET /api/admin/dashboard/alerts
    app.get(
      "/api/admin/dashboard/alerts",
      {
        preHandler: [verifySession, requireAdmin],
      },
      async () => {
        const alerts = await getDashboardAlerts(db);
        return { alerts };
      },
    );
  }

  // -------------------------------------------------------------------------
  // Admin customer detail routes [T071b]
  // -------------------------------------------------------------------------

  if (database) {
    const db = database.db;
    const requireAdmin = createRequireAdmin(db);

    // GET /api/admin/customers
    app.get<{
      Querystring: { search?: string; status?: string; limit?: string; offset?: string };
    }>(
      "/api/admin/customers",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.CUSTOMERS_READ)],
      },
      async (request) => {
        const { search, status, limit, offset } = request.query;
        const result = await listCustomers(db, {
          search,
          status,
          limit: limit ? parseInt(limit, 10) : undefined,
          offset: offset ? parseInt(offset, 10) : undefined,
        });
        const hasPII = request.adminContext!.capabilities.includes(CAPABILITIES.CUSTOMERS_PII);
        if (!hasPII) {
          return { ...result, customers: result.customers.map(redactCustomerPII) };
        }
        return result;
      },
    );

    // GET /api/admin/customers/:id
    app.get<{ Params: { id: string } }>(
      "/api/admin/customers/:id",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.CUSTOMERS_READ)],
      },
      async (request, reply) => {
        const detail = await getCustomerDetail(db, request.params.id);
        if (!detail) {
          return reply.status(404).send({ error: "Customer not found" });
        }
        const hasPII = request.adminContext!.capabilities.includes(CAPABILITIES.CUSTOMERS_PII);
        return hasPII ? detail : redactCustomerPII(detail);
      },
    );

    // GET /api/admin/customers/:id/orders
    app.get<{ Params: { id: string } }>(
      "/api/admin/customers/:id/orders",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.CUSTOMERS_READ)],
      },
      async (request, reply) => {
        const detail = await getCustomerDetail(db, request.params.id);
        if (!detail) {
          return reply.status(404).send({ error: "Customer not found" });
        }
        const orders = await getCustomerOrders(db, request.params.id);
        return { orders };
      },
    );

    // GET /api/admin/customers/:id/tickets
    app.get<{ Params: { id: string } }>(
      "/api/admin/customers/:id/tickets",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.CUSTOMERS_READ)],
      },
      async (request, reply) => {
        const detail = await getCustomerDetail(db, request.params.id);
        if (!detail) {
          return reply.status(404).send({ error: "Customer not found" });
        }
        const tickets = await getCustomerTickets(db, request.params.id);
        return { tickets };
      },
    );

    // GET /api/admin/customers/:id/addresses
    app.get<{ Params: { id: string } }>(
      "/api/admin/customers/:id/addresses",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.CUSTOMERS_READ)],
      },
      async (request, reply) => {
        const detail = await getCustomerDetail(db, request.params.id);
        if (!detail) {
          return reply.status(404).send({ error: "Customer not found" });
        }
        const addresses = await getCustomerAddresses(db, request.params.id);
        return { addresses };
      },
    );

    // GET /api/admin/customers/:id/audit-trail
    app.get<{ Params: { id: string } }>(
      "/api/admin/customers/:id/audit-trail",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.CUSTOMERS_READ)],
      },
      async (request, reply) => {
        const detail = await getCustomerDetail(db, request.params.id);
        if (!detail) {
          return reply.status(404).send({ error: "Customer not found" });
        }
        // Look up authSubject from the customer record
        const [custRow] = await db.select({ authSubject: customer.authSubject }).from(customer).where(eq(customer.id, request.params.id));
        const events = custRow ? await getCustomerAuditTrail(db, custRow.authSubject) : [];
        return { events };
      },
    );

    // POST /api/admin/customers/:id/ban
    app.post<{ Params: { id: string } }>(
      "/api/admin/customers/:id/ban",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.CUSTOMERS_MANAGE)],
      },
      async (request, reply) => {
        const result = await banCustomer(db, request.params.id);
        if (!result) {
          return reply.status(404).send({ error: "Customer not found" });
        }
        request.auditContext = {
          action: "customer.ban",
          entityType: "customer",
          entityId: request.params.id,
          beforeJson: null,
          afterJson: { status: "banned" },
        };
        return result;
      },
    );

    // POST /api/admin/customers/:id/unban
    app.post<{ Params: { id: string } }>(
      "/api/admin/customers/:id/unban",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.CUSTOMERS_MANAGE)],
      },
      async (request, reply) => {
        const result = await unbanCustomer(db, request.params.id);
        if (!result) {
          return reply.status(404).send({ error: "Customer not found" });
        }
        request.auditContext = {
          action: "customer.unban",
          entityType: "customer",
          entityId: request.params.id,
          beforeJson: null,
          afterJson: { status: "active" },
        };
        return result;
      },
    );

    // -----------------------------------------------------------------------
    // Admin settings routes [T071c]
    // -----------------------------------------------------------------------

    // GET /api/admin/settings/shipping
    app.get(
      "/api/admin/settings/shipping",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SETTINGS_MANAGE)],
      },
      async () => {
        return getShippingSettings(db);
      },
    );

    // PATCH /api/admin/settings/shipping
    app.patch(
      "/api/admin/settings/shipping",
      {
        preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.SETTINGS_MANAGE)],
        schema: {
          body: {
            type: "object",
            properties: {
              defaultCarrier: { type: "string" },
              serviceLevels: { type: "array", items: { type: "string" } },
              labelFormat: { type: "string" },
              labelSize: { type: "string" },
              requireSignature: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const updates = request.body as Partial<ShippingSettings>;
        const updated = await updateShippingSettings(db, updates);
        request.auditContext = {
          action: "settings_updated",
          entityType: "setting",
          entityId: "00000000-0000-0000-0000-000000000000",
          beforeJson: null,
          afterJson: updated,
        };
        return updated;
      },
    );

    // -----------------------------------------------------------------------
    // Admin alert preference routes [T075]
    // -----------------------------------------------------------------------

    // GET /api/admin/settings/alerts — get current admin's alert preference
    app.get(
      "/api/admin/settings/alerts",
      {
        preHandler: [verifySession, requireAdmin],
      },
      async (request) => {
        const adminUserId = request.adminContext?.adminUserId ?? "";
        const pref = await getAlertPreference(db, adminUserId);
        return { channel: pref?.channel ?? "both" };
      },
    );

    // PUT /api/admin/settings/alerts — update current admin's alert preference
    app.put(
      "/api/admin/settings/alerts",
      {
        preHandler: [verifySession, requireAdmin],
        schema: {
          body: {
            type: "object",
            required: ["channel"],
            properties: {
              channel: { type: "string", enum: ["email", "push", "both"] },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const adminUserId = request.adminContext?.adminUserId ?? "";
        const { channel } = request.body as { channel: AlertChannel };
        const pref = await upsertAlertPreference(db, adminUserId, channel);
        return { channel: pref.channel };
      },
    );
  }

  // -------------------------------------------------------------------------
  // WebSocket support
  // -------------------------------------------------------------------------

  let wsManager: WsManager | undefined;
  if (database) {
    wsManager = await registerWebSocket({ app, db: database.db });
  }

  // Domain event publisher — routes reference this via closure; it's set before server.listen()
  const domainEvents = createDomainEventPublisher(wsManager);

  // Notification dispatch service — dispatches alerts via email/push/in-app adapters
  const notificationDispatch =
    options.notificationDispatch ?? createNotificationDispatchService({ wsManager });

  // -------------------------------------------------------------------------
  // Shutdown manager
  // -------------------------------------------------------------------------

  const shutdownManager = createShutdownManager({
    logger,
    processRef,
    ...(options.exitFn ? { exitFn: options.exitFn } : {}),
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

  async function stop(): Promise<void> {
    await shutdownManager.shutdown();
  }

  return {
    app,
    shutdownManager,
    lowStockAlertService,
    adminAlertService,
    taxAdapter,
    shippingAdapter,
    paymentAdapter,
    notificationService,
    notificationDispatch,
    storageAdapter,
    wsManager,
    domainEvents,
    start,
    stop,
  };
}
