import { eq, and, isNull } from "drizzle-orm";
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
