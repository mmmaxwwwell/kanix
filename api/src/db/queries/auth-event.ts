import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq, and, desc, gte, lte, sql } from "drizzle-orm";
import { authEventLog } from "../schema/auth-event.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthEventType = "login" | "logout" | "signup" | "failed_login" | "password_reset";

export interface InsertAuthEventInput {
  eventType: AuthEventType;
  actorId: string;
  ipAddress?: string;
  userAgent?: string;
  metadataJson?: unknown;
}

export type AuthEventRecord = typeof authEventLog.$inferSelect;

export interface ListAuthEventsInput {
  actorId?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export interface ListAuthEventsResult {
  items: AuthEventRecord[];
  total: number;
  page: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function insertAuthEvent(
  db: PostgresJsDatabase,
  input: InsertAuthEventInput,
): Promise<AuthEventRecord> {
  const [inserted] = await db
    .insert(authEventLog)
    .values({
      eventType: input.eventType,
      actorId: input.actorId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadataJson: input.metadataJson ?? null,
    })
    .returning();
  return inserted;
}

export async function listAuthEvents(
  db: PostgresJsDatabase,
  input: ListAuthEventsInput = {},
): Promise<ListAuthEventsResult> {
  const page = input.page ?? 1;
  const limit = Math.min(input.limit ?? 20, 100);
  const offset = (page - 1) * limit;

  const conditions = [];
  if (input.actorId) {
    conditions.push(eq(authEventLog.actorId, input.actorId));
  }
  if (input.eventType) {
    conditions.push(eq(authEventLog.eventType, input.eventType));
  }
  if (input.from) {
    conditions.push(gte(authEventLog.createdAt, input.from));
  }
  if (input.to) {
    conditions.push(lte(authEventLog.createdAt, input.to));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(authEventLog)
      .where(whereClause)
      .orderBy(desc(authEventLog.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(authEventLog)
      .where(whereClause),
  ]);

  return {
    items,
    total: countResult[0]?.count ?? 0,
    page,
    limit,
  };
}
