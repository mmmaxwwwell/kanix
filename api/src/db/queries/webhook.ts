import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { payment, paymentEvent, dispute } from "../schema/payment.js";
import { inventoryReservation } from "../schema/inventory.js";
import { transitionOrderStatus } from "./order-state-machine.js";
import { consumeReservation, releaseReservation } from "./reservation.js";

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

/**
 * Check if a webhook event has already been processed.
 * Uses the UNIQUE constraint on provider_event_id.
 */
export async function hasEventBeenProcessed(
  db: PostgresJsDatabase,
  providerEventId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ id: paymentEvent.id })
    .from(paymentEvent)
    .where(eq(paymentEvent.providerEventId, providerEventId));
  return !!existing;
}

// ---------------------------------------------------------------------------
// Find payment by PaymentIntent ID
// ---------------------------------------------------------------------------

export async function findPaymentByIntentId(
  db: PostgresJsDatabase,
  providerPaymentIntentId: string,
): Promise<{
  id: string;
  orderId: string;
  status: string;
  amountMinor: number;
} | null> {
  const [row] = await db
    .select({
      id: payment.id,
      orderId: payment.orderId,
      status: payment.status,
      amountMinor: payment.amountMinor,
    })
    .from(payment)
    .where(eq(payment.providerPaymentIntentId, providerPaymentIntentId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Find payment by charge ID
// ---------------------------------------------------------------------------

export async function findPaymentByChargeId(
  db: PostgresJsDatabase,
  providerChargeId: string,
): Promise<{
  id: string;
  orderId: string;
  status: string;
  amountMinor: number;
} | null> {
  const [row] = await db
    .select({
      id: payment.id,
      orderId: payment.orderId,
      status: payment.status,
      amountMinor: payment.amountMinor,
    })
    .from(payment)
    .where(eq(payment.providerChargeId, providerChargeId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Store payment event (immutable audit record)
// ---------------------------------------------------------------------------

export async function storePaymentEvent(
  db: PostgresJsDatabase,
  input: {
    paymentId: string;
    providerEventId: string;
    eventType: string;
    payloadJson: unknown;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(paymentEvent)
    .values({
      paymentId: input.paymentId,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      payloadJson: input.payloadJson,
    })
    .returning({ id: paymentEvent.id });
  return row;
}

// ---------------------------------------------------------------------------
// Handle: payment_intent.succeeded
// ---------------------------------------------------------------------------

export async function handlePaymentSucceeded(
  db: PostgresJsDatabase,
  paymentRecord: { id: string; orderId: string },
  chargeId?: string,
): Promise<void> {
  // Update payment status and charge ID
  const updateSet: Record<string, unknown> = {
    status: "succeeded",
    updatedAt: new Date(),
  };
  if (chargeId) {
    updateSet.providerChargeId = chargeId;
  }
  await db.update(payment).set(updateSet).where(eq(payment.id, paymentRecord.id));

  // Transition order payment_status: unpaid → processing → paid
  // First try unpaid → processing (may already be there)
  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "payment_status",
      newValue: "processing",
      reason: "Payment processing (webhook: payment_intent.succeeded)",
    });
  } catch {
    // Already in processing or paid — continue
  }

  // Then processing → paid
  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "payment_status",
      newValue: "paid",
      reason: "Payment succeeded (webhook: payment_intent.succeeded)",
    });
  } catch {
    // Already paid — idempotent
  }

  // Transition order status: pending_payment → confirmed
  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "status",
      newValue: "confirmed",
      reason: "Payment confirmed (webhook: payment_intent.succeeded)",
    });
  } catch {
    // Already confirmed — idempotent
  }

  // Consume inventory reservations for this order
  const reservations = await db
    .select({ id: inventoryReservation.id, status: inventoryReservation.status })
    .from(inventoryReservation)
    .where(
      and(
        eq(inventoryReservation.orderId, paymentRecord.orderId),
        eq(inventoryReservation.status, "active"),
      ),
    );

  for (const res of reservations) {
    try {
      await consumeReservation(db, res.id);
    } catch {
      // Already consumed or expired — idempotent
    }
  }
}

// ---------------------------------------------------------------------------
// Handle: payment_intent.payment_failed
// ---------------------------------------------------------------------------

export async function handlePaymentFailed(
  db: PostgresJsDatabase,
  paymentRecord: { id: string; orderId: string },
): Promise<void> {
  // Update payment status
  await db
    .update(payment)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(payment.id, paymentRecord.id));

  // Transition order payment_status → failed
  // First ensure we're at processing
  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "payment_status",
      newValue: "processing",
      reason: "Payment attempted (webhook: payment_intent.payment_failed)",
    });
  } catch {
    // Already in processing or failed — continue
  }

  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "payment_status",
      newValue: "failed",
      reason: "Payment failed (webhook: payment_intent.payment_failed)",
    });
  } catch {
    // Already failed — idempotent
  }

  // Release inventory reservations for this order
  const reservations = await db
    .select({ id: inventoryReservation.id, status: inventoryReservation.status })
    .from(inventoryReservation)
    .where(
      and(
        eq(inventoryReservation.orderId, paymentRecord.orderId),
        eq(inventoryReservation.status, "active"),
      ),
    );

  for (const res of reservations) {
    try {
      await releaseReservation(db, res.id);
    } catch {
      // Already released — idempotent
    }
  }
}

// ---------------------------------------------------------------------------
// Handle: charge.refunded
// ---------------------------------------------------------------------------

export async function handleChargeRefunded(
  db: PostgresJsDatabase,
  paymentRecord: { id: string; orderId: string; amountMinor: number },
  refundAmountMinor: number,
): Promise<void> {
  // Determine if full or partial refund
  const newStatus =
    refundAmountMinor >= paymentRecord.amountMinor ? "refunded" : "partially_refunded";

  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "payment_status",
      newValue: newStatus,
      reason: `Refund processed: ${refundAmountMinor} cents (webhook: charge.refunded)`,
    });
  } catch {
    // Already in target state — idempotent
  }
}

// ---------------------------------------------------------------------------
// Handle: charge.dispute.created
// ---------------------------------------------------------------------------

export async function handleDisputeCreated(
  db: PostgresJsDatabase,
  paymentRecord: { id: string; orderId: string },
  disputeData: {
    providerDisputeId: string;
    reason?: string;
    amountMinor: number;
    currency: string;
    openedAt: Date;
    dueBy?: Date;
  },
): Promise<void> {
  // Create dispute record
  await db.insert(dispute).values({
    paymentId: paymentRecord.id,
    orderId: paymentRecord.orderId,
    providerDisputeId: disputeData.providerDisputeId,
    reason: disputeData.reason ?? null,
    amountMinor: disputeData.amountMinor,
    currency: disputeData.currency,
    status: "opened",
    openedAt: disputeData.openedAt,
    dueBy: disputeData.dueBy ?? null,
  });

  // Transition payment_status to disputed
  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "payment_status",
      newValue: "disputed",
      reason: `Dispute opened: ${disputeData.providerDisputeId} (webhook: charge.dispute.created)`,
    });
  } catch {
    // Already disputed — idempotent
  }
}
