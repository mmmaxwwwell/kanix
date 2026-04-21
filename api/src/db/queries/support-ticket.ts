import { eq, and, desc, gte, lt, inArray, isNull, notExists } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  supportTicket,
  supportTicketMessage,
  supportTicketAttachment,
  supportTicketStatusHistory,
} from "../schema/support.js";
import { order, orderLine } from "../schema/order.js";
import { shipment } from "../schema/fulfillment.js";
import { createEvidenceRecord } from "./evidence.js";

// ---------------------------------------------------------------------------
// Ticket status values and state machine (6.C)
// ---------------------------------------------------------------------------

export const TICKET_STATUSES = [
  "open",
  "waiting_on_customer",
  "waiting_on_internal",
  "resolved",
  "closed",
  "spam",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** support_ticket.status transitions (6.C) */
export const TICKET_TRANSITIONS: Record<string, string[]> = {
  open: ["waiting_on_customer", "waiting_on_internal", "resolved", "spam"],
  waiting_on_customer: ["open"],
  waiting_on_internal: ["open"],
  resolved: ["closed", "open"],
  closed: [],
  spam: [],
};

export function isValidTicketTransition(from: string, to: string): boolean {
  const allowed = TICKET_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

// ---------------------------------------------------------------------------
// Ticket number generation
// ---------------------------------------------------------------------------

export function generateTicketNumber(): string {
  return `TKT-${Date.now().toString(36).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Create support ticket
// ---------------------------------------------------------------------------

export interface CreateTicketInput {
  customerId?: string;
  orderId?: string;
  shipmentId?: string;
  subject: string;
  category: string;
  priority?: string;
  source: string;
  /** Admin override: skip duplicate detection and force-create the ticket */
  forceDuplicate?: boolean;
}

export interface TicketRecord {
  id: string;
  ticketNumber: string;
  customerId: string | null;
  orderId: string | null;
  shipmentId: string | null;
  subject: string;
  category: string;
  priority: string;
  status: string;
  source: string;
  potentialDuplicate: boolean;
  linkedTicketId: string | null;
  duplicateDismissed: boolean;
  mergedIntoTicketId: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  slaBreachedAt: Date | null;
}

export async function createSupportTicket(
  db: PostgresJsDatabase,
  input: CreateTicketInput,
): Promise<TicketRecord> {
  const ticketNumber = generateTicketNumber();

  // Duplicate detection: check if the same customer has an open/waiting ticket
  // for the same order AND same category within the last 24 hours
  let potentialDuplicate = false;
  let linkedTicketId: string | null = null;

  if (input.customerId && input.orderId && !input.forceDuplicate) {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeStatuses = ["open", "waiting_on_customer", "waiting_on_internal"];

    const [existingTicket] = await db
      .select({ id: supportTicket.id })
      .from(supportTicket)
      .where(
        and(
          eq(supportTicket.customerId, input.customerId),
          eq(supportTicket.orderId, input.orderId),
          eq(supportTicket.category, input.category),
          inArray(supportTicket.status, activeStatuses),
          gte(supportTicket.createdAt, twentyFourHoursAgo),
        ),
      )
      .orderBy(desc(supportTicket.createdAt))
      .limit(1);

    if (existingTicket) {
      potentialDuplicate = true;
      linkedTicketId = existingTicket.id;
    }
  }

  const [row] = await db
    .insert(supportTicket)
    .values({
      ticketNumber,
      customerId: input.customerId ?? null,
      orderId: input.orderId ?? null,
      shipmentId: input.shipmentId ?? null,
      subject: input.subject,
      category: input.category,
      priority: input.priority ?? "normal",
      status: "open",
      source: input.source,
      potentialDuplicate,
      linkedTicketId,
    })
    .returning(ticketColumns);
  return row;
}

// ---------------------------------------------------------------------------
// Find ticket by ID
// ---------------------------------------------------------------------------

const ticketColumns = {
  id: supportTicket.id,
  ticketNumber: supportTicket.ticketNumber,
  customerId: supportTicket.customerId,
  orderId: supportTicket.orderId,
  shipmentId: supportTicket.shipmentId,
  subject: supportTicket.subject,
  category: supportTicket.category,
  priority: supportTicket.priority,
  status: supportTicket.status,
  source: supportTicket.source,
  potentialDuplicate: supportTicket.potentialDuplicate,
  linkedTicketId: supportTicket.linkedTicketId,
  duplicateDismissed: supportTicket.duplicateDismissed,
  mergedIntoTicketId: supportTicket.mergedIntoTicketId,
  createdAt: supportTicket.createdAt,
  updatedAt: supportTicket.updatedAt,
  resolvedAt: supportTicket.resolvedAt,
  slaBreachedAt: supportTicket.slaBreachedAt,
};

export async function findTicketById(
  db: PostgresJsDatabase,
  id: string,
): Promise<TicketRecord | null> {
  const [row] = await db.select(ticketColumns).from(supportTicket).where(eq(supportTicket.id, id));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// List tickets with optional filters
// ---------------------------------------------------------------------------

export interface ListTicketsInput {
  status?: string;
  priority?: string;
  customerId?: string;
  orderId?: string;
}

export async function listSupportTickets(
  db: PostgresJsDatabase,
  filters?: ListTicketsInput,
): Promise<TicketRecord[]> {
  const conditions = [];
  if (filters?.status) {
    conditions.push(eq(supportTicket.status, filters.status));
  }
  if (filters?.priority) {
    conditions.push(eq(supportTicket.priority, filters.priority));
  }
  if (filters?.customerId) {
    conditions.push(eq(supportTicket.customerId, filters.customerId));
  }
  if (filters?.orderId) {
    conditions.push(eq(supportTicket.orderId, filters.orderId));
  }

  const query = db.select(ticketColumns).from(supportTicket).orderBy(desc(supportTicket.createdAt));

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }

  return query;
}

// ---------------------------------------------------------------------------
// List tickets for a specific customer (customer-facing)
// ---------------------------------------------------------------------------

export async function listTicketsByCustomerId(
  db: PostgresJsDatabase,
  customerId: string,
): Promise<TicketRecord[]> {
  return db
    .select(ticketColumns)
    .from(supportTicket)
    .where(eq(supportTicket.customerId, customerId))
    .orderBy(desc(supportTicket.createdAt));
}

// ---------------------------------------------------------------------------
// Transition ticket status
// ---------------------------------------------------------------------------

export interface TransitionTicketInput {
  ticketId: string;
  newStatus: string;
  reason?: string;
  actorAdminUserId?: string;
}

export async function transitionTicketStatus(
  db: PostgresJsDatabase,
  input: TransitionTicketInput,
): Promise<{
  id: string;
  ticketNumber: string;
  oldStatus: string;
  newStatus: string;
  resolvedAt: Date | null;
}> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: supportTicket.id,
        ticketNumber: supportTicket.ticketNumber,
        status: supportTicket.status,
      })
      .from(supportTicket)
      .where(eq(supportTicket.id, input.ticketId));

    if (!current) {
      throw {
        code: "ERR_TICKET_NOT_FOUND",
        message: `Support ticket ${input.ticketId} not found`,
      };
    }

    if (!isValidTicketTransition(current.status, input.newStatus)) {
      throw {
        code: "ERR_INVALID_TRANSITION",
        message: `Invalid ticket transition: ${current.status} → ${input.newStatus}`,
        from: current.status,
        to: input.newStatus,
      };
    }

    const now = new Date();
    const resolvedAt = input.newStatus === "resolved" ? now : null;

    await tx
      .update(supportTicket)
      .set({
        status: input.newStatus,
        updatedAt: now,
        ...(resolvedAt ? { resolvedAt } : {}),
      })
      .where(eq(supportTicket.id, input.ticketId));

    // Record status history
    await tx.insert(supportTicketStatusHistory).values({
      ticketId: input.ticketId,
      oldStatus: current.status,
      newStatus: input.newStatus,
      actorAdminUserId: input.actorAdminUserId ?? null,
    });

    return {
      id: current.id,
      ticketNumber: current.ticketNumber,
      oldStatus: current.status,
      newStatus: input.newStatus,
      resolvedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MessageRecord {
  id: string;
  ticketId: string;
  authorType: string;
  customerId: string | null;
  adminUserId: string | null;
  body: string;
  isInternalNote: boolean;
  createdAt: Date;
}

const messageColumns = {
  id: supportTicketMessage.id,
  ticketId: supportTicketMessage.ticketId,
  authorType: supportTicketMessage.authorType,
  customerId: supportTicketMessage.customerId,
  adminUserId: supportTicketMessage.adminUserId,
  body: supportTicketMessage.body,
  isInternalNote: supportTicketMessage.isInternalNote,
  createdAt: supportTicketMessage.createdAt,
};

export interface CreateMessageInput {
  ticketId: string;
  authorType: "customer" | "admin" | "system";
  customerId?: string;
  adminUserId?: string;
  body: string;
  isInternalNote?: boolean;
}

export async function createTicketMessage(
  db: PostgresJsDatabase,
  input: CreateMessageInput,
): Promise<MessageRecord> {
  // Verify ticket exists
  const [ticket] = await db
    .select({ id: supportTicket.id, status: supportTicket.status })
    .from(supportTicket)
    .where(eq(supportTicket.id, input.ticketId));

  if (!ticket) {
    throw {
      code: "ERR_TICKET_NOT_FOUND",
      message: `Support ticket ${input.ticketId} not found`,
    };
  }

  if (ticket.status === "closed" || ticket.status === "spam") {
    throw {
      code: "ERR_TICKET_CLOSED",
      message: `Cannot add message to ticket in ${ticket.status} status`,
    };
  }

  const [row] = await db
    .insert(supportTicketMessage)
    .values({
      ticketId: input.ticketId,
      authorType: input.authorType,
      customerId: input.customerId ?? null,
      adminUserId: input.adminUserId ?? null,
      body: input.body,
      isInternalNote: input.isInternalNote ?? false,
    })
    .returning(messageColumns);

  // Update ticket updatedAt
  await db
    .update(supportTicket)
    .set({ updatedAt: new Date() })
    .where(eq(supportTicket.id, input.ticketId));

  // Auto-collect evidence: customer_communication for non-internal messages
  if (!(input.isInternalNote ?? false)) {
    // Look up the ticket to get orderId for evidence linking
    const [ticketRow] = await db
      .select({ orderId: supportTicket.orderId })
      .from(supportTicket)
      .where(eq(supportTicket.id, input.ticketId));

    if (ticketRow?.orderId) {
      try {
        await createEvidenceRecord(db, {
          orderId: ticketRow.orderId,
          supportTicketId: input.ticketId,
          type: "customer_communication",
          textContent: JSON.stringify({
            messageId: row.id,
            authorType: input.authorType,
            body: input.body,
            createdAt: row.createdAt,
          }),
          metadataJson: { messageId: row.id },
        });
      } catch {
        // Non-fatal: evidence collection should not block message creation
      }
    }
  }

  return row;
}

// ---------------------------------------------------------------------------
// List messages for a ticket (customer-visible: exclude internal notes)
// ---------------------------------------------------------------------------

export async function listTicketMessages(
  db: PostgresJsDatabase,
  ticketId: string,
  options?: { includeInternalNotes?: boolean },
): Promise<MessageRecord[]> {
  const conditions = [eq(supportTicketMessage.ticketId, ticketId)];

  if (!options?.includeInternalNotes) {
    conditions.push(eq(supportTicketMessage.isInternalNote, false));
  }

  return db
    .select(messageColumns)
    .from(supportTicketMessage)
    .where(and(...conditions))
    .orderBy(supportTicketMessage.createdAt);
}

// ---------------------------------------------------------------------------
// Status history
// ---------------------------------------------------------------------------

export interface StatusHistoryRecord {
  id: string;
  ticketId: string;
  oldStatus: string;
  newStatus: string;
  actorAdminUserId: string | null;
  createdAt: Date;
}

export async function findTicketStatusHistory(
  db: PostgresJsDatabase,
  ticketId: string,
): Promise<StatusHistoryRecord[]> {
  return db
    .select({
      id: supportTicketStatusHistory.id,
      ticketId: supportTicketStatusHistory.ticketId,
      oldStatus: supportTicketStatusHistory.oldStatus,
      newStatus: supportTicketStatusHistory.newStatus,
      actorAdminUserId: supportTicketStatusHistory.actorAdminUserId,
      createdAt: supportTicketStatusHistory.createdAt,
    })
    .from(supportTicketStatusHistory)
    .where(eq(supportTicketStatusHistory.ticketId, ticketId))
    .orderBy(desc(supportTicketStatusHistory.createdAt));
}

// ---------------------------------------------------------------------------
// Duplicate ticket management — merge and dismiss
// ---------------------------------------------------------------------------

export async function dismissDuplicate(
  db: PostgresJsDatabase,
  ticketId: string,
): Promise<TicketRecord> {
  const [current] = await db
    .select(ticketColumns)
    .from(supportTicket)
    .where(eq(supportTicket.id, ticketId));

  if (!current) {
    throw {
      code: "ERR_TICKET_NOT_FOUND",
      message: `Support ticket ${ticketId} not found`,
    };
  }

  if (!current.potentialDuplicate) {
    throw {
      code: "ERR_NOT_DUPLICATE",
      message: "Ticket is not flagged as a potential duplicate",
    };
  }

  const [updated] = await db
    .update(supportTicket)
    .set({ duplicateDismissed: true, updatedAt: new Date() })
    .where(eq(supportTicket.id, ticketId))
    .returning(ticketColumns);

  return updated;
}

export async function mergeTicket(
  db: PostgresJsDatabase,
  sourceTicketId: string,
  targetTicketId: string,
  actorAdminUserId?: string,
): Promise<TicketRecord> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select(ticketColumns)
      .from(supportTicket)
      .where(eq(supportTicket.id, sourceTicketId));

    if (!source) {
      throw {
        code: "ERR_TICKET_NOT_FOUND",
        message: `Source ticket ${sourceTicketId} not found`,
      };
    }

    const [target] = await tx
      .select({ id: supportTicket.id, status: supportTicket.status })
      .from(supportTicket)
      .where(eq(supportTicket.id, targetTicketId));

    if (!target) {
      throw {
        code: "ERR_TICKET_NOT_FOUND",
        message: `Target ticket ${targetTicketId} not found`,
      };
    }

    // Close the source ticket and mark it as merged
    const now = new Date();
    const [updated] = await tx
      .update(supportTicket)
      .set({
        status: "closed",
        mergedIntoTicketId: targetTicketId,
        updatedAt: now,
      })
      .where(eq(supportTicket.id, sourceTicketId))
      .returning(ticketColumns);

    // Record status history for the merge/close
    await tx.insert(supportTicketStatusHistory).values({
      ticketId: sourceTicketId,
      oldStatus: source.status,
      newStatus: "closed",
      actorAdminUserId: actorAdminUserId ?? null,
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const ALLOWED_ATTACHMENT_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export interface AttachmentRecord {
  id: string;
  ticketId: string;
  messageId: string | null;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}

const attachmentColumns = {
  id: supportTicketAttachment.id,
  ticketId: supportTicketAttachment.ticketId,
  messageId: supportTicketAttachment.messageId,
  storageKey: supportTicketAttachment.storageKey,
  fileName: supportTicketAttachment.fileName,
  contentType: supportTicketAttachment.contentType,
  sizeBytes: supportTicketAttachment.sizeBytes,
  createdAt: supportTicketAttachment.createdAt,
};

export interface CreateAttachmentInput {
  ticketId: string;
  messageId?: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export async function createTicketAttachment(
  db: PostgresJsDatabase,
  input: CreateAttachmentInput,
): Promise<AttachmentRecord> {
  // Verify ticket exists
  const [ticket] = await db
    .select({ id: supportTicket.id })
    .from(supportTicket)
    .where(eq(supportTicket.id, input.ticketId));

  if (!ticket) {
    throw {
      code: "ERR_TICKET_NOT_FOUND",
      message: `Support ticket ${input.ticketId} not found`,
    };
  }

  // Validate content type
  if (!(ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(input.contentType)) {
    throw {
      code: "ERR_INVALID_CONTENT_TYPE",
      message: `Invalid content type: ${input.contentType}. Allowed: ${ALLOWED_ATTACHMENT_TYPES.join(", ")}`,
    };
  }

  // Validate size
  if (input.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    throw {
      code: "ERR_FILE_TOO_LARGE",
      message: `File size ${input.sizeBytes} exceeds maximum of ${MAX_ATTACHMENT_SIZE_BYTES} bytes`,
    };
  }

  // Check max attachments per message (if messageId provided)
  if (input.messageId) {
    const existingCount = await db
      .select({ id: supportTicketAttachment.id })
      .from(supportTicketAttachment)
      .where(eq(supportTicketAttachment.messageId, input.messageId));

    if (existingCount.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      throw {
        code: "ERR_TOO_MANY_ATTACHMENTS",
        message: `Maximum of ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message exceeded`,
      };
    }
  }

  // Check max attachments per ticket (when no messageId, it's attached to ticket directly)
  if (!input.messageId) {
    const existingCount = await db
      .select({ id: supportTicketAttachment.id })
      .from(supportTicketAttachment)
      .where(
        and(
          eq(supportTicketAttachment.ticketId, input.ticketId),
          isNull(supportTicketAttachment.messageId),
        ),
      );

    if (existingCount.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      throw {
        code: "ERR_TOO_MANY_ATTACHMENTS",
        message: `Maximum of ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per ticket exceeded`,
      };
    }
  }

  const [row] = await db
    .insert(supportTicketAttachment)
    .values({
      ticketId: input.ticketId,
      messageId: input.messageId ?? null,
      storageKey: input.storageKey,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    })
    .returning(attachmentColumns);

  return row;
}

export async function findAttachmentById(
  db: PostgresJsDatabase,
  id: string,
): Promise<AttachmentRecord | null> {
  const [row] = await db
    .select(attachmentColumns)
    .from(supportTicketAttachment)
    .where(eq(supportTicketAttachment.id, id));
  return row ?? null;
}

export async function listAttachmentsByTicketId(
  db: PostgresJsDatabase,
  ticketId: string,
): Promise<AttachmentRecord[]> {
  return db
    .select(attachmentColumns)
    .from(supportTicketAttachment)
    .where(eq(supportTicketAttachment.ticketId, ticketId))
    .orderBy(supportTicketAttachment.createdAt);
}

export async function deleteTicketAttachment(
  db: PostgresJsDatabase,
  id: string,
): Promise<AttachmentRecord | null> {
  const [row] = await db
    .delete(supportTicketAttachment)
    .where(eq(supportTicketAttachment.id, id))
    .returning(attachmentColumns);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// SLA breach detection (FR-050)
// ---------------------------------------------------------------------------

/** Default SLA threshold: 4 hours without an admin response */
export const DEFAULT_SLA_THRESHOLD_HOURS = 4;

export interface SlaBreachResult {
  ticketId: string;
  ticketNumber: string;
  slaBreachedAt: Date;
}

/**
 * Find open tickets without any admin response past the SLA threshold and
 * mark them as SLA-breached. Already-breached tickets are skipped.
 */
export async function findAndMarkSlaOverdueTickets(
  db: PostgresJsDatabase,
  thresholdHours: number = DEFAULT_SLA_THRESHOLD_HOURS,
): Promise<SlaBreachResult[]> {
  const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);
  const activeStatuses = ["open", "waiting_on_customer", "waiting_on_internal"];

  // Find tickets that are:
  // 1. In an active status
  // 2. Created before the cutoff (older than threshold)
  // 3. Have no admin messages
  // 4. Not already marked as SLA-breached
  const overdueTickets = await db
    .select({
      id: supportTicket.id,
      ticketNumber: supportTicket.ticketNumber,
    })
    .from(supportTicket)
    .where(
      and(
        inArray(supportTicket.status, activeStatuses),
        lt(supportTicket.createdAt, cutoff),
        isNull(supportTicket.slaBreachedAt),
        notExists(
          db
            .select({ id: supportTicketMessage.id })
            .from(supportTicketMessage)
            .where(
              and(
                eq(supportTicketMessage.ticketId, supportTicket.id),
                eq(supportTicketMessage.authorType, "admin"),
              ),
            ),
        ),
      ),
    );

  if (overdueTickets.length === 0) return [];

  const now = new Date();
  const results: SlaBreachResult[] = [];

  for (const ticket of overdueTickets) {
    await db
      .update(supportTicket)
      .set({ slaBreachedAt: now, updatedAt: now })
      .where(eq(supportTicket.id, ticket.id));

    results.push({
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      slaBreachedAt: now,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Warranty claim flow (T063 — FR-055)
// ---------------------------------------------------------------------------

/** 1-year warranty period in milliseconds */
const WARRANTY_PERIOD_MS = 365 * 24 * 60 * 60 * 1000;

/** Keywords that indicate TPU heat deformation */
const TPU_HEAT_KEYWORDS = [
  "heat",
  "deform",
  "deformation",
  "warp",
  "warped",
  "melted",
  "melt",
  "tpu",
  "temperature",
  "hot",
  "sun",
  "car dashboard",
];

export interface WarrantyClaimInput {
  customerId: string;
  orderId: string;
  orderLineId: string;
  description: string;
}

export interface WarrantyClaimResult {
  ticket: TicketRecord;
  materialLimitationFlagged: boolean;
  materialLimitationNote: string | null;
}

export async function createWarrantyClaim(
  db: PostgresJsDatabase,
  input: WarrantyClaimInput,
): Promise<WarrantyClaimResult> {
  // 1. Validate order exists and belongs to the customer
  const [orderRow] = await db
    .select({
      id: order.id,
      customerId: order.customerId,
      orderNumber: order.orderNumber,
      shippingStatus: order.shippingStatus,
    })
    .from(order)
    .where(eq(order.id, input.orderId));

  if (!orderRow) {
    throw { code: "ERR_ORDER_NOT_FOUND", message: "Order not found" };
  }

  if (orderRow.customerId !== input.customerId) {
    throw { code: "ERR_ORDER_NOT_FOUND", message: "Order not found" };
  }

  // 2. Validate order line exists and belongs to the order
  const [lineRow] = await db
    .select({
      id: orderLine.id,
      orderId: orderLine.orderId,
      titleSnapshot: orderLine.titleSnapshot,
    })
    .from(orderLine)
    .where(and(eq(orderLine.id, input.orderLineId), eq(orderLine.orderId, input.orderId)));

  if (!lineRow) {
    throw {
      code: "ERR_ORDER_LINE_NOT_FOUND",
      message: "Order line not found for this order",
    };
  }

  // 3. Validate the order has been delivered — find the latest delivered shipment
  const shipments = await db
    .select({
      id: shipment.id,
      deliveredAt: shipment.deliveredAt,
    })
    .from(shipment)
    .where(eq(shipment.orderId, input.orderId));

  // Find the earliest deliveredAt across all shipments for this order
  let deliveredAt: Date | null = null;
  for (const s of shipments) {
    if (s.deliveredAt) {
      if (!deliveredAt || s.deliveredAt < deliveredAt) {
        deliveredAt = s.deliveredAt;
      }
    }
  }

  if (!deliveredAt) {
    throw {
      code: "ERR_ORDER_NOT_DELIVERED",
      message: "Order has not been delivered yet",
    };
  }

  // 4. Validate within 1-year warranty period
  const warrantyExpiry = new Date(deliveredAt.getTime() + WARRANTY_PERIOD_MS);
  const now = new Date();

  if (now > warrantyExpiry) {
    throw {
      code: "ERR_WARRANTY_EXPIRED",
      message: `Warranty period has expired. Order was delivered on ${deliveredAt.toISOString().split("T")[0]} and the 1-year warranty expired on ${warrantyExpiry.toISOString().split("T")[0]}.`,
    };
  }

  // 5. Check for TPU heat deformation keywords in description
  const descLower = input.description.toLowerCase();
  const materialLimitationFlagged = TPU_HEAT_KEYWORDS.some((kw) => descLower.includes(kw));
  const materialLimitationNote = materialLimitationFlagged
    ? "This claim describes symptoms consistent with TPU heat deformation, which is a documented material limitation and may not be covered under warranty."
    : null;

  // 6. Create the support ticket with category=warranty_claim, priority=high
  const ticket = await createSupportTicket(db, {
    customerId: input.customerId,
    orderId: input.orderId,
    subject: `Warranty Claim: ${lineRow.titleSnapshot}`,
    category: "warranty_claim",
    priority: "high",
    source: "customer_app",
  });

  // 7. Create the initial message with the claim description
  await createTicketMessage(db, {
    ticketId: ticket.id,
    authorType: "customer",
    customerId: input.customerId,
    body: input.description,
  });

  // 8. If material limitation flagged, add an internal note for admin
  if (materialLimitationFlagged) {
    await createTicketMessage(db, {
      ticketId: ticket.id,
      authorType: "system",
      body: materialLimitationNote as string,
      isInternalNote: true,
    });
  }

  return {
    ticket,
    materialLimitationFlagged,
    materialLimitationNote,
  };
}
