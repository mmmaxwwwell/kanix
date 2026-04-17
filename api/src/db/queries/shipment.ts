import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  shipment,
  shipmentPackage,
  shipmentLine,
  shipmentEvent,
  shippingLabelPurchase,
} from "../schema/fulfillment.js";
import { order, orderLine } from "../schema/order.js";
import { processOrderCompletionSales } from "./contributor.js";
import type {
  ShippingAdapter,
  BuyLabelResult,
  TrackingResult,
} from "../../services/shipping-adapter.js";
import { transitionOrderStatus, findOrderById } from "./order-state-machine.js";
import { createEvidenceRecord } from "./evidence.js";
import type { AdminAlertService } from "../../services/admin-alert.js";

// ---------------------------------------------------------------------------
// Shipment status values and state machine (6.E)
// ---------------------------------------------------------------------------

export const SHIPMENT_STATUSES = [
  "draft",
  "label_pending",
  "label_purchased",
  "ready",
  "shipped",
  "in_transit",
  "delivered",
  "exception",
  "returned",
  "voided",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** shipment.status transitions (6.E) */
export const SHIPMENT_TRANSITIONS: Record<string, string[]> = {
  draft: ["label_pending", "voided"],
  label_pending: ["label_purchased", "voided"],
  label_purchased: ["ready", "voided"],
  ready: ["shipped", "voided"],
  shipped: ["in_transit"],
  in_transit: ["delivered", "exception"],
  delivered: ["returned"],
  exception: ["in_transit"], // exception resolved, back in transit
  returned: [],
  voided: [],
};

export function isValidShipmentTransition(from: string, to: string): boolean {
  const allowed = SHIPMENT_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

// ---------------------------------------------------------------------------
// Create shipment (draft)
// ---------------------------------------------------------------------------

export interface CreateShipmentInput {
  orderId: string;
  packages: {
    weight?: number;
    dimensions?: { length?: number; width?: number; height?: number };
    packageType?: string;
  }[];
  lines: {
    orderLineId: string;
    quantity: number;
  }[];
}

export interface ShipmentRecord {
  id: string;
  orderId: string;
  shipmentNumber: string;
  status: string;
  carrier: string | null;
  serviceLevel: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function createShipment(
  db: PostgresJsDatabase,
  input: CreateShipmentInput,
): Promise<{
  shipment: ShipmentRecord;
  packages: { id: string; shipmentId: string; weight: string | null; dimensionsJson: unknown }[];
  lines: { id: string; shipmentId: string; orderLineId: string; quantity: number }[];
}> {
  return db.transaction(async (tx) => {
    // Verify order exists
    const [orderRow] = await tx
      .select({ id: order.id, orderNumber: order.orderNumber })
      .from(order)
      .where(eq(order.id, input.orderId));

    if (!orderRow) {
      throw { code: "ERR_ORDER_NOT_FOUND", message: `Order ${input.orderId} not found` };
    }

    // Validate all order lines belong to this order
    for (const line of input.lines) {
      const [ol] = await tx
        .select({ id: orderLine.id, orderId: orderLine.orderId })
        .from(orderLine)
        .where(eq(orderLine.id, line.orderLineId));

      if (!ol) {
        throw {
          code: "ERR_ORDER_LINE_NOT_FOUND",
          message: `Order line ${line.orderLineId} not found`,
        };
      }
      if (ol.orderId !== input.orderId) {
        throw {
          code: "ERR_ORDER_LINE_MISMATCH",
          message: `Order line ${line.orderLineId} does not belong to order ${input.orderId}`,
        };
      }
    }

    // Generate shipment number: SHP-<order_number_suffix>-<sequence>
    const shipmentNumber = `SHP-${orderRow.orderNumber}-${Date.now().toString(36).toUpperCase()}`;

    // Create shipment record
    const [shipmentRow] = await tx
      .insert(shipment)
      .values({
        orderId: input.orderId,
        shipmentNumber,
        status: "draft",
      })
      .returning({
        id: shipment.id,
        orderId: shipment.orderId,
        shipmentNumber: shipment.shipmentNumber,
        status: shipment.status,
        carrier: shipment.carrier,
        serviceLevel: shipment.serviceLevel,
        trackingNumber: shipment.trackingNumber,
        trackingUrl: shipment.trackingUrl,
        labelUrl: shipment.labelUrl,
        createdAt: shipment.createdAt,
        updatedAt: shipment.updatedAt,
      });

    // Create packages
    const createdPackages = [];
    for (const pkg of input.packages) {
      const [pkgRow] = await tx
        .insert(shipmentPackage)
        .values({
          shipmentId: shipmentRow.id,
          weight: pkg.weight != null ? String(pkg.weight) : null,
          dimensionsJson: pkg.dimensions ?? null,
          packageType: pkg.packageType ?? null,
        })
        .returning({
          id: shipmentPackage.id,
          shipmentId: shipmentPackage.shipmentId,
          weight: shipmentPackage.weight,
          dimensionsJson: shipmentPackage.dimensionsJson,
        });
      createdPackages.push(pkgRow);
    }

    // Create shipment lines
    const createdLines = [];
    for (const line of input.lines) {
      const [lineRow] = await tx
        .insert(shipmentLine)
        .values({
          shipmentId: shipmentRow.id,
          orderLineId: line.orderLineId,
          quantity: line.quantity,
        })
        .returning({
          id: shipmentLine.id,
          shipmentId: shipmentLine.shipmentId,
          orderLineId: shipmentLine.orderLineId,
          quantity: shipmentLine.quantity,
        });
      createdLines.push(lineRow);
    }

    return {
      shipment: shipmentRow,
      packages: createdPackages,
      lines: createdLines,
    };
  });
}

// ---------------------------------------------------------------------------
// Transition shipment status
// ---------------------------------------------------------------------------

export async function transitionShipmentStatus(
  db: PostgresJsDatabase,
  shipmentId: string,
  newStatus: string,
): Promise<{ id: string; oldStatus: string; newStatus: string }> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: shipment.id, status: shipment.status })
      .from(shipment)
      .where(eq(shipment.id, shipmentId));

    if (!current) {
      throw { code: "ERR_SHIPMENT_NOT_FOUND", message: `Shipment ${shipmentId} not found` };
    }

    if (!isValidShipmentTransition(current.status, newStatus)) {
      throw {
        code: "ERR_INVALID_TRANSITION",
        message: `Invalid shipment transition: ${current.status} → ${newStatus}`,
        from: current.status,
        to: newStatus,
      };
    }

    const updateSet: Record<string, unknown> = {
      status: newStatus,
      updatedAt: new Date(),
    };

    if (newStatus === "shipped") {
      updateSet.shippedAt = new Date();
    }
    if (newStatus === "delivered") {
      updateSet.deliveredAt = new Date();
    }

    await tx.update(shipment).set(updateSet).where(eq(shipment.id, shipmentId));

    return { id: current.id, oldStatus: current.status, newStatus };
  });
}

