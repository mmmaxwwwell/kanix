import { eq, or, sql, desc, ilike } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { customer } from "../schema/customer.js";
import { order } from "../schema/order.js";
import { supportTicket } from "../schema/support.js";

// ---------------------------------------------------------------------------
// List customers with search/filter
// ---------------------------------------------------------------------------

export interface ListCustomersInput {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface CustomerListItem {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  status: string;
  createdAt: Date;
}

const customerListColumns = {
  id: customer.id,
  email: customer.email,
  firstName: customer.firstName,
  lastName: customer.lastName,
  phone: customer.phone,
  status: customer.status,
  createdAt: customer.createdAt,
};

export async function listCustomers(
  db: PostgresJsDatabase,
  input?: ListCustomersInput,
): Promise<{ customers: CustomerListItem[]; total: number }> {
  const conditions = [];

  if (input?.search) {
    const pattern = `%${input.search}%`;
    conditions.push(
      or(
        ilike(customer.email, pattern),
        ilike(customer.firstName, pattern),
        ilike(customer.lastName, pattern),
      ),
    );
  }

  if (input?.status) {
    conditions.push(eq(customer.status, input.status));
  }

  const where = conditions.length > 0 ? sql`${sql.join(conditions, sql` AND `)}` : undefined;

  const [totalResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(customer)
    .where(where);

  const limit = input?.limit ?? 50;
  const offset = input?.offset ?? 0;

  const customers = await db
    .select(customerListColumns)
    .from(customer)
    .where(where)
    .orderBy(desc(customer.createdAt))
    .limit(limit)
    .offset(offset);

  return { customers, total: totalResult?.count ?? 0 };
}

// ---------------------------------------------------------------------------
// Customer detail with stats
// ---------------------------------------------------------------------------

export interface CustomerDetail {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  stats: {
    totalOrders: number;
    totalSpentMinor: number;
    openTickets: number;
  };
}

export async function getCustomerDetail(
  db: PostgresJsDatabase,
  customerId: string,
): Promise<CustomerDetail | null> {
  const [cust] = await db
    .select({
      id: customer.id,
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      status: customer.status,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    })
    .from(customer)
    .where(eq(customer.id, customerId));

  if (!cust) return null;

  const [orderStats] = await db
    .select({
      totalOrders: sql<number>`count(*)::int`,
      totalSpentMinor: sql<number>`coalesce(sum(${order.totalMinor}), 0)::int`,
    })
    .from(order)
    .where(eq(order.customerId, customerId));

  const [ticketStats] = await db
    .select({ openTickets: sql<number>`count(*)::int` })
    .from(supportTicket)
    .where(
      sql`${supportTicket.customerId} = ${customerId} AND ${supportTicket.status} IN ('open', 'waiting_on_customer', 'waiting_on_internal')`,
    );

  return {
    ...cust,
    stats: {
      totalOrders: orderStats?.totalOrders ?? 0,
      totalSpentMinor: orderStats?.totalSpentMinor ?? 0,
      openTickets: ticketStats?.openTickets ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Customer orders
// ---------------------------------------------------------------------------

export interface CustomerOrderItem {
  id: string;
  orderNumber: string;
  email: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  totalMinor: number;
  placedAt: Date | null;
  createdAt: Date;
}

export async function getCustomerOrders(
  db: PostgresJsDatabase,
  customerId: string,
): Promise<CustomerOrderItem[]> {
  return db
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
    .where(eq(order.customerId, customerId))
    .orderBy(desc(order.createdAt));
}

// ---------------------------------------------------------------------------
// Customer tickets
// ---------------------------------------------------------------------------

export interface CustomerTicketItem {
  id: string;
  ticketNumber: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}

export async function getCustomerTickets(
  db: PostgresJsDatabase,
  customerId: string,
): Promise<CustomerTicketItem[]> {
  return db
    .select({
      id: supportTicket.id,
      ticketNumber: supportTicket.ticketNumber,
      subject: supportTicket.subject,
      category: supportTicket.category,
      priority: supportTicket.priority,
      status: supportTicket.status,
      createdAt: supportTicket.createdAt,
      updatedAt: supportTicket.updatedAt,
      resolvedAt: supportTicket.resolvedAt,
    })
    .from(supportTicket)
    .where(eq(supportTicket.customerId, customerId))
    .orderBy(desc(supportTicket.createdAt));
}
