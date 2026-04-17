import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { evidenceRecord } from "../schema/evidence.js";

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
