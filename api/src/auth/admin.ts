import type { FastifyRequest, FastifyReply } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { adminUser, adminRole, adminUserRole } from "../db/schema/admin.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminContext {
  adminUserId: string;
  email: string;
  name: string;
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// Augment Fastify request with admin context
// ---------------------------------------------------------------------------

declare module "fastify" {
  interface FastifyRequest {
    adminContext?: AdminContext;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Looks up the admin_user record by SuperTokens auth_subject.
 */
export async function getAdminUserByAuthSubject(
  db: PostgresJsDatabase,
  authSubject: string,
): Promise<{ id: string; email: string; name: string; status: string } | undefined> {
  const rows = await db
    .select({
      id: adminUser.id,
      email: adminUser.email,
      name: adminUser.name,
      status: adminUser.status,
    })
    .from(adminUser)
    .where(eq(adminUser.authSubject, authSubject))
    .limit(1);
  return rows[0];
}

/**
 * Fetches all capabilities for an admin user by aggregating their roles.
 */
export async function getAdminCapabilities(
  db: PostgresJsDatabase,
  adminUserId: string,
): Promise<string[]> {
  const rows = await db
    .select({
      capabilitiesJson: adminRole.capabilitiesJson,
    })
    .from(adminUserRole)
    .innerJoin(adminRole, eq(adminUserRole.adminRoleId, adminRole.id))
    .where(eq(adminUserRole.adminUserId, adminUserId));

  const capabilities = new Set<string>();
  for (const row of rows) {
    const caps = row.capabilitiesJson;
    if (Array.isArray(caps)) {
      for (const cap of caps) {
        capabilities.add(cap);
      }
    }
  }
  return [...capabilities];
}

// ---------------------------------------------------------------------------
// Middleware: requireAdmin
// ---------------------------------------------------------------------------

/**
 * Creates a Fastify preHandler that verifies the session belongs to an active admin user.
 * Attaches `request.adminContext` with the admin's capabilities.
 * Must be used AFTER `verifySession`.
 *
 * @param db Database connection for looking up admin records.
 */
export function createRequireAdmin(db: PostgresJsDatabase) {
  return async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.session) {
      return reply.status(401).send({
        error: "ERR_AUTHENTICATION_FAILED",
        message: "Authentication required",
      });
    }

    const authSubject = request.session.getUserId();
    const admin = await getAdminUserByAuthSubject(db, authSubject);

    if (!admin) {
      return reply.status(403).send({
        error: "ERR_FORBIDDEN",
        message: "Admin access required",
      });
    }

    if (admin.status !== "active") {
      return reply.status(403).send({
        error: "ERR_FORBIDDEN",
        message: "Admin account is not active",
      });
    }

    const capabilities = await getAdminCapabilities(db, admin.id);

    request.adminContext = {
      adminUserId: admin.id,
      email: admin.email,
      name: admin.name,
      capabilities,
    };
  };
}

// ---------------------------------------------------------------------------
// Middleware: requireCapability
// ---------------------------------------------------------------------------

/**
 * Creates a Fastify preHandler that checks for a specific capability.
 * Must be used AFTER `requireAdmin` (which populates `request.adminContext`).
 *
 * @param capability The capability string to check (e.g. 'orders.read').
 */
export function requireCapability(capability: string) {
  return async function checkCapability(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!request.adminContext) {
      return reply.status(403).send({
        error: "ERR_FORBIDDEN",
        message: "Admin access required",
      });
    }

    if (!request.adminContext.capabilities.includes(capability)) {
      return reply.status(403).send({
        error: "ERR_INSUFFICIENT_PERMISSIONS",
        message: `Missing required capability: ${capability}`,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Well-known capabilities
// ---------------------------------------------------------------------------

export const CAPABILITIES = {
  // Orders
  ORDERS_READ: "orders.read",
  ORDERS_MANAGE: "orders.manage",
  ORDERS_REFUND: "orders.refund",
  ORDERS_CANCEL: "orders.cancel",

  // Inventory
  INVENTORY_READ: "inventory.read",
  INVENTORY_ADJUST: "inventory.adjust",

  // Products
  PRODUCTS_READ: "products.read",
  PRODUCTS_WRITE: "products.write",

  // Fulfillment
  FULFILLMENT_READ: "fulfillment.read",
  FULFILLMENT_MANAGE: "fulfillment.manage",

  // Support
  SUPPORT_READ: "support.read",
  SUPPORT_MANAGE: "support.manage",

  // Disputes
  DISPUTES_READ: "disputes.read",
  DISPUTES_MANAGE: "disputes.manage",

  // Contributors
  CONTRIBUTORS_READ: "contributors.read",
  CONTRIBUTORS_MANAGE: "contributors.manage",

  // Admin management
  ADMIN_USERS_READ: "admin.users.read",
  ADMIN_USERS_MANAGE: "admin.users.manage",

  // Settings
  SETTINGS_MANAGE: "admin.settings.manage",
} as const;

// ---------------------------------------------------------------------------
// Role capability presets
// ---------------------------------------------------------------------------

export const ROLE_CAPABILITIES: Record<string, string[]> = {
  super_admin: Object.values(CAPABILITIES),

  support: [
    CAPABILITIES.ORDERS_READ,
    CAPABILITIES.SUPPORT_READ,
    CAPABILITIES.SUPPORT_MANAGE,
    CAPABILITIES.DISPUTES_READ,
    CAPABILITIES.DISPUTES_MANAGE,
    CAPABILITIES.PRODUCTS_READ,
    CAPABILITIES.INVENTORY_READ,
  ],

  fulfillment: [
    CAPABILITIES.ORDERS_READ,
    CAPABILITIES.FULFILLMENT_READ,
    CAPABILITIES.FULFILLMENT_MANAGE,
    CAPABILITIES.INVENTORY_READ,
    CAPABILITIES.INVENTORY_ADJUST,
    CAPABILITIES.PRODUCTS_READ,
  ],

  finance: [
    CAPABILITIES.ORDERS_READ,
    CAPABILITIES.ORDERS_REFUND,
    CAPABILITIES.ORDERS_CANCEL,
    CAPABILITIES.PRODUCTS_READ,
    CAPABILITIES.INVENTORY_READ,
    CAPABILITIES.CONTRIBUTORS_READ,
  ],
};
