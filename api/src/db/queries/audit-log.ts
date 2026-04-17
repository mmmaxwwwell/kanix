import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq, desc } from "drizzle-orm";
import { adminAuditLog } from "../schema/admin.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  actorAdminUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson?: unknown;
  afterJson?: unknown;
  ipAddress?: string;
}

export type AuditLogRecord = typeof adminAuditLog.$inferSelect;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function insertAuditLog(
  db: PostgresJsDatabase,
  entry: AuditLogEntry,
): Promise<AuditLogRecord> {
  const [inserted] = await db
    .insert(adminAuditLog)
    .values({
      actorAdminUserId: entry.actorAdminUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeJson: entry.beforeJson ?? null,
      afterJson: entry.afterJson ?? null,
      ipAddress: entry.ipAddress ?? null,
    })
    .returning();
  return inserted;
}

export async function findAuditLogsByEntityId(
  db: PostgresJsDatabase,
  entityId: string,
): Promise<AuditLogRecord[]> {
  return db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.entityId, entityId))
    .orderBy(desc(adminAuditLog.createdAt));
}
