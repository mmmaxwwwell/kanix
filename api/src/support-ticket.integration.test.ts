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
  listTicketsByCustomerId,
  transitionTicketStatus,
  createTicketMessage,
  listTicketMessages,
  findTicketStatusHistory,
  isValidTicketTransition,
} from "./db/queries/support-ticket.js";
import { customer } from "./db/schema/customer.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("support ticket integration (T061)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  const createdTicketIds: string[] = [];
  const createdOrderIds: string[] = [];
  let testCustomerId: string;
  let testOrderId: string;

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

    // Create a test customer
    const [cust] = await db
      .insert(customer)
      .values({
        email: `t061-customer-${ts}@test.kanix.dev`,
        authSubject: `auth-t061-${ts}`,
      })
      .returning();
    testCustomerId = cust.id;

    // Create a test order (for linking)
    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T061-${ts}`,
        email: `t061-customer-${ts}@test.kanix.dev`,
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
      // Clean up in reverse dependency order
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
  // State machine validation (pure logic)
  // ---------------------------------------------------------------------------

  it("validates correct transitions per 6.C", () => {
    expect(isValidTicketTransition("open", "waiting_on_customer")).toBe(true);
    expect(isValidTicketTransition("open", "waiting_on_internal")).toBe(true);
    expect(isValidTicketTransition("open", "resolved")).toBe(true);
    expect(isValidTicketTransition("open", "spam")).toBe(true);
    expect(isValidTicketTransition("waiting_on_customer", "open")).toBe(true);
    expect(isValidTicketTransition("waiting_on_internal", "open")).toBe(true);
    expect(isValidTicketTransition("resolved", "closed")).toBe(true);
    expect(isValidTicketTransition("resolved", "open")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(isValidTicketTransition("open", "closed")).toBe(false);
    expect(isValidTicketTransition("closed", "open")).toBe(false);
    expect(isValidTicketTransition("spam", "open")).toBe(false);
    expect(isValidTicketTransition("waiting_on_customer", "resolved")).toBe(false);
    expect(isValidTicketTransition("waiting_on_internal", "resolved")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Create ticket
  // ---------------------------------------------------------------------------

  it("creates a support ticket linked to customer and order", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: testOrderId,
      subject: "My order has not arrived",
      category: "shipping_issue",
      priority: "high",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    expect(ticket.ticketNumber).toMatch(/^TKT-/);
    expect(ticket.customerId).toBe(testCustomerId);
    expect(ticket.orderId).toBe(testOrderId);
    expect(ticket.status).toBe("open");
    expect(ticket.priority).toBe("high");
    expect(ticket.category).toBe("shipping_issue");
    expect(ticket.source).toBe("customer_app");
    expect(ticket.resolvedAt).toBeNull();
  });

  it("creates a ticket with default normal priority", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "General question",
      category: "product_question",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    expect(ticket.priority).toBe("normal");
    expect(ticket.orderId).toBeNull();
    expect(ticket.shipmentId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Find and list
  // ---------------------------------------------------------------------------

  it("finds a ticket by ID", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Findable ticket",
      category: "billing",
      source: "admin_created",
    });
    createdTicketIds.push(ticket.id);

    const found = await findTicketById(db, ticket.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(ticket.id);
    expect(found?.subject).toBe("Findable ticket");
  });

  it("returns null for non-existent ticket", async () => {
    const db = dbConn.db;
    const found = await findTicketById(db, "00000000-0000-0000-0000-000000000099");
    expect(found).toBeNull();
  });

  it("lists tickets with status filter", async () => {
    const db = dbConn.db;
    const tickets = await listSupportTickets(db, { status: "open" });
    expect(tickets.length).toBeGreaterThanOrEqual(1);
    for (const t of tickets) {
      expect(t.status).toBe("open");
    }
  });

  it("lists tickets by customer ID", async () => {
    const db = dbConn.db;
    const tickets = await listTicketsByCustomerId(db, testCustomerId);
    expect(tickets.length).toBeGreaterThanOrEqual(1);
    for (const t of tickets) {
      expect(t.customerId).toBe(testCustomerId);
    }
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle: customer creates → admin replies → internal note
  //   (not visible to customer) → resolve → close
  // ---------------------------------------------------------------------------

  it("full ticket lifecycle: create → reply → internal note → resolve → close", async () => {
    const db = dbConn.db;
    const adminUserId = "00000000-0000-0000-0000-000000000001";

    // Step 1: Customer creates ticket
    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: testOrderId,
      subject: "Order damaged on arrival",
      category: "shipping_issue",
      priority: "high",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);
    expect(ticket.status).toBe("open");

    // Step 2: Customer adds initial message
    const customerMsg = await createTicketMessage(db, {
      ticketId: ticket.id,
      authorType: "customer",
      customerId: testCustomerId,
      body: "The package was crushed and the item inside is broken.",
    });
    expect(customerMsg.authorType).toBe("customer");
    expect(customerMsg.isInternalNote).toBe(false);

    // Step 3: Admin replies (customer-visible)
    const adminReply = await createTicketMessage(db, {
      ticketId: ticket.id,
      authorType: "admin",
      adminUserId,
      body: "I'm sorry to hear that. We'll send a replacement right away.",
    });
    expect(adminReply.authorType).toBe("admin");
    expect(adminReply.isInternalNote).toBe(false);

    // Step 4: Admin adds internal note (NOT visible to customer)
    const internalNote = await createTicketMessage(db, {
      ticketId: ticket.id,
      authorType: "admin",
      adminUserId,
      body: "Customer seems upset. Expedite replacement. Flagging for manager review.",
      isInternalNote: true,
    });
    expect(internalNote.isInternalNote).toBe(true);

    // Step 5: Verify customer sees only non-internal messages
    const customerMessages = await listTicketMessages(db, ticket.id, {
      includeInternalNotes: false,
    });
    expect(customerMessages).toHaveLength(2); // customer + admin reply
    expect(customerMessages.every((m) => !m.isInternalNote)).toBe(true);

    // Step 6: Admin sees all messages including internal notes
    const adminMessages = await listTicketMessages(db, ticket.id, {
      includeInternalNotes: true,
    });
    expect(adminMessages).toHaveLength(3); // customer + admin reply + internal note
    const noteMsg = adminMessages.find((m) => m.isInternalNote);
    expect(noteMsg).toBeDefined();
    expect(noteMsg?.body).toContain("Flagging for manager review");

    // Step 7: Transition to resolved
    const resolved = await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "resolved",
      reason: "Replacement shipped",
      actorAdminUserId: adminUserId,
    });
    expect(resolved.oldStatus).toBe("open");
    expect(resolved.newStatus).toBe("resolved");
    expect(resolved.resolvedAt).not.toBeNull();

    // Step 8: Transition to closed
    const closed = await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "closed",
      reason: "Resolution accepted by customer",
      actorAdminUserId: adminUserId,
    });
    expect(closed.oldStatus).toBe("resolved");
    expect(closed.newStatus).toBe("closed");

    // Step 9: Verify status history
    const history = await findTicketStatusHistory(db, ticket.id);
    expect(history).toHaveLength(2);
    // History is ordered desc by created_at
    expect(history[0].newStatus).toBe("closed");
    expect(history[1].newStatus).toBe("resolved");
  });

  // ---------------------------------------------------------------------------
  // Transition edge cases
  // ---------------------------------------------------------------------------

  it("rejects invalid transition (open → closed directly)", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Direct close attempt",
      category: "billing",
      source: "admin_created",
    });
    createdTicketIds.push(ticket.id);

    await expect(
      transitionTicketStatus(db, {
        ticketId: ticket.id,
        newStatus: "closed",
      }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
    });
  });

  it("rejects transition on non-existent ticket", async () => {
    const db = dbConn.db;

    await expect(
      transitionTicketStatus(db, {
        ticketId: "00000000-0000-0000-0000-000000000099",
        newStatus: "resolved",
      }),
    ).rejects.toMatchObject({
      code: "ERR_TICKET_NOT_FOUND",
    });
  });

  it("supports reopen: resolved → open", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Reopen test",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    // Resolve
    await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "resolved",
    });

    // Reopen
    const reopened = await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "open",
    });
    expect(reopened.oldStatus).toBe("resolved");
    expect(reopened.newStatus).toBe("open");
  });

  it("supports waiting_on_customer → open (customer reply)", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Waiting test",
      category: "product_question",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "waiting_on_customer",
    });

    const result = await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "open",
    });
    expect(result.oldStatus).toBe("waiting_on_customer");
    expect(result.newStatus).toBe("open");
  });

  // ---------------------------------------------------------------------------
  // Message edge cases
  // ---------------------------------------------------------------------------

  it("rejects message on closed ticket", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Will be closed",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    // open → resolved → closed
    await transitionTicketStatus(db, { ticketId: ticket.id, newStatus: "resolved" });
    await transitionTicketStatus(db, { ticketId: ticket.id, newStatus: "closed" });

    await expect(
      createTicketMessage(db, {
        ticketId: ticket.id,
        authorType: "customer",
        customerId: testCustomerId,
        body: "I have another question",
      }),
    ).rejects.toMatchObject({
      code: "ERR_TICKET_CLOSED",
    });
  });

  it("rejects message on non-existent ticket", async () => {
    const db = dbConn.db;

    await expect(
      createTicketMessage(db, {
        ticketId: "00000000-0000-0000-0000-000000000099",
        authorType: "customer",
        body: "Hello?",
      }),
    ).rejects.toMatchObject({
      code: "ERR_TICKET_NOT_FOUND",
    });
  });

  // ---------------------------------------------------------------------------
  // Ticket linked to order and shipment
  // ---------------------------------------------------------------------------

  it("creates ticket linked to order_id", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: testOrderId,
      subject: "Order linkage test",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    expect(ticket.orderId).toBe(testOrderId);

    // Can filter tickets by order
    const orderTickets = await listSupportTickets(db, { orderId: testOrderId });
    expect(orderTickets.some((t) => t.id === ticket.id)).toBe(true);
  });
});
