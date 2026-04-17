import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { evidenceRecord, evidenceBundle } from "../schema/evidence.js";
import { dispute } from "../schema/payment.js";

// ---------------------------------------------------------------------------
// Evidence record types (must match CHECK constraint on evidence_record.type)
// ---------------------------------------------------------------------------

export const EVIDENCE_TYPES = [
  "tracking_history",
  "delivery_proof",
  "customer_communication",
  "policy_acceptance",
  "payment_receipt",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

// ---------------------------------------------------------------------------
// Create evidence record (append-only — DB triggers prevent UPDATE/DELETE)
// ---------------------------------------------------------------------------

export interface CreateEvidenceRecordInput {
  orderId?: string;
  paymentId?: string;
  shipmentId?: string;
  disputeId?: string;
  supportTicketId?: string;
  type: EvidenceType;
  storageKey?: string;
  textContent?: string;
  metadataJson?: unknown;
}

export interface EvidenceRecordRow {
  id: string;
  orderId: string | null;
  paymentId: string | null;
  shipmentId: string | null;
  disputeId: string | null;
  supportTicketId: string | null;
  type: string;
  storageKey: string | null;
  textContent: string | null;
  metadataJson: unknown;
  createdAt: Date;
}

const evidenceColumns = {
  id: evidenceRecord.id,
  orderId: evidenceRecord.orderId,
  paymentId: evidenceRecord.paymentId,
  shipmentId: evidenceRecord.shipmentId,
  disputeId: evidenceRecord.disputeId,
  supportTicketId: evidenceRecord.supportTicketId,
  type: evidenceRecord.type,
  storageKey: evidenceRecord.storageKey,
  textContent: evidenceRecord.textContent,
  metadataJson: evidenceRecord.metadataJson,
  createdAt: evidenceRecord.createdAt,
};

export async function createEvidenceRecord(
  db: PostgresJsDatabase,
  input: CreateEvidenceRecordInput,
): Promise<EvidenceRecordRow> {
  const [row] = await db
    .insert(evidenceRecord)
    .values({
      orderId: input.orderId ?? null,
      paymentId: input.paymentId ?? null,
      shipmentId: input.shipmentId ?? null,
      disputeId: input.disputeId ?? null,
      supportTicketId: input.supportTicketId ?? null,
      type: input.type,
      storageKey: input.storageKey ?? null,
      textContent: input.textContent ?? null,
      metadataJson: input.metadataJson ?? null,
    })
    .returning(evidenceColumns);
  return row;
}

// ---------------------------------------------------------------------------
// Find evidence records by order ID
// ---------------------------------------------------------------------------

export async function findEvidenceByOrderId(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<EvidenceRecordRow[]> {
  return db.select(evidenceColumns).from(evidenceRecord).where(eq(evidenceRecord.orderId, orderId));
}

// ---------------------------------------------------------------------------
// Find evidence records by shipment ID
// ---------------------------------------------------------------------------

export async function findEvidenceByShipmentId(
  db: PostgresJsDatabase,
  shipmentId: string,
): Promise<EvidenceRecordRow[]> {
  return db
    .select(evidenceColumns)
    .from(evidenceRecord)
    .where(eq(evidenceRecord.shipmentId, shipmentId));
}

// ---------------------------------------------------------------------------
// Readiness summary — checks which evidence types are present for an order
// ---------------------------------------------------------------------------

export interface DisputeReadinessSummary {
  tracking_history_present: boolean;
  delivery_proof_present: boolean;
  customer_communication_present: boolean;
  policy_acceptance_present: boolean;
  payment_receipt_present: boolean;
  complete: boolean;
  missing_types: string[];
}

export function computeReadinessSummary(records: EvidenceRecordRow[]): DisputeReadinessSummary {
  const types = new Set(records.map((r) => r.type));
  const tracking_history_present = types.has("tracking_history");
  const delivery_proof_present = types.has("delivery_proof");
  const customer_communication_present = types.has("customer_communication");
  const policy_acceptance_present = types.has("policy_acceptance");
  const payment_receipt_present = types.has("payment_receipt");

  const missing_types: string[] = [];
  if (!tracking_history_present) missing_types.push("tracking_history");
  if (!delivery_proof_present) missing_types.push("delivery_proof");
  if (!customer_communication_present) missing_types.push("customer_communication");
  if (!policy_acceptance_present) missing_types.push("policy_acceptance");
  if (!payment_receipt_present) missing_types.push("payment_receipt");

  return {
    tracking_history_present,
    delivery_proof_present,
    customer_communication_present,
    policy_acceptance_present,
    payment_receipt_present,
    complete: missing_types.length === 0,
    missing_types,
  };
}

// ---------------------------------------------------------------------------
// Find dispute by ID (with orderId)
// ---------------------------------------------------------------------------

export async function findDisputeById(
  db: PostgresJsDatabase,
  disputeId: string,
): Promise<{
  id: string;
  paymentId: string;
  orderId: string;
  status: string;
  amountMinor: number;
  reason: string | null;
  currency: string;
} | null> {
  const [row] = await db
    .select({
      id: dispute.id,
      paymentId: dispute.paymentId,
      orderId: dispute.orderId,
      status: dispute.status,
      amountMinor: dispute.amountMinor,
      reason: dispute.reason,
      currency: dispute.currency,
    })
    .from(dispute)
    .where(eq(dispute.id, disputeId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Evidence bundle generation
// ---------------------------------------------------------------------------

export interface GenerateBundleResult {
  bundleId: string;
  disputeId: string;
  readiness: DisputeReadinessSummary;
  evidenceCount: number;
  storageKey: string;
}

export async function generateEvidenceBundle(
  db: PostgresJsDatabase,
  disputeId: string,
): Promise<GenerateBundleResult> {
  // 1. Look up the dispute
  const disputeRow = await findDisputeById(db, disputeId);
  if (!disputeRow) {
    throw { code: "ERR_DISPUTE_NOT_FOUND", message: `Dispute ${disputeId} not found` };
  }

  // 2. Gather all evidence records for this dispute's order
  const records = await findEvidenceByOrderId(db, disputeRow.orderId);

  // 3. Compute readiness
  const readiness = computeReadinessSummary(records);

  // 4. If readiness is incomplete, reject
  if (!readiness.complete) {
    throw {
      code: "ERR_EVIDENCE_INCOMPLETE",
      message: `Evidence incomplete — missing types: ${readiness.missing_types.join(", ")}`,
      readiness,
    };
  }

  // 5. Build the bundle content as a JSON document
  const bundleContent = {
    disputeId,
    orderId: disputeRow.orderId,
    generatedAt: new Date().toISOString(),
    evidenceCount: records.length,
    readiness,
    evidence: records.map((r) => ({
      id: r.id,
      type: r.type,
      createdAt: r.createdAt.toISOString(),
      textContent: r.textContent ? JSON.parse(r.textContent) : null,
      storageKey: r.storageKey,
      metadataJson: r.metadataJson,
    })),
  };

  const storageKey = `evidence-bundles/${disputeId}/${Date.now()}.json`;

  // 6. Create the evidence_bundle record
  const [bundle] = await db
    .insert(evidenceBundle)
    .values({
      disputeId,
      status: "generated",
      generatedAt: new Date(),
      storageKey,
      metadataJson: {
        evidenceCount: records.length,
        readiness,
      },
    })
    .returning({ id: evidenceBundle.id });

  return {
    bundleId: bundle.id,
    disputeId,
    readiness,
    evidenceCount: records.length,
    storageKey,
    _content: bundleContent,
  } as GenerateBundleResult & { _content: unknown };
}
