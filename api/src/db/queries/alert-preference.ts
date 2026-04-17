import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { adminAlertPreference } from "../schema/alert-preference.js";
import { adminUser } from "../schema/admin.js";
import type { AlertChannel } from "../../services/notification-dispatch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminAlertPreferenceRow {
  id: string;
  adminUserId: string;
  channel: AlertChannel;
}

export interface AdminAlertTargetRow {
  adminUserId: string;
  email: string;
  channel: AlertChannel;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getAlertPreference(
  db: PostgresJsDatabase,
  adminUserId: string,
): Promise<AdminAlertPreferenceRow | null> {
  const rows = await db
    .select({
      id: adminAlertPreference.id,
      adminUserId: adminAlertPreference.adminUserId,
      channel: adminAlertPreference.channel,
    })
    .from(adminAlertPreference)
    .where(eq(adminAlertPreference.adminUserId, adminUserId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { ...row, channel: row.channel as AlertChannel };
}

export async function upsertAlertPreference(
  db: PostgresJsDatabase,
  adminUserId: string,
  channel: AlertChannel,
): Promise<AdminAlertPreferenceRow> {
  const [row] = await db
    .insert(adminAlertPreference)
    .values({
      adminUserId,
      channel,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: adminAlertPreference.adminUserId,
      set: {
        channel,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: adminAlertPreference.id,
      adminUserId: adminAlertPreference.adminUserId,
      channel: adminAlertPreference.channel,
    });

  return { ...row, channel: row.channel as AlertChannel };
}

/**
 * Get all active admins with their alert preferences.
 * Admins without a preference row default to "both".
 */
export async function getAllAdminAlertTargets(
  db: PostgresJsDatabase,
): Promise<AdminAlertTargetRow[]> {
  const rows = await db
    .select({
      adminUserId: adminUser.id,
      email: adminUser.email,
      channel: adminAlertPreference.channel,
    })
    .from(adminUser)
    .leftJoin(adminAlertPreference, eq(adminUser.id, adminAlertPreference.adminUserId))
    .where(eq(adminUser.status, "active"));

  return rows.map((r) => ({
    adminUserId: r.adminUserId,
    email: r.email,
    channel: (r.channel as AlertChannel) ?? "both",
  }));
}
