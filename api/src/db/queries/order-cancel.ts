import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { inventoryReservation } from "../schema/inventory.js";
import { payment } from "../schema/payment.js";
import { refund } from "../schema/payment.js";
import { order } from "../schema/order.js";
import { transitionOrderStatus } from "./order-state-machine.js";
import { releaseReservation } from "./reservation.js";
import type { PaymentAdapter } from "../../services/payment-adapter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CancelOrderInput {
  orderId: string;
  reason: string;
  actorAdminUserId: string;
  paymentAdapter: PaymentAdapter;
}

export interface CancelOrderResult {
  success: true;
  orderId: string;
  reservationsReleased: number;
  refundInitiated: boolean;
  refundId?: string;
}

// Shipping statuses that indicate order has been physically shipped
const SHIPPED_STATUSES = [
  "shipped",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_exception",
  "returned",
];

// ---------------------------------------------------------------------------
// Cancel order
// ---------------------------------------------------------------------------

/**
 * Cancel an order:
 * 1. Validate order is not shipped
 * 2. Release active inventory reservations
 * 3. Initiate full refund if paid
 * 4. Transition order status → canceled
 */
export async function cancelOrder(
  db: PostgresJsDatabase,
  input: CancelOrderInput,
): Promise<CancelOrderResult> {
  // 1. Fetch order with all status fields
  const [currentOrder] = await db
    .select({
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      shippingStatus: order.shippingStatus,
      totalMinor: order.totalMinor,
    })
    .from(order)
    .where(eq(order.id, input.orderId));

  if (!currentOrder) {
    throw Object.assign(new Error("Order not found"), {
      code: "ERR_ORDER_NOT_FOUND",
    });
  }

  // 2. Validate not shipped
  if (SHIPPED_STATUSES.includes(currentOrder.shippingStatus)) {
    throw Object.assign(new Error("Cannot cancel an order that has already been shipped"), {
      code: "ERR_ORDER_ALREADY_SHIPPED",
    });
  }

  // 3. Validate order status allows cancellation
  if (currentOrder.status === "canceled") {
    throw Object.assign(new Error("Order is already canceled"), {
      code: "ERR_INVALID_TRANSITION",
      message: "Invalid status transition: canceled → canceled",
    });
  }

  // 4. Release active inventory reservations
  const activeReservations = await db
    .select({ id: inventoryReservation.id })
    .from(inventoryReservation)
    .where(
      and(
        eq(inventoryReservation.orderId, input.orderId),
        eq(inventoryReservation.status, "active"),
      ),
    );

  let reservationsReleased = 0;
  for (const res of activeReservations) {
    try {
      await releaseReservation(db, res.id);
      reservationsReleased++;
    } catch {
      // Already released — idempotent
    }
  }

  // 5. Initiate full refund if paid
  let refundInitiated = false;
  let refundId: string | undefined;

  if (
    currentOrder.paymentStatus === "paid" ||
    currentOrder.paymentStatus === "partially_refunded"
  ) {
    // Find the payment record for this order
    const [paymentRecord] = await db
      .select({
        id: payment.id,
        providerPaymentIntentId: payment.providerPaymentIntentId,
        amountMinor: payment.amountMinor,
      })
      .from(payment)
      .where(eq(payment.orderId, input.orderId));

    if (paymentRecord) {
      // Create refund via payment adapter
      const refundResult = await input.paymentAdapter.createRefund({
        paymentIntentId: paymentRecord.providerPaymentIntentId,
        amountMinor: paymentRecord.amountMinor,
        reason: input.reason,
      });

      // Record refund in database
      const [refundRecord] = await db
        .insert(refund)
        .values({
          orderId: input.orderId,
          paymentId: paymentRecord.id,
          providerRefundId: refundResult.id,
          amountMinor: paymentRecord.amountMinor,
          reason: input.reason,
          status: refundResult.status === "succeeded" ? "succeeded" : "pending",
          actorAdminUserId: input.actorAdminUserId,
        })
        .returning({ id: refund.id });

      refundInitiated = true;
      refundId = refundRecord.id;

      // Transition payment status to refunded
      try {
        await transitionOrderStatus(db, {
          orderId: input.orderId,
          statusType: "payment_status",
          newValue: "refunded",
          reason: `Full refund initiated on cancellation: ${input.reason}`,
          actorAdminUserId: input.actorAdminUserId,
        });
      } catch {
        // Already in target state — idempotent
      }
    }
  }

  // 6. Transition order status → canceled
  await transitionOrderStatus(db, {
    orderId: input.orderId,
    statusType: "status",
    newValue: "canceled",
    reason: input.reason,
    actorAdminUserId: input.actorAdminUserId,
  });

  return {
    success: true,
    orderId: input.orderId,
    reservationsReleased,
    refundInitiated,
    refundId,
  };
}
