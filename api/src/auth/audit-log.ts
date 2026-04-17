import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { insertAuditLog } from "../db/queries/audit-log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditContext {
  action: string;
  entityType: string;
  entityId: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}

declare module "fastify" {
  interface FastifyRequest {
    auditContext?: AuditContext;
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Registers a Fastify onResponse hook that auto-creates audit_log entries
 * for admin routes. Route handlers set `request.auditContext` with the
 * action details; this hook persists them to the database.
 *
 * Only fires when both `request.adminContext` and `request.auditContext` are set
 * and the response was successful (2xx status).
 */
export function registerAdminAuditLog(app: FastifyInstance, db: PostgresJsDatabase): void {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.adminContext || !request.auditContext) {
      return;
    }

    // Only audit successful mutations
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
      return;
    }

    const { adminUserId } = request.adminContext;
    const { action, entityType, entityId, beforeJson, afterJson } = request.auditContext;

    const ipAddress =
      (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? request.ip;

    try {
      await insertAuditLog(db, {
        actorAdminUserId: adminUserId,
        action,
        entityType,
        entityId,
        beforeJson,
        afterJson,
        ipAddress,
      });
    } catch (err) {
      // Audit log failures should not break the request — log and continue
      request.log?.error?.({ err }, "Failed to write audit log entry");
    }
  });
}
