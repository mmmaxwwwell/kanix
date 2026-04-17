import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { refund } from "../schema/payment.js";
import { payment } from "../schema/payment.js";
import { transitionOrderStatus } from "./order-state-machine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateRefundInput {
  orderId: string;
  paymentId: string;
  providerRefundId: string;
  amountMinor: number;
  reason: string;
  status: string;
  actorAdminUserId: string;
}

export interface RefundRecord {
  id: string;
  orderId: string;
  paymentId: string;
  providerRefundId: string | null;
  amountMinor: number;
  reason: string;
  status: string;
  actorAdminUserId: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function findPaymentByOrderId(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<{
  id: string;
  orderId: string;
  providerPaymentIntentId: string;
  amountMinor: number;
  status: string;
} | null> {
  const [row] = await db
    .select({
      id: payment.id,
      orderId: payment.orderId,
      providerPaymentIntentId: payment.providerPaymentIntentId,
      amountMinor: payment.amountMinor,
      status: payment.status,
    })
    .from(payment)
    .where(eq(payment.orderId, orderId));
  return row ?? null;
}

export async function getTotalRefundedForOrder(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${refund.amountMinor}), 0)`,
    })
    .from(refund)
    .where(eq(refund.orderId, orderId));
  return Number(row?.total ?? 0);
}

export async function insertRefund(
  db: PostgresJsDatabase,
  input: CreateRefundInput,
): Promise<RefundRecord> {
  const [row] = await db
    .insert(refund)
    .values({
      orderId: input.orderId,
      paymentId: input.paymentId,
      providerRefundId: input.providerRefundId,
      amountMinor: input.amountMinor,
      reason: input.reason,
      status: input.status,
      actorAdminUserId: input.actorAdminUserId,
    })
    .returning();
  return row as RefundRecord;
}

export async function findRefundsByOrderId(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<RefundRecord[]> {
  return db.select().from(refund).where(eq(refund.orderId, orderId)) as Promise<RefundRecord[]>;
}

/**
 * Process a refund: validate amount, create Stripe refund, insert record, transition payment_status.
 */
export async function processRefund(
  db: PostgresJsDatabase,
  input: {
    orderId: string;
    amountMinor: number;
    reason: string;
    actorAdminUserId: string;
    createStripeRefund: (
      paymentIntentId: string,
      amountMinor: number,
    ) => Promise<{ id: string; status: string }>;
  },
): Promise<RefundRecord> {
  // Find payment for this order
  const paymentRecord = await findPaymentByOrderId(db, input.orderId);
  if (!paymentRecord) {
    const err = new Error("No payment found for this order");
    (err as unknown as Record<string, string>).code = "ERR_PAYMENT_NOT_FOUND";
    throw err;
  }

  // Calculate remaining refundable amount
  const totalRefunded = await getTotalRefundedForOrder(db, input.orderId);
  const remainingRefundable = paymentRecord.amountMinor - totalRefunded;

  if (input.amountMinor > remainingRefundable) {
    const err = new Error(
      `Refund amount ${input.amountMinor} exceeds remaining refundable amount ${remainingRefundable}`,
    );
    (err as unknown as Record<string, string>).code = "ERR_REFUND_EXCEEDS_PAYMENT";
    throw err;
  }

  if (input.amountMinor <= 0) {
    const err = new Error("Refund amount must be positive");
    (err as unknown as Record<string, string>).code = "ERR_VALIDATION";
    throw err;
  }

  // Create Stripe refund via adapter
  const stripeRefund = await input.createStripeRefund(
    paymentRecord.providerPaymentIntentId,
    input.amountMinor,
  );

  // Insert refund record
  const refundRecord = await insertRefund(db, {
    orderId: input.orderId,
    paymentId: paymentRecord.id,
    providerRefundId: stripeRefund.id,
    amountMinor: input.amountMinor,
    reason: input.reason,
    status: stripeRefund.status,
    actorAdminUserId: input.actorAdminUserId,
  });

  // Determine new payment status
  const newTotalRefunded = totalRefunded + input.amountMinor;
  const newPaymentStatus =
    newTotalRefunded >= paymentRecord.amountMinor ? "refunded" : "partially_refunded";

  // Transition payment_status
  try {
    await transitionOrderStatus(db, {
      orderId: input.orderId,
      statusType: "payment_status",
      newValue: newPaymentStatus,
      reason: `Admin refund: ${input.amountMinor} cents — ${input.reason}`,
      actorAdminUserId: input.actorAdminUserId,
    });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code !== "ERR_INVALID_TRANSITION") throw err;
    // Already in target state — idempotent
  }

  return refundRecord;
}