// ---------------------------------------------------------------------------
// Buy label for a shipment
// ---------------------------------------------------------------------------

export interface BuyShipmentLabelInput {
  shipmentId: string;
  providerShipmentId: string;
  rateId: string;
}

export async function buyShipmentLabel(
  db: PostgresJsDatabase,
  input: BuyShipmentLabelInput,
  adapter: ShippingAdapter,
): Promise<{
  shipment: ShipmentRecord;
  label: BuyLabelResult;
  purchase: {
    id: string;
    shipmentId: string;
    providerLabelId: string;
    costMinor: number;
    currency: string;
    purchasedAt: Date;
  };
}> {
  // Verify shipment exists and is in a valid state
  const [current] = await db
    .select({
      id: shipment.id,
      status: shipment.status,
      orderId: shipment.orderId,
    })
    .from(shipment)
    .where(eq(shipment.id, input.shipmentId));

  if (!current) {
    throw { code: "ERR_SHIPMENT_NOT_FOUND", message: `Shipment ${input.shipmentId} not found` };
  }

  // Must be in draft or label_pending to buy a label
  if (current.status !== "draft" && current.status !== "label_pending") {
    throw {
      code: "ERR_INVALID_STATE",
      message: `Cannot buy label for shipment in ${current.status} status`,
    };
  }

  // Transition to label_pending if currently draft
  if (current.status === "draft") {
    await transitionShipmentStatus(db, input.shipmentId, "label_pending");
  }

  // Buy the label via the shipping adapter
  let labelResult: BuyLabelResult;
  try {
    labelResult = await adapter.buyLabel(input.providerShipmentId, input.rateId);
  } catch (adapterErr: unknown) {
    // Label purchase failed — shipment stays in label_pending
    const msg = adapterErr instanceof Error ? adapterErr.message : "Label purchase failed";
    throw {
      code: "ERR_LABEL_PURCHASE_FAILED",
      message: msg,
      shipmentId: input.shipmentId,
      shipmentStatus: "label_pending",
    };
  }

  // Record the purchase and update shipment in a transaction
  return db.transaction(async (tx) => {
    // Determine cost from rate (for stub, use a default)
    // The cost comes from the adapter's rate; we record the actual purchase price
    // For the stub adapter, we use the label's carrier info to estimate
    const costMinor = 599; // Default cost; real cost would come from rate lookup
    const now = new Date();

    // Create the label purchase record
    const [purchase] = await tx
      .insert(shippingLabelPurchase)
      .values({
        shipmentId: input.shipmentId,
        providerLabelId: labelResult.trackingNumber,
        costMinor,
        currency: "USD",
        purchasedAt: now,
        rawPayloadJson: labelResult,
      })
      .returning({
        id: shippingLabelPurchase.id,
        shipmentId: shippingLabelPurchase.shipmentId,
        providerLabelId: shippingLabelPurchase.providerLabelId,
        costMinor: shippingLabelPurchase.costMinor,
        currency: shippingLabelPurchase.currency,
        purchasedAt: shippingLabelPurchase.purchasedAt,
      });

    // Update shipment with label info and transition to label_purchased
    await tx
      .update(shipment)
      .set({
        status: "label_purchased",
        carrier: labelResult.carrier,
        serviceLevel: labelResult.service,
        trackingNumber: labelResult.trackingNumber,
        labelUrl: labelResult.labelUrl,
        labelPurchasedAt: now,
        updatedAt: now,
      })
      .where(eq(shipment.id, input.shipmentId));

    // Fetch the updated shipment
    const [updated] = await tx
      .select({
        id: shipment.id,
        orderId: shipment.orderId,
        shipmentNumber: shipment.shipmentNumber,
        status: shipment.status,
        carrier: shipment.carrier,
        serviceLevel: shipment.serviceLevel,
        trackingNumber: shipment.trackingNumber,
        trackingUrl: shipment.trackingUrl,
        labelUrl: shipment.labelUrl,
        createdAt: shipment.createdAt,
        updatedAt: shipment.updatedAt,
      })
      .from(shipment)
      .where(eq(shipment.id, input.shipmentId));

    return {
      shipment: updated,
      label: labelResult,
      purchase,
    };
  });
}

