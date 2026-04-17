import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { payment, paymentEvent, dispute } from "../schema/payment.js";
import { inventoryReservation } from "../schema/inventory.js";
import { transitionOrderStatus } from "./order-state-machine.js";
import { consumeReservation, releaseReservation, reserveInventory } from "./reservation.js";
import type { AdminAlertService } from "../../services/admin-alert.js";
import { createFulfillmentTaskForPaidOrder } from "./fulfillment-task.js";
import { findDisputeByProviderId, transitionDisputeStatus } from "./dispute.js";

function isTransitionError(err: unknown): boolean {
  return (err as { code?: string })?.code === "ERR_INVALID_TRANSITION";
}

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
  adminAlertService?: AdminAlertService,
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
  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "payment_status",
      newValue: "processing",
      reason: "Payment processing (webhook: payment_intent.succeeded)",
    });
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
    // Already in processing or paid — continue
  }

  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "payment_status",
      newValue: "paid",
      reason: "Payment succeeded (webhook: payment_intent.succeeded)",
    });
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
    // Already paid — idempotent
  }

  // Fetch ALL reservations for this order (active + expired)
  const allReservations = await db
    .select({
      id: inventoryReservation.id,
      status: inventoryReservation.status,
      variantId: inventoryReservation.variantId,
      locationId: inventoryReservation.locationId,
      quantity: inventoryReservation.quantity,
    })
    .from(inventoryReservation)
    .where(eq(inventoryReservation.orderId, paymentRecord.orderId));

  const activeReservations = allReservations.filter((r) => r.status === "active");
  const expiredReservations = allReservations.filter((r) => r.status === "expired");

  // Consume active reservations
  for (const res of activeReservations) {
    try {
      await consumeReservation(db, res.id);
    } catch (err: unknown) {
      if (!isTransitionError(err)) throw err;
      // Already consumed — idempotent
    }
  }

  // Handle expired reservations (payment race condition — FR-E008)
  if (expiredReservations.length > 0) {
    // Try to re-reserve inventory for expired reservations
    const newReservationIds: string[] = [];
    let reReserveFailed = false;

    for (const expired of expiredReservations) {
      try {
        const result = await reserveInventory(db, {
          variantId: expired.variantId,
          locationId: expired.locationId,
          quantity: expired.quantity,
          ttlMs: 15 * 60 * 1000, // 15 min TTL
          reservationReason: "payment_race_recovery",
          orderId: paymentRecord.orderId,
        });
        newReservationIds.push(result.reservation.id);
      } catch {
        // Inventory insufficient — cannot re-reserve
        reReserveFailed = true;
        break;
      }
    }

    if (reReserveFailed) {
      // Release any partial re-reservations we managed to create
      for (const rid of newReservationIds) {
        try {
          await releaseReservation(db, rid);
        } catch {
          // Best-effort cleanup
        }
      }

      // Flag order for manual review — keep status as pending_payment
      if (adminAlertService) {
        adminAlertService.queue({
          type: "reservation_expired_payment_received",
          orderId: paymentRecord.orderId,
          message:
            "Payment received but inventory reservations expired and stock is no longer available. Order requires manual review.",
          details: {
            expiredReservations: expiredReservations.map((r) => ({
              variantId: r.variantId,
              locationId: r.locationId,
              quantity: r.quantity,
            })),
          },
        });
      }
      // Do NOT transition order status to confirmed — stays pending_payment
      return;
    }

    // All re-reservations succeeded — consume them
    for (const rid of newReservationIds) {
      try {
        await consumeReservation(db, rid);
      } catch (err: unknown) {
        if (!isTransitionError(err)) throw err;
        // Already consumed — idempotent
      }
    }
  }

  // All reservations consumed (or re-reserved and consumed) — confirm order
  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "status",
      newValue: "confirmed",
      reason: "Payment confirmed (webhook: payment_intent.succeeded)",
    });
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
    // Already confirmed — idempotent
  }

  // Auto-create fulfillment task now that payment is confirmed
  try {
    await createFulfillmentTaskForPaidOrder(db, paymentRecord.orderId);
  } catch {
    // Non-fatal: fulfillment task creation should not block payment confirmation.
    // Possible failures include duplicate tasks (idempotent replay), payment status
    // not yet visible (ERR_PAYMENT_NOT_PAID), or transient DB errors.
    // All are safe to suppress here — the task can be created manually if needed.
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
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
    // Already in processing or failed — continue
  }

  try {
    await transitionOrderStatus(db, {
      orderId: paymentRecord.orderId,
      statusType: "payment_status",
      newValue: "failed",
      reason: "Payment failed (webhook: payment_intent.payment_failed)",
    });
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
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
    } catch (err: unknown) {
      if (!isTransitionError(err)) throw err;
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
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
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
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
    // Already disputed — idempotent
  }
}

