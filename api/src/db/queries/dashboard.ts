import { eq, and, sql, lt, gte, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { order } from "../schema/order.js";
import { supportTicket } from "../schema/support.js";
import { inventoryBalance, inventoryReservation } from "../schema/inventory.js";
import { dispute } from "../schema/payment.js";
import { shipment } from "../schema/fulfillment.js";

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  ordersAwaitingFulfillment: number;
  openSupportTickets: number;
  lowStockVariants: number;
  openDisputes: number;
  shipmentsWithExceptions: number;
}

export async function getDashboardSummary(db: PostgresJsDatabase): Promise<DashboardSummary> {
  const [ordersResult, ticketsResult, lowStockResult, disputesResult, shipmentsResult] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(order)
        .where(
          and(
            inArray(order.status, ["confirmed", "pending_payment"]),
            eq(order.fulfillmentStatus, "unfulfilled"),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(supportTicket)
        .where(
          inArray(supportTicket.status, ["open", "waiting_on_customer", "waiting_on_internal"]),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(inventoryBalance)
        .where(sql`${inventoryBalance.available} <= ${inventoryBalance.safetyStock}`),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(dispute)
        .where(
          inArray(dispute.status, ["opened", "evidence_gathering", "ready_to_submit", "submitted"]),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(shipment)
        .where(eq(shipment.status, "exception")),
    ]);

  return {
    ordersAwaitingFulfillment: ordersResult[0]?.count ?? 0,
    openSupportTickets: ticketsResult[0]?.count ?? 0,
    lowStockVariants: lowStockResult[0]?.count ?? 0,
    openDisputes: disputesResult[0]?.count ?? 0,
    shipmentsWithExceptions: shipmentsResult[0]?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Dashboard alerts
// ---------------------------------------------------------------------------

export interface DashboardAlert {
  type: string;
  severity: "warning" | "critical";
  message: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

export async function getDashboardAlerts(db: PostgresJsDatabase): Promise<DashboardAlert[]> {
  const now = new Date();
  const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  const alerts: DashboardAlert[] = [];

  // 1. Expiring reservations (within 24 hours)
  const expiringReservations = await db
    .select({
      id: inventoryReservation.id,
      variantId: inventoryReservation.variantId,
      expiresAt: inventoryReservation.expiresAt,
    })
    .from(inventoryReservation)
    .where(
      and(
        eq(inventoryReservation.status, "pending"),
        lt(inventoryReservation.expiresAt, in24Hours),
        gte(inventoryReservation.expiresAt, now),
      ),
    );

  for (const reservation of expiringReservations) {
    alerts.push({
      type: "reservation_expiring",
      severity: "warning",
      message: `Reservation ${reservation.id} expires at ${reservation.expiresAt?.toISOString()}`,
      entityType: "inventory_reservation",
      entityId: reservation.id,
      metadata: {
        variantId: reservation.variantId,
        expiresAt: reservation.expiresAt?.toISOString(),
      },
    });
  }

  // 2. Disputes nearing due_by (within 48 hours)
  const urgentDisputes = await db
    .select({
      id: dispute.id,
      providerDisputeId: dispute.providerDisputeId,
      dueBy: dispute.dueBy,
      status: dispute.status,
    })
    .from(dispute)
    .where(
      and(
        inArray(dispute.status, ["opened", "evidence_gathering", "ready_to_submit"]),
        lt(dispute.dueBy, in48Hours),
        gte(dispute.dueBy, now),
      ),
    );

  for (const d of urgentDisputes) {
    alerts.push({
      type: "dispute_due_soon",
      severity: "critical",
      message: `Dispute ${d.providerDisputeId} due by ${d.dueBy?.toISOString()}`,
      entityType: "dispute",
      entityId: d.id,
      metadata: {
        providerDisputeId: d.providerDisputeId,
        dueBy: d.dueBy?.toISOString(),
        status: d.status,
      },
    });
  }

  // 3. Overdue disputes (past due_by but still open)
  const overdueDisputes = await db
    .select({
      id: dispute.id,
      providerDisputeId: dispute.providerDisputeId,
      dueBy: dispute.dueBy,
      status: dispute.status,
    })
    .from(dispute)
    .where(
      and(
        inArray(dispute.status, ["opened", "evidence_gathering", "ready_to_submit"]),
        lt(dispute.dueBy, now),
      ),
    );

  for (const d of overdueDisputes) {
    alerts.push({
      type: "dispute_overdue",
      severity: "critical",
      message: `Dispute ${d.providerDisputeId} is overdue (was due ${d.dueBy?.toISOString()})`,
      entityType: "dispute",
      entityId: d.id,
      metadata: {
        providerDisputeId: d.providerDisputeId,
        dueBy: d.dueBy?.toISOString(),
        status: d.status,
      },
    });
  }

  return alerts;
}
