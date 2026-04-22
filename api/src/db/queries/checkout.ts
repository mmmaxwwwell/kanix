import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { order, orderLine, orderStatusHistory } from "../schema/order.js";
import { payment } from "../schema/payment.js";
import { cart } from "../schema/cart.js";
import type { CartWithItems } from "./cart.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckoutAddress {
  full_name: string;
  phone?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

export interface CreateOrderInput {
  orderNumber: string;
  email: string;
  customerId?: string;
  cartWithItems: CartWithItems;
  shippingAddress: CheckoutAddress;
  billingAddress?: CheckoutAddress;
  subtotalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  stripePaymentIntentId: string;
}

export interface CheckoutOrder {
  id: string;
  orderNumber: string;
  email: string;
  status: string;
  paymentStatus: string;
  subtotalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
}

// ---------------------------------------------------------------------------
// Generate order number (KNX-000001)
// ---------------------------------------------------------------------------

export async function generateOrderNumber(db: PostgresJsDatabase): Promise<string> {
  // Extract the max numeric suffix from existing KNX-NNNNNN order numbers
  const result = await db.execute(
    sql`SELECT COALESCE(MAX(substring(order_number from 'KNX-0*([0-9]+)')::int), 0) AS max_num FROM "order" WHERE order_number ~ '^KNX-[0-9]+$'`,
  );
  const maxNum = (result[0]?.max_num as number) ?? 0;
  const next = maxNum + 1;
  return `KNX-${String(next).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Create order from checkout
// ---------------------------------------------------------------------------

export async function createCheckoutOrder(
  db: PostgresJsDatabase,
  input: CreateOrderInput,
): Promise<CheckoutOrder> {
  return db.transaction(async (tx) => {
    // 1. Create the order
    const [newOrder] = await tx
      .insert(order)
      .values({
        orderNumber: input.orderNumber,
        customerId: input.customerId ?? null,
        email: input.email,
        status: "pending_payment",
        paymentStatus: "unpaid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        currency: "USD",
        subtotalMinor: input.subtotalMinor,
        taxMinor: input.taxMinor,
        shippingMinor: input.shippingMinor,
        discountMinor: 0,
        totalMinor: input.totalMinor,
        shippingAddressSnapshotJson: input.shippingAddress,
        billingAddressSnapshotJson: input.billingAddress ?? input.shippingAddress,
        placedAt: new Date(),
      })
      .returning();

    // 2. Create order lines with snapshots
    for (const item of input.cartWithItems.items) {
      await tx.insert(orderLine).values({
        orderId: newOrder.id,
        variantId: item.variantId,
        skuSnapshot: item.sku,
        titleSnapshot: item.variantTitle,
        optionValuesSnapshotJson: {},
        quantity: item.quantity,
        unitPriceMinor: item.currentPriceMinor,
        totalMinor: item.currentPriceMinor * item.quantity,
      });
    }

    // 3. Create order status history entry (draft → pending_payment)
    await tx.insert(orderStatusHistory).values({
      orderId: newOrder.id,
      statusType: "status",
      oldValue: "draft",
      newValue: "pending_payment",
      reason: "Checkout completed",
    });

    // 4. Create payment record
    await tx.insert(payment).values({
      orderId: newOrder.id,
      provider: "stripe",
      providerPaymentIntentId: input.stripePaymentIntentId,
      status: "pending",
      amountMinor: input.totalMinor,
      currency: "USD",
    });

    // 5. Mark cart as converted (checkout complete)
    await tx
      .update(cart)
      .set({ status: "converted", updatedAt: new Date() })
      .where(eq(cart.id, input.cartWithItems.id));

    return {
      id: newOrder.id,
      orderNumber: newOrder.orderNumber,
      email: newOrder.email,
      status: newOrder.status,
      paymentStatus: newOrder.paymentStatus,
      subtotalMinor: newOrder.subtotalMinor,
      taxMinor: newOrder.taxMinor,
      shippingMinor: newOrder.shippingMinor,
      totalMinor: newOrder.totalMinor,
    };
  });
}
