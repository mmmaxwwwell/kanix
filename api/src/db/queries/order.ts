import { eq, and, isNull, desc, count, or, ilike } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { order } from "../schema/order.js";

/**
 * Links all guest orders (customer_id IS NULL) with the given email
 * to the specified customer ID. Returns the number of updated rows.
 */
export async function linkGuestOrdersByEmail(
  db: PostgresJsDatabase,
  email: string,
  customerId: string,
): Promise<number> {
  const rows = await db
    .update(order)
    .set({ customerId, updatedAt: new Date() })
    .where(and(eq(order.email, email), isNull(order.customerId)))
    .returning({ id: order.id });

  return rows.length;
}

/**
 * Finds all orders belonging to a customer.
 */
export async function findOrdersByCustomerId(
  db: PostgresJsDatabase,
  customerId: string,
): Promise<
  {
    id: string;
    orderNumber: string;
    email: string;
    status: string;
    totalMinor: number;
    createdAt: Date;
  }[]
> {
  return db
    .select({
      id: order.id,
      orderNumber: order.orderNumber,
      email: order.email,
      status: order.status,
      totalMinor: order.totalMinor,
      createdAt: order.createdAt,
    })
    .from(order)
    .where(eq(order.customerId, customerId));
}

/**
 * Lists orders in the system for admin use, with pagination.
 * Defaults to the first 100 orders sorted by most-recent first.
 */
export async function listAllOrders(
  db: PostgresJsDatabase,
  options: { limit?: number; offset?: number; search?: string } = {},
): Promise<{
  orders: {
    id: string;
    orderNumber: string;
    email: string;
    status: string;
    paymentStatus: string;
    fulfillmentStatus: string;
    totalMinor: number;
    placedAt: Date | null;
    createdAt: Date;
  }[];
  total: number;
}> {
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  const searchCondition = options.search
    ? or(ilike(order.orderNumber, `%${options.search}%`), ilike(order.email, `%${options.search}%`))
    : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: order.id,
        orderNumber: order.orderNumber,
        email: order.email,
        status: order.status,
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        totalMinor: order.totalMinor,
        placedAt: order.placedAt,
        createdAt: order.createdAt,
      })
      .from(order)
      .where(searchCondition)
      .orderBy(desc(order.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(order).where(searchCondition),
  ]);

  return { orders: rows, total };
}
