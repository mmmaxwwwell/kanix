import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dispute } from "../schema/payment.js";

// ---------------------------------------------------------------------------
// Dispute status values
// ---------------------------------------------------------------------------

export const DISPUTE_STATUSES = [
  "opened",
  "evidence_gathering",
  "ready_to_submit",
  "submitted",
  "won",
  "lost",
  "accepted",
  "closed",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Dispute state machine (6.F)
// ---------------------------------------------------------------------------

export const DISPUTE_STATUS_TRANSITIONS: Record<string, string[]> = {
  opened: ["evidence_gathering", "accepted"],
  evidence_gathering: ["ready_to_submit"],
  ready_to_submit: ["submitted"],
  submitted: ["won", "lost"],
  won: ["closed"],
  lost: ["closed"],
  accepted: ["closed"],
  closed: [],
};

export function isValidDisputeTransition(from: string, to: string): boolean {
  const allowed = DISPUTE_STATUS_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

// ---------------------------------------------------------------------------
// Transition dispute status
// ---------------------------------------------------------------------------

export interface DisputeTransitionInput {
  disputeId: string;
  newStatus: string;
  closedAt?: Date;
}

export interface DisputeTransitionResult {
  success: true;
  disputeId: string;
  oldStatus: string;
  newStatus: string;
}

export async function transitionDisputeStatus(
  db: PostgresJsDatabase,
  input: DisputeTransitionInput,
): Promise<DisputeTransitionResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: dispute.id, status: dispute.status })
      .from(dispute)
      .where(eq(dispute.id, input.disputeId));

    if (!current) {
      throw { code: "ERR_DISPUTE_NOT_FOUND", message: `Dispute ${input.disputeId} not found` };
    }

    if (!isValidDisputeTransition(current.status, input.newStatus)) {
      throw {
        code: "ERR_INVALID_TRANSITION",
        message: `Invalid dispute transition: ${current.status} → ${input.newStatus}`,
        from: current.status,
        to: input.newStatus,
      };
    }

    const updateSet: Record<string, unknown> = { status: input.newStatus };
    if (input.closedAt) {
      updateSet.closedAt = input.closedAt;
    }

    await tx.update(dispute).set(updateSet).where(eq(dispute.id, input.disputeId));

    return {
      success: true as const,
      disputeId: input.disputeId,
      oldStatus: current.status,
      newStatus: input.newStatus,
    };
  });
}

// ---------------------------------------------------------------------------
// Find dispute by provider ID
// ---------------------------------------------------------------------------

export async function findDisputeByProviderId(
  db: PostgresJsDatabase,
  providerDisputeId: string,
): Promise<{
  id: string;
  paymentId: string;
  orderId: string;
  status: string;
  amountMinor: number;
} | null> {
  const [row] = await db
    .select({
      id: dispute.id,
      paymentId: dispute.paymentId,
      orderId: dispute.orderId,
      status: dispute.status,
      amountMinor: dispute.amountMinor,
    })
    .from(dispute)
    .where(eq(dispute.providerDisputeId, providerDisputeId));
  return row ?? null;
}