// ---------------------------------------------------------------------------
// Void label for a shipment
// ---------------------------------------------------------------------------

const VOIDABLE_STATUSES = ["draft", "label_pending", "label_purchased", "ready"];

export async function voidShipmentLabel(
  db: PostgresJsDatabase,
  shipmentId: string,
  adapter: ShippingAdapter,
): Promise<{
  shipment: ShipmentRecord;
  refunded: boolean;
  refundedCostMinor: number | null;
  labelCostCredited: boolean;
}> {
  // Look up the shipment
  const [current] = await db
    .select({
      id: shipment.id,
      status: shipment.status,
      orderId: shipment.orderId,
      trackingNumber: shipment.trackingNumber,
    })
    .from(shipment)
    .where(eq(shipment.id, shipmentId));

  if (!current) {
    throw { code: "ERR_SHIPMENT_NOT_FOUND", message: `Shipment ${shipmentId} not found` };
  }

  if (!VOIDABLE_STATUSES.includes(current.status)) {
    throw {
      code: "ERR_INVALID_STATE",
      message: `Cannot void label for shipment in ${current.status} status`,
    };
  }

  // If a label was purchased, void it via the adapter
  let refunded = false;
  let refundedCostMinor: number | null = null;

  if (current.status === "label_purchased" || current.status === "ready") {
    // Find the label purchase to get cost
    const purchases = await db
      .select({
        id: shippingLabelPurchase.id,
        providerLabelId: shippingLabelPurchase.providerLabelId,
        costMinor: shippingLabelPurchase.costMinor,
      })
      .from(shippingLabelPurchase)
      .where(eq(shippingLabelPurchase.shipmentId, shipmentId));

    if (purchases.length > 0) {
      // Call the adapter to void/refund the label
      const voidResult = await adapter.voidLabel(shipmentId);
      refunded = voidResult.refunded;
      if (refunded) {
        refundedCostMinor = purchases.reduce((sum, p) => sum + p.costMinor, 0);
      }
    }
  }

  // Transition to voided
  await transitionShipmentStatus(db, shipmentId, "voided");

  // Fetch the updated shipment
  const [updated] = await db
    .select({
      id: shipment.id,
      orderId: shipment.orderId,
      shipmentNumber: shipment.shipmentNumber,
      status: shipment.status,
      carrier: shipment.carrier,
      serviceLevel: shipment.serviceLevel,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      labelUrl: shipment.labelUrl,
      createdAt: shipment.createdAt,
      updatedAt: shipment.updatedAt,
    })
    .from(shipment)
    .where(eq(shipment.id, shipmentId));

  return {
    shipment: updated,
    refunded,
    refundedCostMinor,
    labelCostCredited: refunded && refundedCostMinor != null && refundedCostMinor > 0,
  };
}