// ---------------------------------------------------------------------------
// Handle: charge.dispute.closed
// ---------------------------------------------------------------------------

export async function handleDisputeClosed(
  db: PostgresJsDatabase,
  disputeData: {
    providerDisputeId: string;
    stripeStatus: string;
    closedAt: Date;
  },
): Promise<void> {
  const disputeRecord = await findDisputeByProviderId(db, disputeData.providerDisputeId);
  if (!disputeRecord) {
    throw {
      code: "ERR_DISPUTE_NOT_FOUND",
      message: `Dispute not found: ${disputeData.providerDisputeId}`,
    };
  }

  // Map Stripe status to our dispute outcome
  const outcome = disputeData.stripeStatus === "won" ? "won" : "lost";

  // Transition dispute to outcome state, then to closed
  // The dispute may be in opened, evidence_gathering, ready_to_submit, or submitted
  // For accepted disputes (admin accepted before Stripe closes), skip outcome transition
  if (
    disputeRecord.status !== "accepted" &&
    disputeRecord.status !== "won" &&
    disputeRecord.status !== "lost" &&
    disputeRecord.status !== "closed"
  ) {
    // Fast-path: if in opened/evidence_gathering/ready_to_submit, jump to submitted first
    // For won/lost, Stripe only sends close events for disputes that were submitted or auto-closed
    // We need to get to submitted state first if not already there
    if (disputeRecord.status === "opened") {
      try {
        await transitionDisputeStatus(db, {
          disputeId: disputeRecord.id,
          newStatus: "evidence_gathering",
        });
      } catch (err: unknown) {
        if (!isTransitionError(err)) throw err;
      }
    }

    // Re-fetch status after potential transition
    const afterEG = await findDisputeByProviderId(db, disputeData.providerDisputeId);
    if (afterEG && afterEG.status === "evidence_gathering") {
      try {
        await transitionDisputeStatus(db, {
          disputeId: disputeRecord.id,
          newStatus: "ready_to_submit",
        });
      } catch (err: unknown) {
        if (!isTransitionError(err)) throw err;
      }
    }

    const afterRTS = await findDisputeByProviderId(db, disputeData.providerDisputeId);
    if (afterRTS && afterRTS.status === "ready_to_submit") {
      try {
        await transitionDisputeStatus(db, { disputeId: disputeRecord.id, newStatus: "submitted" });
      } catch (err: unknown) {
        if (!isTransitionError(err)) throw err;
      }
    }

    // Now transition to outcome (won/lost)
    try {
      await transitionDisputeStatus(db, { disputeId: disputeRecord.id, newStatus: outcome });
    } catch (err: unknown) {
      if (!isTransitionError(err)) throw err;
    }
  }

  // Transition to closed
  try {
    await transitionDisputeStatus(db, {
      disputeId: disputeRecord.id,
      newStatus: "closed",
      closedAt: disputeData.closedAt,
    });
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
    // Already closed — idempotent
  }

  // Update order payment_status based on outcome
  // won → paid (dispute reversed), lost → refunded
  const newPaymentStatus = outcome === "won" ? "paid" : "refunded";
  try {
    await transitionOrderStatus(db, {
      orderId: disputeRecord.orderId,
      statusType: "payment_status",
      newValue: newPaymentStatus,
      reason: `Dispute ${outcome}: ${disputeData.providerDisputeId} (webhook: charge.dispute.closed)`,
    });
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
    // Already in target state — idempotent
  }
}
