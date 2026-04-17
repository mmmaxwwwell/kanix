import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { order, orderStatusHistory } from "../schema/order.js";

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

export type OrderStatusType =
  | "status"
  | "payment_status"
  | "fulfillment_status"
  | "shipping_status";

// ---------------------------------------------------------------------------
// Valid values per state machine
// ---------------------------------------------------------------------------

export const ORDER_STATUSES = [
  "draft",
  "pending_payment",
  "confirmed",
  "completed",
  "canceled",
  "closed",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = [
  "unpaid",
  "processing",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
  "disputed",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const FULFILLMENT_STATUSES = [
  "unfulfilled",
  "queued",
  "picking",
  "packing",
  "ready_to_ship",
  "partially_fulfilled",
  "fulfilled",
  "canceled",
] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

export const SHIPPING_STATUSES = [
  "not_shipped",
  "label_pending",
  "label_purchased",
  "shipped",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_exception",
  "returned",
  "canceled",
] as const;
export type ShippingStatus = (typeof SHIPPING_STATUSES)[number];

// ---------------------------------------------------------------------------
// Transition maps
// ---------------------------------------------------------------------------

/** order.status transitions (6.A.1) */
export const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_payment"],
  pending_payment: ["confirmed", "canceled"],
  confirmed: ["completed", "canceled"],
  completed: ["closed"],
  canceled: [],
  closed: [],
};

/** order.payment_status transitions (6.A.2) */
export const PAYMENT_STATUS_TRANSITIONS: Record<string, string[]> = {
  unpaid: ["processing"],
  processing: ["paid", "failed"],
  paid: ["partially_refunded", "refunded", "disputed"],
  partially_refunded: ["refunded"],
  refunded: [],
  failed: [],
  disputed: ["paid", "refunded"],
};

/** order.fulfillment_status transitions (6.A.3) */
export const FULFILLMENT_STATUS_TRANSITIONS: Record<string, string[]> = {
  unfulfilled: ["queued", "canceled"],
  queued: ["picking", "partially_fulfilled", "canceled"],
  picking: ["packing", "partially_fulfilled", "canceled"],
  packing: ["ready_to_ship", "partially_fulfilled", "canceled"],
  ready_to_ship: ["fulfilled", "partially_fulfilled"],
  partially_fulfilled: ["fulfilled"],
  fulfilled: [],
  canceled: [],
};

/** order.shipping_status transitions (6.A.4) */
export const SHIPPING_STATUS_TRANSITIONS: Record<string, string[]> = {
  not_shipped: ["label_pending", "canceled"],
  label_pending: ["label_purchased", "canceled"],
  label_purchased: ["shipped", "canceled"],
  shipped: ["in_transit"],
  in_transit: ["out_for_delivery", "delivered", "delivery_exception"],
  out_for_delivery: ["delivered", "delivery_exception"],
  delivered: ["returned"],
  delivery_exception: ["returned"],
  returned: [],
  canceled: [],
};

/** Map from status_type to the corresponding transition map */
const TRANSITION_MAPS: Record<OrderStatusType, Record<string, string[]>> = {
  status: STATUS_TRANSITIONS,
  payment_status: PAYMENT_STATUS_TRANSITIONS,
  fulfillment_status: FULFILLMENT_STATUS_TRANSITIONS,
  shipping_status: SHIPPING_STATUS_TRANSITIONS,
};

/** Map from status_type to the corresponding field name on the select result */
const STATUS_COLUMNS: Record<
  OrderStatusType,
  "status" | "paymentStatus" | "fulfillmentStatus" | "shippingStatus"
> = {
  status: "status",
  payment_status: "paymentStatus",
  fulfillment_status: "fulfillmentStatus",
  shipping_status: "shippingStatus",
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check if a transition is valid for the given status type.
 */
export function isValidOrderTransition(
  statusType: OrderStatusType,
  from: string,
  to: string,
): boolean {
  const transitions = TRANSITION_MAPS[statusType];
  if (!transitions) return false;
  const allowed = transitions[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

// ---------------------------------------------------------------------------
// Transition execution
// ---------------------------------------------------------------------------

export interface TransitionInput {
  orderId: string;
  statusType: OrderStatusType;
  newValue: string;
  reason?: string;
  actorAdminUserId?: string;
}

export interface TransitionResult {
  success: true;
  orderId: string;
  statusType: OrderStatusType;
  oldValue: string;
  newValue: string;
}

/**
 * Transition an order's status, payment_status, fulfillment_status, or
 * shipping_status. Validates the transition, updates the order, and creates
 * an order_status_history entry — all within a transaction.
 *
 * Throws an object with `code: "ERR_INVALID_TRANSITION"` if the transition
 * is not allowed.
 */
export async function transitionOrderStatus(
  db: PostgresJsDatabase,
  input: TransitionInput,
): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    // 1. Fetch current order
    const [currentOrder] = await tx
      .select({
        id: order.id,
        status: order.status,
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        shippingStatus: order.shippingStatus,
      })
      .from(order)
      .where(eq(order.id, input.orderId));

    if (!currentOrder) {
      throw { code: "ERR_ORDER_NOT_FOUND", message: `Order ${input.orderId} not found` };
    }

    // 2. Get current value for the status type
    const columnKey = STATUS_COLUMNS[input.statusType];
    const oldValue = currentOrder[columnKey] as string;

    // 3. Validate the transition
    if (!isValidOrderTransition(input.statusType, oldValue, input.newValue)) {
      throw {
        code: "ERR_INVALID_TRANSITION",
        message: `Invalid ${input.statusType} transition: ${oldValue} → ${input.newValue}`,
        statusType: input.statusType,
        from: oldValue,
        to: input.newValue,
      };
    }

    // 4. Build the update set
    const updateSet: Record<string, unknown> = { updatedAt: new Date() };
    // Use the actual DB column name (snake_case for compound names)
    if (input.statusType === "status") {
      updateSet.status = input.newValue;
    } else if (input.statusType === "payment_status") {
      updateSet.paymentStatus = input.newValue;
    } else if (input.statusType === "fulfillment_status") {
      updateSet.fulfillmentStatus = input.newValue;
    } else if (input.statusType === "shipping_status") {
      updateSet.shippingStatus = input.newValue;
    }

    // 5. Update the order
    await tx.update(order).set(updateSet).where(eq(order.id, input.orderId));

    // 6. Create history entry
    await tx.insert(orderStatusHistory).values({
      orderId: input.orderId,
      statusType: input.statusType,
      oldValue,
      newValue: input.newValue,
      reason: input.reason ?? null,
      actorAdminUserId: input.actorAdminUserId ?? null,
    });

    return {
      success: true as const,
      orderId: input.orderId,
      statusType: input.statusType,
      oldValue,
      newValue: input.newValue,
    };
  });
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Find an order by ID with all four status fields.
 */
export async function findOrderById(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<{
  id: string;
  orderNumber: string;
  email: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  shippingStatus: string;
  totalMinor: number;
} | null> {
  const [row] = await db
    .select({
      id: order.id,
      orderNumber: order.orderNumber,
      email: order.email,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      shippingStatus: order.shippingStatus,
      totalMinor: order.totalMinor,
    })
    .from(order)
    .where(eq(order.id, orderId));

  return row ?? null;
}

/**
 * Find order status history entries for an order.
 */
export async function findOrderStatusHistory(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<
  {
    id: string;
    statusType: string;
    oldValue: string;
    newValue: string;
    reason: string | null;
    actorAdminUserId: string | null;
    createdAt: Date;
  }[]
> {
  return db
    .select({
      id: orderStatusHistory.id,
      statusType: orderStatusHistory.statusType,
      oldValue: orderStatusHistory.oldValue,
      newValue: orderStatusHistory.newValue,
      reason: orderStatusHistory.reason,
      actorAdminUserId: orderStatusHistory.actorAdminUserId,
      createdAt: orderStatusHistory.createdAt,
    })
    .from(orderStatusHistory)
    .where(eq(orderStatusHistory.orderId, orderId));
}