// ---------------------------------------------------------------------------
// Mark shipment as shipped (only from "ready")
// ---------------------------------------------------------------------------

export async function markShipmentShipped(
  db: PostgresJsDatabase,
  shipmentId: string,
): Promise<{
  id: string;
  status: string;
  shippedAt: Date;
}> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: shipment.id, status: shipment.status })
      .from(shipment)
      .where(eq(shipment.id, shipmentId));

    if (!current) {
      throw { code: "ERR_SHIPMENT_NOT_FOUND", message: `Shipment ${shipmentId} not found` };
    }

    if (current.status !== "ready") {
      throw {
        code: "ERR_INVALID_TRANSITION",
        message: `Cannot mark shipment as shipped from ${current.status} status (must be ready)`,
        from: current.status,
        to: "shipped",
      };
    }

    const now = new Date();
    await tx
      .update(shipment)
      .set({
        status: "shipped",
        shippedAt: now,
        updatedAt: now,
      })
      .where(eq(shipment.id, shipmentId));

    return { id: current.id, status: "shipped", shippedAt: now };
  });
}

// ---------------------------------------------------------------------------
// Find shipment by ID
// ---------------------------------------------------------------------------

export async function findShipmentById(
  db: PostgresJsDatabase,
  shipmentId: string,
): Promise<ShipmentRecord | null> {
  const [row] = await db
    .select({
      id: shipment.id,
      orderId: shipment.orderId,
      shipmentNumber: shipment.shipmentNumber,
      status: shipment.status,
      carrier: shipment.carrier,
      serviceLevel: shipment.serviceLevel,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      labelUrl: shipment.labelUrl,
      createdAt: shipment.createdAt,
      updatedAt: shipment.updatedAt,
    })
    .from(shipment)
    .where(eq(shipment.id, shipmentId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Find shipments by order ID
// ---------------------------------------------------------------------------

export async function findShipmentsByOrderId(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<ShipmentRecord[]> {
  return db
    .select({
      id: shipment.id,
      orderId: shipment.orderId,
      shipmentNumber: shipment.shipmentNumber,
      status: shipment.status,
      carrier: shipment.carrier,
      serviceLevel: shipment.serviceLevel,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      labelUrl: shipment.labelUrl,
      createdAt: shipment.createdAt,
      updatedAt: shipment.updatedAt,
    })
    .from(shipment)
    .where(eq(shipment.orderId, orderId));
}

// ---------------------------------------------------------------------------
// Find shipment lines by shipment ID
// ---------------------------------------------------------------------------

export async function findShipmentLinesByShipmentId(
  db: PostgresJsDatabase,
  shipmentId: string,
): Promise<{ id: string; shipmentId: string; orderLineId: string; quantity: number }[]> {
  return db
    .select({
      id: shipmentLine.id,
      shipmentId: shipmentLine.shipmentId,
      orderLineId: shipmentLine.orderLineId,
      quantity: shipmentLine.quantity,
    })
    .from(shipmentLine)
    .where(eq(shipmentLine.shipmentId, shipmentId));
}

// ---------------------------------------------------------------------------
// Find shipment packages by shipment ID
// ---------------------------------------------------------------------------

export async function findShipmentPackagesByShipmentId(
  db: PostgresJsDatabase,
  shipmentId: string,
): Promise<{ id: string; shipmentId: string; weight: string | null; dimensionsJson: unknown }[]> {
  return db
    .select({
      id: shipmentPackage.id,
      shipmentId: shipmentPackage.shipmentId,
      weight: shipmentPackage.weight,
      dimensionsJson: shipmentPackage.dimensionsJson,
    })
    .from(shipmentPackage)
    .where(eq(shipmentPackage.shipmentId, shipmentId));
}

// ---------------------------------------------------------------------------
// Find label purchases by shipment ID
// ---------------------------------------------------------------------------

export async function findLabelPurchasesByShipmentId(
  db: PostgresJsDatabase,
  shipmentId: string,
): Promise<
  {
    id: string;
    shipmentId: string;
    providerLabelId: string;
    costMinor: number;
    currency: string;
    purchasedAt: Date;
  }[]
> {
  return db
    .select({
      id: shippingLabelPurchase.id,
      shipmentId: shippingLabelPurchase.shipmentId,
      providerLabelId: shippingLabelPurchase.providerLabelId,
      costMinor: shippingLabelPurchase.costMinor,
      currency: shippingLabelPurchase.currency,
      purchasedAt: shippingLabelPurchase.purchasedAt,
    })
    .from(shippingLabelPurchase)
    .where(eq(shippingLabelPurchase.shipmentId, shipmentId));
}

// ---------------------------------------------------------------------------
// Find shipment by tracking number (for webhook routing)
// ---------------------------------------------------------------------------

export async function findShipmentByTrackingNumber(
  db: PostgresJsDatabase,
  trackingNumber: string,
): Promise<ShipmentRecord | null> {
  const [row] = await db
    .select({
      id: shipment.id,
      orderId: shipment.orderId,
      shipmentNumber: shipment.shipmentNumber,
      status: shipment.status,
      carrier: shipment.carrier,
      serviceLevel: shipment.serviceLevel,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      labelUrl: shipment.labelUrl,
      createdAt: shipment.createdAt,
      updatedAt: shipment.updatedAt,
    })
    .from(shipment)
    .where(eq(shipment.trackingNumber, trackingNumber));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Shipment event idempotency check
// ---------------------------------------------------------------------------

export async function hasShipmentEventBeenProcessed(
  db: PostgresJsDatabase,
  providerEventId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ id: shipmentEvent.id })
    .from(shipmentEvent)
    .where(eq(shipmentEvent.providerEventId, providerEventId));
  return !!existing;
}

// ---------------------------------------------------------------------------
// Store shipment event (immutable audit record)
// ---------------------------------------------------------------------------

export interface StoreShipmentEventInput {
  shipmentId: string;
  providerEventId: string;
  status: string;
  description: string | null;
  occurredAt: Date;
  rawPayloadJson: unknown;
}

export async function storeShipmentEvent(
  db: PostgresJsDatabase,
  input: StoreShipmentEventInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(shipmentEvent)
    .values({
      shipmentId: input.shipmentId,
      providerEventId: input.providerEventId,
      status: input.status,
      description: input.description,
      occurredAt: input.occurredAt,
      rawPayloadJson: input.rawPayloadJson,
    })
    .returning({ id: shipmentEvent.id });

  // Auto-collect evidence: tracking_history for every tracking event
  // Look up the shipment to get orderId for evidence linking
  const [shipmentRow] = await db
    .select({ orderId: shipment.orderId })
    .from(shipment)
    .where(eq(shipment.id, input.shipmentId));

  if (shipmentRow) {
    try {
      await createEvidenceRecord(db, {
        orderId: shipmentRow.orderId,
        shipmentId: input.shipmentId,
        type: "tracking_history",
        textContent: JSON.stringify({
          providerEventId: input.providerEventId,
          status: input.status,
          description: input.description,
          occurredAt: input.occurredAt,
        }),
        metadataJson: { shipmentEventId: row.id },
      });
    } catch {
      // Non-fatal: evidence collection should not block event storage
    }

    // Auto-collect evidence: delivery_proof when status is "delivered"
    if (input.status === "delivered") {
      try {
        await createEvidenceRecord(db, {
          orderId: shipmentRow.orderId,
          shipmentId: input.shipmentId,
          type: "delivery_proof",
          textContent: JSON.stringify({
            deliveredAt: input.occurredAt,
            providerEventId: input.providerEventId,
            description: input.description,
          }),
          metadataJson: { shipmentEventId: row.id },
        });
      } catch {
        // Non-fatal
      }
    }
  }

  return row;
}

// ---------------------------------------------------------------------------
// Find shipment events by shipment ID
// ---------------------------------------------------------------------------

export async function findShipmentEventsByShipmentId(
  db: PostgresJsDatabase,
  shipmentId: string,
): Promise<
  {
    id: string;
    shipmentId: string;
    providerEventId: string | null;
    status: string;
    description: string | null;
    occurredAt: Date;
  }[]
> {
  return db
    .select({
      id: shipmentEvent.id,
      shipmentId: shipmentEvent.shipmentId,
      providerEventId: shipmentEvent.providerEventId,
      status: shipmentEvent.status,
      description: shipmentEvent.description,
      occurredAt: shipmentEvent.occurredAt,
    })
    .from(shipmentEvent)
    .where(eq(shipmentEvent.shipmentId, shipmentId));
}

// ---------------------------------------------------------------------------
// EasyPost status → shipment status mapping
// ---------------------------------------------------------------------------

/**
 * Map EasyPost tracker status to our shipment status.
 * Returns null if the status should not trigger a transition.
 */
export function mapEasyPostStatusToShipmentStatus(easypostStatus: string): string | null {
  switch (easypostStatus) {
    case "in_transit":
      return "in_transit";
    case "out_for_delivery":
      return "in_transit"; // shipment doesn't have out_for_delivery
    case "delivered":
      return "delivered";
    case "return_to_sender":
      return "returned";
    case "failure":
    case "error":
      return "exception";
    default:
      return null; // pre_transit, unknown, etc.
  }
}

/**
 * Map EasyPost tracker status to our order shipping_status.
 * Returns null if the status should not trigger a transition.
 */
export function mapEasyPostStatusToOrderShippingStatus(easypostStatus: string): string | null {
  switch (easypostStatus) {
    case "in_transit":
      return "in_transit";
    case "out_for_delivery":
      return "out_for_delivery";
    case "delivered":
      return "delivered";
    case "return_to_sender":
      return "returned";
    case "failure":
    case "error":
      return "delivery_exception";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Handle tracking event: update shipment + order status
// ---------------------------------------------------------------------------

function isTransitionError(err: unknown): boolean {
  return (err as { code?: string })?.code === "ERR_INVALID_TRANSITION";
}

export async function handleTrackingUpdate(
  db: PostgresJsDatabase,
  shipmentRecord: ShipmentRecord,
  easypostStatus: string,
  adminAlertService?: AdminAlertService,
): Promise<{ shipmentTransitioned: boolean; orderTransitioned: boolean; orderCompleted: boolean }> {
  let shipmentTransitioned = false;
  let orderTransitioned = false;

  // 1. Update shipment status
  const newShipmentStatus = mapEasyPostStatusToShipmentStatus(easypostStatus);
  if (newShipmentStatus && newShipmentStatus !== shipmentRecord.status) {
    try {
      await transitionShipmentStatus(db, shipmentRecord.id, newShipmentStatus);
      shipmentTransitioned = true;
    } catch (err: unknown) {
      if (!isTransitionError(err)) throw err;
      // Already in target state or invalid transition — skip
    }
  }

  // 1b. Fire admin alert on delivery exception
  if (newShipmentStatus === "exception" && shipmentTransitioned && adminAlertService) {
    adminAlertService.queue({
      type: "delivery_exception",
      orderId: shipmentRecord.orderId,
      message: `Delivery exception for shipment ${shipmentRecord.shipmentNumber} (tracking: ${shipmentRecord.trackingNumber ?? "unknown"})`,
      details: {
        shipmentId: shipmentRecord.id,
        shipmentNumber: shipmentRecord.shipmentNumber,
        trackingNumber: shipmentRecord.trackingNumber,
        easypostStatus,
      },
    });
  }

  // 2. Propagate to order.shipping_status (non-delivered events use direct transition)
  const newOrderShippingStatus = mapEasyPostStatusToOrderShippingStatus(easypostStatus);
  if (newOrderShippingStatus && newOrderShippingStatus !== "delivered") {
    try {
      await transitionOrderStatus(db, {
        orderId: shipmentRecord.orderId,
        statusType: "shipping_status",
        newValue: newOrderShippingStatus,
        reason: `Tracking update: ${easypostStatus} (webhook: tracker.updated)`,
      });
      orderTransitioned = true;
    } catch (err: unknown) {
      if (!isTransitionError(err)) throw err;
      // Already in target state or invalid transition — skip
    }
  }

  // 3. For delivered: use aggregate check (all non-voided shipments must be delivered)
  if (newOrderShippingStatus === "delivered") {
    const delivered = await propagateOrderDeliveredStatus(db, shipmentRecord.orderId);
    if (delivered) orderTransitioned = true;
  }

  // 4. Check if fulfillment status should be updated
  await propagateOrderFulfillmentStatus(db, shipmentRecord.orderId);

  // 5. Check if order can be auto-completed
  const orderCompleted = await tryAutoCompleteOrder(db, shipmentRecord.orderId);

  return { shipmentTransitioned, orderTransitioned, orderCompleted };
}

// ---------------------------------------------------------------------------
// Refresh tracking: poll adapter for latest events, store new ones
// ---------------------------------------------------------------------------

export async function refreshShipmentTracking(
  db: PostgresJsDatabase,
  shipmentId: string,
  adapter: ShippingAdapter,
  adminAlertService?: AdminAlertService,
): Promise<{
  shipment: ShipmentRecord;
  tracking: TrackingResult;
  newEventsStored: number;
  shipmentTransitioned: boolean;
  orderTransitioned: boolean;
}> {
  // 1. Find shipment
  const shipmentRecord = await findShipmentById(db, shipmentId);
  if (!shipmentRecord) {
    throw { code: "ERR_SHIPMENT_NOT_FOUND", message: `Shipment ${shipmentId} not found` };
  }

  // 2. Must have a label purchased (tracking requires a trackerId)
  if (
    shipmentRecord.status === "draft" ||
    shipmentRecord.status === "label_pending" ||
    shipmentRecord.status === "voided"
  ) {
    throw {
      code: "ERR_INVALID_STATE",
      message: `Cannot refresh tracking for shipment in ${shipmentRecord.status} status`,
    };
  }

  // 3. Get trackerId from label purchase rawPayloadJson
  const purchases = await db
    .select({
      id: shippingLabelPurchase.id,
      rawPayloadJson: shippingLabelPurchase.rawPayloadJson,
    })
    .from(shippingLabelPurchase)
    .where(eq(shippingLabelPurchase.shipmentId, shipmentId));

  if (purchases.length === 0) {
    throw {
      code: "ERR_NO_LABEL",
      message: `No label purchase found for shipment ${shipmentId}`,
    };
  }

  const rawPayload = purchases[0].rawPayloadJson as Record<string, unknown> | null;
  const trackerId = rawPayload?.trackerId as string | undefined;
  if (!trackerId) {
    throw {
      code: "ERR_NO_TRACKER",
      message: `No tracker ID found for shipment ${shipmentId}`,
    };
  }

  // 4. Fetch latest tracking from adapter
  const tracking = await adapter.getTracking(trackerId);

  // 5. Get existing events to avoid duplicates
  const existingEvents = await findShipmentEventsByShipmentId(db, shipmentId);
  const existingEventIds = new Set(
    existingEvents.filter((e) => e.providerEventId != null).map((e) => e.providerEventId),
  );

  // 6. Store new events
  let newEventsStored = 0;
  for (const event of tracking.events) {
    // Generate a deterministic provider event ID from the event data
    const providerEventId = `refresh-${event.occurredAt}-${event.status}`;

    if (existingEventIds.has(providerEventId)) {
      continue;
    }

    // Also check if we already have this event by checking for duplicates
    const alreadyProcessed = await hasShipmentEventBeenProcessed(db, providerEventId);
    if (alreadyProcessed) {
      continue;
    }

    await storeShipmentEvent(db, {
      shipmentId,
      providerEventId,
      status: event.status,
      description: event.description,
      occurredAt: new Date(event.occurredAt),
      rawPayloadJson: event,
    });
    newEventsStored++;
  }

  // 7. Update shipment + order status if changed
  let shipmentTransitioned = false;
  let orderTransitioned = false;

  if (tracking.status && tracking.status !== "unknown") {
    const result = await handleTrackingUpdate(
      db,
      shipmentRecord,
      tracking.status,
      adminAlertService,
    );
    shipmentTransitioned = result.shipmentTransitioned;
    orderTransitioned = result.orderTransitioned;
  }

  // 8. Re-fetch the shipment to get updated state
  const updatedShipment = await findShipmentById(db, shipmentId);
  if (!updatedShipment) {
    throw {
      code: "ERR_SHIPMENT_NOT_FOUND",
      message: `Shipment ${shipmentId} not found after update`,
    };
  }

  return {
    shipment: updatedShipment,
    tracking,
    newEventsStored,
    shipmentTransitioned,
    orderTransitioned,
  };
}

// ---------------------------------------------------------------------------
// Fulfillment → shipping status propagation (T060)
// ---------------------------------------------------------------------------

/** Shipped-or-later statuses that indicate an order line is fulfilled */
const SHIPPED_OR_LATER = ["shipped", "in_transit", "delivered", "returned"];

/**
 * Check if all order lines are covered by shipment_lines in shipped/delivered
 * shipments. If so, transition order.fulfillment_status → fulfilled.
 */
export async function propagateOrderFulfillmentStatus(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<boolean> {
  // 1. Get all order lines for this order
  const orderLines = await db
    .select({ id: orderLine.id, quantity: orderLine.quantity })
    .from(orderLine)
    .where(eq(orderLine.orderId, orderId));

  if (orderLines.length === 0) return false;

  // 2. Get all shipments for this order with their statuses
  const orderShipments = await db
    .select({ id: shipment.id, status: shipment.status })
    .from(shipment)
    .where(eq(shipment.orderId, orderId));

  const qualifyingShipmentIds = new Set(
    orderShipments.filter((s) => SHIPPED_OR_LATER.includes(s.status)).map((s) => s.id),
  );

  if (qualifyingShipmentIds.size === 0) return false;

  // 3. For each order line, check if total shipped quantity covers the ordered quantity
  for (const ol of orderLines) {
    const slRows = await db
      .select({ quantity: shipmentLine.quantity, shipmentId: shipmentLine.shipmentId })
      .from(shipmentLine)
      .where(eq(shipmentLine.orderLineId, ol.id));

    const shippedQty = slRows
      .filter((sl) => qualifyingShipmentIds.has(sl.shipmentId))
      .reduce((sum, sl) => sum + sl.quantity, 0);

    if (shippedQty < ol.quantity) return false;
  }

  // 4. All order lines fully covered — transition to fulfilled
  try {
    await transitionOrderStatus(db, {
      orderId,
      statusType: "fulfillment_status",
      newValue: "fulfilled",
      reason: "All order lines shipped/delivered",
    });
    return true;
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
    return false;
  }
}

/**
 * Check if all non-voided shipments for an order are delivered.
 * If so, transition order.shipping_status → delivered.
 */
export async function propagateOrderDeliveredStatus(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<boolean> {
  const orderShipments = await db
    .select({ id: shipment.id, status: shipment.status })
    .from(shipment)
    .where(eq(shipment.orderId, orderId));

  const activeShipments = orderShipments.filter((s) => s.status !== "voided");
  if (activeShipments.length === 0) return false;

  const allDelivered = activeShipments.every((s) => s.status === "delivered");
  if (!allDelivered) return false;

  try {
    await transitionOrderStatus(db, {
      orderId,
      statusType: "shipping_status",
      newValue: "delivered",
      reason: "All shipments delivered",
    });
    return true;
  } catch (err: unknown) {
    if (!isTransitionError(err)) throw err;
    return false;
  }
}

/**
 * Auto-complete an order when fulfillment_status=fulfilled AND
 * shipping_status=delivered AND status=confirmed.
 */
export async function tryAutoCompleteOrder(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<boolean> {
  const orderRow = await findOrderById(db, orderId);
  if (!orderRow) return false;

  if (
    orderRow.fulfillmentStatus === "fulfilled" &&
    orderRow.shippingStatus === "delivered" &&
    orderRow.status === "confirmed"
  ) {
    try {
      await transitionOrderStatus(db, {
        orderId,
        statusType: "status",
        newValue: "completed",
        reason: "Auto-completed: all items fulfilled and delivered",
      });
      // Track per-design sales for contributor royalties
      try {
        await processOrderCompletionSales(db, orderId);
      } catch {
        // Non-fatal: sales tracking failure should not block order completion
      }
      return true;
    } catch (err: unknown) {
      if (!isTransitionError(err)) throw err;
      return false;
    }
  }
  return false;
}
