import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order } from "./db/schema/order.js";
import {
  supportTicket,
  supportTicketMessage,
  supportTicketStatusHistory,
} from "./db/schema/support.js";
import { eq } from "drizzle-orm";
import {
  createSupportTicket,
  findTicketById,
  listSupportTickets,
  dismissDuplicate,
  mergeTicket,
} from "./db/queries/support-ticket.js";
import { customer } from "./db/schema/customer.js";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("duplicate ticket detection (T061a)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  const createdTicketIds: string[] = [];
  const createdOrderIds: string[] = [];
  let testCustomerId: string;
  let testOrderId: string;

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create a test customer
    const [cust] = await db
      .insert(customer)
      .values({
        email: `t061a-customer-${ts}@test.kanix.dev`,
        authSubject: `auth-t061a-${ts}`,
      })
      .returning();
    testCustomerId = cust.id;

    // Create a test order
    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T061A-${ts}`,
        email: `t061a-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 5000,
        taxMinor: 250,
        shippingMinor: 599,
        totalMinor: 5849,
        placedAt: new Date(),
      })
      .returning();
    testOrderId = ord.id;
    createdOrderIds.push(ord.id);
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      // Clear self-referencing FKs before deleting tickets
      for (const ticketId of createdTicketIds) {
        await db
          .update(supportTicket)
          .set({ linkedTicketId: null, mergedIntoTicketId: null })
          .where(eq(supportTicket.id, ticketId));
      }
      for (const ticketId of createdTicketIds) {
        await db
          .delete(supportTicketStatusHistory)
          .where(eq(supportTicketStatusHistory.ticketId, ticketId));
        await db.delete(supportTicketMessage).where(eq(supportTicketMessage.ticketId, ticketId));
        await db.delete(supportTicket).where(eq(supportTicket.id, ticketId));
      }
      for (const orderId of createdOrderIds) {
        await db.delete(order).where(eq(order.id, orderId));
      }
      await db.delete(customer).where(eq(customer.id, testCustomerId));
      await dbConn.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Duplicate detection — same order + same category within 24h
  // ---------------------------------------------------------------------------

  it("flags second ticket for same order + same category within 24h as potential_duplicate", async () => {
    const db = dbConn.db;

    // First ticket — should NOT be flagged
    const ticket1 = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: testOrderId,
      subject: "Where is my order?",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(ticket1.id);

    expect(ticket1.potentialDuplicate).toBe(false);
    expect(ticket1.linkedTicketId).toBeNull();
    expect(ticket1.status).toBe("open");
    expect(ticket1.category).toBe("shipping_issue");
    expect(ticket1.orderId).toBe(testOrderId);
    expect(ticket1.customerId).toBe(testCustomerId);

    // Second ticket for same order + same category — should be flagged
    const ticket2 = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: testOrderId,
      subject: "Still waiting for my order",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(ticket2.id);

    expect(ticket2.potentialDuplicate).toBe(true);
    expect(ticket2.linkedTicketId).toBe(ticket1.id);
    expect(ticket2.status).toBe("open");
    expect(ticket2.duplicateDismissed).toBe(false);
    expect(ticket2.mergedIntoTicketId).toBeNull();
  });

  it("does not flag ticket without order_id", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "General question",
      category: "product_question",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    expect(ticket.potentialDuplicate).toBe(false);
    expect(ticket.linkedTicketId).toBeNull();
    expect(ticket.orderId).toBeNull();
  });

  it("does not flag ticket for different order", async () => {
    const db = dbConn.db;

    // Create a second order
    const [ord2] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T061A2-${ts}`,
        email: `t061a-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 3000,
        taxMinor: 150,
        shippingMinor: 499,
        totalMinor: 3649,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(ord2.id);

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ord2.id,
      subject: "Different order issue",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    expect(ticket.potentialDuplicate).toBe(false);
    expect(ticket.linkedTicketId).toBeNull();
    expect(ticket.orderId).toBe(ord2.id);
  });

  it("does not flag ticket for different category on the same order", async () => {
    const db = dbConn.db;

    // Create a fresh order for isolation
    const [ord4] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T061A4-${ts}`,
        email: `t061a-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 4000,
        taxMinor: 200,
        shippingMinor: 499,
        totalMinor: 4699,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(ord4.id);

    // First ticket with category "shipping_issue"
    const ticket1 = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ord4.id,
      subject: "Shipping problem",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(ticket1.id);
    expect(ticket1.potentialDuplicate).toBe(false);

    // Second ticket for SAME order but DIFFERENT category — should NOT be flagged
    const ticket2 = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ord4.id,
      subject: "Billing question about same order",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket2.id);

    expect(ticket2.potentialDuplicate).toBe(false);
    expect(ticket2.linkedTicketId).toBeNull();
    expect(ticket2.category).toBe("billing");
  });

  it("does not flag when existing ticket is older than 24h", async () => {
    const db = dbConn.db;

    // Create a third order for isolation
    const [ord3] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T061A3-${ts}`,
        email: `t061a-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 2000,
        taxMinor: 100,
        shippingMinor: 399,
        totalMinor: 2499,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(ord3.id);

    // Insert a ticket directly with a created_at >24h ago
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const [oldTicket] = await db
      .insert(supportTicket)
      .values({
        ticketNumber: `TKT-OLD-${ts}`,
        customerId: testCustomerId,
        orderId: ord3.id,
        subject: "Old ticket",
        category: "shipping_issue",
        status: "open",
        source: "customer_app",
        createdAt: oldDate,
        updatedAt: oldDate,
      })
      .returning({ id: supportTicket.id });
    createdTicketIds.push(oldTicket.id);

    // New ticket for the same order + same category — should NOT be flagged (old ticket > 24h)
    const newTicket = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ord3.id,
      subject: "New question about same order",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(newTicket.id);

    expect(newTicket.potentialDuplicate).toBe(false);
    expect(newTicket.linkedTicketId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Admin sees duplicate flag in ticket list
  // ---------------------------------------------------------------------------

  it("admin sees potential_duplicate flag and linked ticket ID in ticket queue", async () => {
    const db = dbConn.db;
    const tickets = await listSupportTickets(db, { orderId: testOrderId });
    const duplicates = tickets.filter((t) => t.potentialDuplicate);
    expect(duplicates.length).toBeGreaterThanOrEqual(1);
    // Concrete assertion: linkedTicketId must be a valid UUID string, not just truthy
    expect(typeof duplicates[0].linkedTicketId).toBe("string");
    expect(duplicates[0].linkedTicketId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // ---------------------------------------------------------------------------
  // Admin dismiss duplicate
  // ---------------------------------------------------------------------------

  it("admin can dismiss duplicate flag", async () => {
    const db = dbConn.db;

    // Create an isolated order for this test
    const [ordDismiss] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T061A-DISMISS-${ts}`,
        email: `t061a-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 1000,
        taxMinor: 50,
        shippingMinor: 399,
        totalMinor: 1449,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(ordDismiss.id);

    // Create a pair of tickets
    const ticket1 = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ordDismiss.id,
      subject: "Dismiss test ticket 1",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket1.id);

    const ticket2 = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ordDismiss.id,
      subject: "Dismiss test ticket 2",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket2.id);

    expect(ticket2.potentialDuplicate).toBe(true);
    expect(ticket2.linkedTicketId).toBe(ticket1.id);

    // Dismiss the duplicate flag
    const dismissed = await dismissDuplicate(db, ticket2.id);
    expect(dismissed.duplicateDismissed).toBe(true);
    expect(dismissed.potentialDuplicate).toBe(true); // flag stays, but dismissed

    // Verify via findTicketById
    const refreshed = await findTicketById(db, ticket2.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.duplicateDismissed).toBe(true);
    expect(refreshed!.potentialDuplicate).toBe(true);
    expect(refreshed!.linkedTicketId).toBe(ticket1.id);
  });

  it("rejects dismiss on non-duplicate ticket", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Not a duplicate",
      category: "product_question",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    await expect(dismissDuplicate(db, ticket.id)).rejects.toMatchObject({
      code: "ERR_NOT_DUPLICATE",
    });
  });

  // ---------------------------------------------------------------------------
  // Admin merge tickets
  // ---------------------------------------------------------------------------

  it("admin can merge duplicate ticket into target", async () => {
    const db = dbConn.db;

    // Create an isolated order for this test
    const [ordMerge] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T061A-MERGE-${ts}`,
        email: `t061a-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 1500,
        taxMinor: 75,
        shippingMinor: 399,
        totalMinor: 1974,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(ordMerge.id);

    // Create target and source tickets
    const target = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ordMerge.id,
      subject: "Merge target",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(target.id);

    const source = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ordMerge.id,
      subject: "Merge source (duplicate)",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(source.id);

    expect(source.potentialDuplicate).toBe(true);
    expect(source.linkedTicketId).toBe(target.id);

    // Merge source into target
    const merged = await mergeTicket(db, source.id, target.id);
    expect(merged.status).toBe("closed");
    expect(merged.mergedIntoTicketId).toBe(target.id);
    expect(merged.id).toBe(source.id);

    // Target ticket should remain open
    const targetRefreshed = await findTicketById(db, target.id);
    expect(targetRefreshed).not.toBeNull();
    expect(targetRefreshed!.status).toBe("open");
    expect(targetRefreshed!.mergedIntoTicketId).toBeNull();
  });

  it("rejects merge with non-existent source ticket", async () => {
    const db = dbConn.db;

    await expect(
      mergeTicket(
        db,
        "00000000-0000-0000-0000-000000000099",
        "00000000-0000-0000-0000-000000000098",
      ),
    ).rejects.toMatchObject({
      code: "ERR_TICKET_NOT_FOUND",
    });
  });

  // ---------------------------------------------------------------------------
  // Admin force-create (override duplicate detection)
  // ---------------------------------------------------------------------------

  it("admin can force-create a ticket that would be a duplicate", async () => {
    const db = dbConn.db;

    // Create an isolated order for this test
    const [ordForce] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T061A-FORCE-${ts}`,
        email: `t061a-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 2500,
        taxMinor: 125,
        shippingMinor: 499,
        totalMinor: 3124,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(ordForce.id);

    // First ticket
    const ticket1 = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ordForce.id,
      subject: "Force test original",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(ticket1.id);
    expect(ticket1.potentialDuplicate).toBe(false);

    // Second ticket with forceDuplicate — should NOT be flagged as duplicate
    const ticket2 = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ordForce.id,
      subject: "Force test admin override",
      category: "shipping_issue",
      source: "admin_portal",
      forceDuplicate: true,
    });
    createdTicketIds.push(ticket2.id);

    expect(ticket2.potentialDuplicate).toBe(false);
    expect(ticket2.linkedTicketId).toBeNull();
    expect(ticket2.status).toBe("open");
    expect(ticket2.orderId).toBe(ordForce.id);
  });

  // ---------------------------------------------------------------------------
  // Edge case: without forceDuplicate it would be flagged
  // ---------------------------------------------------------------------------

  it("without forceDuplicate, same scenario IS flagged as duplicate", async () => {
    const db = dbConn.db;

    // Create an isolated order for this test
    const [ordEdge] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T061A-EDGE-${ts}`,
        email: `t061a-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 1800,
        taxMinor: 90,
        shippingMinor: 399,
        totalMinor: 2289,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(ordEdge.id);

    // First ticket
    const ticket1 = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ordEdge.id,
      subject: "Edge case original",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket1.id);

    // Second ticket WITHOUT forceDuplicate — SHOULD be flagged
    const ticket2 = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: ordEdge.id,
      subject: "Edge case follow-up",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket2.id);

    expect(ticket2.potentialDuplicate).toBe(true);
    expect(ticket2.linkedTicketId).toBe(ticket1.id);
  });
});
