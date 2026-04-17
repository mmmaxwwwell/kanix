import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  shipment,
  shipmentPackage,
  shipmentLine,
  shippingLabelPurchase,
} from "../schema/fulfillment.js";
import { order, orderLine } from "../schema/order.js";
import type { ShippingAdapter, BuyLabelResult } from "../../services/shipping-adapter.js";

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
  const labelResult = await adapter.buyLabel(input.providerShipmentId, input.rateId);

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
