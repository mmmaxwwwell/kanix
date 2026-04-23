import { eq, and, desc, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { policySnapshot, orderPolicyAcknowledgment } from "../schema/evidence.js";
import { createEvidenceRecord } from "./evidence.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewPolicySnapshot {
  policyType: string;
  version: number;
  contentHtml: string;
  contentText: string;
  effectiveAt: Date;
}

export interface PolicySnapshot {
  id: string;
  policyType: string;
  version: number;
  contentHtml: string;
  contentText: string;
  effectiveAt: Date;
}

export interface PolicyAcknowledgment {
  id: string;
  orderId: string;
  policySnapshotId: string;
  acknowledgedAt: Date;
  contextJson: unknown;
}

// ---------------------------------------------------------------------------
// Policy Snapshot CRUD
// ---------------------------------------------------------------------------

export async function insertPolicySnapshot(
  db: PostgresJsDatabase,
  input: NewPolicySnapshot,
): Promise<PolicySnapshot> {
  const [row] = await db
    .insert(policySnapshot)
    .values({
      policyType: input.policyType,
      version: input.version,
      contentHtml: input.contentHtml,
      contentText: input.contentText,
      effectiveAt: input.effectiveAt,
    })
    .returning();
  return row as PolicySnapshot;
}

export async function findPolicySnapshotById(
  db: PostgresJsDatabase,
  id: string,
): Promise<PolicySnapshot | null> {
  const rows = await db.select().from(policySnapshot).where(eq(policySnapshot.id, id));
  return (rows[0] as PolicySnapshot) ?? null;
}

/**
 * Find the current effective policy snapshot for a given type.
 * Returns the most recent snapshot where effective_at <= now.
 */
export async function findCurrentPolicyByType(
  db: PostgresJsDatabase,
  policyType: string,
): Promise<PolicySnapshot | null> {
  const rows = await db
    .select()
    .from(policySnapshot)
    .where(
      and(eq(policySnapshot.policyType, policyType), lte(policySnapshot.effectiveAt, new Date())),
    )
    .orderBy(desc(policySnapshot.effectiveAt))
    .limit(1);
  return (rows[0] as PolicySnapshot) ?? null;
}

export async function findPoliciesByType(
  db: PostgresJsDatabase,
  policyType: string,
): Promise<PolicySnapshot[]> {
  return db
    .select()
    .from(policySnapshot)
    .where(eq(policySnapshot.policyType, policyType))
    .orderBy(desc(policySnapshot.version)) as Promise<PolicySnapshot[]>;
}

// ---------------------------------------------------------------------------
// Policy Acknowledgment
// ---------------------------------------------------------------------------

export async function createPolicyAcknowledgment(
  db: PostgresJsDatabase,
  input: {
    orderId: string;
    policySnapshotId: string;
    contextJson?: unknown;
  },
): Promise<PolicyAcknowledgment> {
  const [row] = await db
    .insert(orderPolicyAcknowledgment)
    .values({
      orderId: input.orderId,
      policySnapshotId: input.policySnapshotId,
      acknowledgedAt: new Date(),
      contextJson: input.contextJson ?? null,
    })
    .returning();

  const ack = row as PolicyAcknowledgment;

  // Auto-collect evidence: policy_acceptance for every policy acknowledgment
  try {
    await createEvidenceRecord(db, {
      orderId: input.orderId,
      type: "policy_acceptance",
      textContent: JSON.stringify({
        acknowledgmentId: ack.id,
        policySnapshotId: input.policySnapshotId,
        acknowledgedAt: ack.acknowledgedAt,
      }),
      metadataJson: { acknowledgmentId: ack.id, policySnapshotId: input.policySnapshotId },
    });
  } catch {
    // Non-fatal: evidence collection should not block acknowledgment creation
  }

  return ack;
}

export async function findAcknowledgmentsByOrderId(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<PolicyAcknowledgment[]> {
  return db
    .select()
    .from(orderPolicyAcknowledgment)
    .where(eq(orderPolicyAcknowledgment.orderId, orderId)) as Promise<PolicyAcknowledgment[]>;
}

// ---------------------------------------------------------------------------
// Checkout helper: get current effective policies and create acknowledgments
// ---------------------------------------------------------------------------

const CHECKOUT_POLICY_TYPES = [
  "terms_of_service",
  "refund_policy",
  "shipping_policy",
  "privacy_policy",
];

/**
 * Validate that all required checkout policy snapshots exist.
 * Returns an array of missing policy type names, or empty if all present.
 */
export async function validateCheckoutPolicies(db: PostgresJsDatabase): Promise<string[]> {
  const missing: string[] = [];
  for (const policyType of CHECKOUT_POLICY_TYPES) {
    const currentPolicy = await findCurrentPolicyByType(db, policyType);
    if (!currentPolicy) {
      missing.push(policyType);
    }
  }
  return missing;
}

export async function createCheckoutAcknowledgments(
  db: PostgresJsDatabase,
  orderId: string,
  contextJson?: unknown,
): Promise<PolicyAcknowledgment[]> {
  const missing = await validateCheckoutPolicies(db);
  if (missing.length > 0) {
    const err = new Error(`Missing required policies: ${missing.join(", ")}`);
    (err as Error & { code: string; missingPolicies: string[] }).code = "ERR_MISSING_POLICY";
    (err as Error & { missingPolicies: string[] }).missingPolicies = missing;
    throw err;
  }

  const acknowledgments: PolicyAcknowledgment[] = [];

  for (const policyType of CHECKOUT_POLICY_TYPES) {
    const currentPolicy = await findCurrentPolicyByType(db, policyType);
    if (currentPolicy) {
      const ack = await createPolicyAcknowledgment(db, {
        orderId,
        policySnapshotId: currentPolicy.id,
        contextJson,
      });
      acknowledgments.push(ack);
    }
  }

  return acknowledgments;
}
