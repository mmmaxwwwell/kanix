import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order } from "./db/schema/order.js";
import {
  supportTicket,
  supportTicketMessage,
  supportTicketStatusHistory,
} from "./db/schema/support.js";
import { evidenceRecord } from "./db/schema/evidence.js";
import { adminUser } from "./db/schema/admin.js";
import { eq, sql } from "drizzle-orm";
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
  findAndMarkSlaOverdueTickets,
  TICKET_TRANSITIONS,
} from "./db/queries/support-ticket.js";
import { customer } from "./db/schema/customer.js";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("support ticket integration (T061, FR-050)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  const createdTicketIds: string[] = [];
  const createdOrderIds: string[] = [];
  let testCustomerId: string;
  let testCustomerId2: string;
  let testOrderId: string;
  let testOrderId2: string;
  let testAdminUserId: string;

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create a real admin user (FK constraint on support_ticket_message.admin_user_id)
    const [admin] = await db
      .insert(adminUser)
      .values({
        authSubject: `auth-t240-admin-${ts}`,
        email: `t240-admin-${ts}@test.kanix.dev`,
        name: "Test Support Admin",
        status: "active",
      })
      .returning();
    testAdminUserId = admin.id;

    // Create test customers
    const [cust1] = await db
      .insert(customer)
      .values({
        email: `t240-customer-${ts}@test.kanix.dev`,
        authSubject: `auth-t240-cust-${ts}`,
      })
      .returning();
    testCustomerId = cust1.id;

    const [cust2] = await db
      .insert(customer)
      .values({
        email: `t240-customer2-${ts}@test.kanix.dev`,
        authSubject: `auth-t240-cust2-${ts}`,
      })
      .returning();
    testCustomerId2 = cust2.id;

    // Create test orders
    const [ord1] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T240A-${ts}`,
        email: `t240-customer-${ts}@test.kanix.dev`,
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
    testOrderId = ord1.id;
    createdOrderIds.push(ord1.id);

    const [ord2] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T240B-${ts}`,
        email: `t240-customer-${ts}@test.kanix.dev`,
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
    testOrderId2 = ord2.id;
    createdOrderIds.push(ord2.id);
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      // Disable evidence_record immutability triggers for cleanup
      await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);
      try {
        // Clean up child rows first
        for (const ticketId of createdTicketIds) {
          await db.delete(evidenceRecord).where(eq(evidenceRecord.supportTicketId, ticketId));
          await db
            .delete(supportTicketStatusHistory)
            .where(eq(supportTicketStatusHistory.ticketId, ticketId));
          await db.delete(supportTicketMessage).where(eq(supportTicketMessage.ticketId, ticketId));
        }
        // Clear linked_ticket_id FK references before deleting tickets
        for (const ticketId of createdTicketIds) {
          await db
            .update(supportTicket)
            .set({ linkedTicketId: null })
            .where(eq(supportTicket.id, ticketId));
        }
        // Now safe to delete tickets
        for (const ticketId of createdTicketIds) {
          await db.delete(supportTicket).where(eq(supportTicket.id, ticketId));
        }
      } finally {
        await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);
      }
      for (const orderId of createdOrderIds) {
        await db.delete(order).where(eq(order.id, orderId));
      }
      await db.delete(customer).where(eq(customer.id, testCustomerId));
      await db.delete(customer).where(eq(customer.id, testCustomerId2));
      await db.delete(adminUser).where(eq(adminUser.id, testAdminUserId));
      await dbConn.close();
    }
  });

  // ---------------------------------------------------------------------------
  // State machine validation (pure logic)
  // ---------------------------------------------------------------------------

  it("validates all legal transitions from the TICKET_TRANSITIONS map", () => {
    // Exhaustively verify every allowed transition
    for (const [from, targets] of Object.entries(TICKET_TRANSITIONS)) {
      for (const to of targets) {
        expect(isValidTicketTransition(from, to)).toBe(true);
      }
    }
  });

  it("rejects all illegal transitions exhaustively", () => {
    const allStatuses = Object.keys(TICKET_TRANSITIONS);
    for (const from of allStatuses) {
      const allowed = TICKET_TRANSITIONS[from];
      for (const to of allStatuses) {
        if (from === to) continue; // self-transition always invalid
        if (!allowed.includes(to)) {
          expect(isValidTicketTransition(from, to)).toBe(false);
        }
      }
    }
  });

  it("terminal states (closed, spam) have no outgoing transitions", () => {
    expect(TICKET_TRANSITIONS["closed"]).toEqual([]);
    expect(TICKET_TRANSITIONS["spam"]).toEqual([]);
    expect(isValidTicketTransition("closed", "open")).toBe(false);
    expect(isValidTicketTransition("spam", "open")).toBe(false);
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

    expect(ticket.ticketNumber).toMatch(/^TKT-[A-Z0-9]+$/);
    expect(ticket.customerId).toBe(testCustomerId);
    expect(ticket.orderId).toBe(testOrderId);
    expect(ticket.status).toBe("open");
    expect(ticket.priority).toBe("high");
    expect(ticket.category).toBe("shipping_issue");
    expect(ticket.source).toBe("customer_app");
    expect(ticket.resolvedAt).toBeNull();
    expect(ticket.slaBreachedAt).toBeNull();
    expect(ticket.potentialDuplicate).toBe(false);
    expect(ticket.mergedIntoTicketId).toBeNull();
    expect(ticket.createdAt).toBeInstanceOf(Date);
    expect(ticket.updatedAt).toBeInstanceOf(Date);
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

  it("finds a ticket by ID with full field set", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: testOrderId,
      subject: "Findable ticket",
      category: "billing",
      source: "admin_created",
      priority: "urgent",
    });
    createdTicketIds.push(ticket.id);

    const found = await findTicketById(db, ticket.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(ticket.id);
    expect(found!.subject).toBe("Findable ticket");
    expect(found!.category).toBe("billing");
    expect(found!.priority).toBe("urgent");
    expect(found!.source).toBe("admin_created");
    expect(found!.customerId).toBe(testCustomerId);
    expect(found!.orderId).toBe(testOrderId);
    expect(found!.status).toBe("open");
  });

  it("returns null for non-existent ticket", async () => {
    const db = dbConn.db;
    const found = await findTicketById(db, "00000000-0000-0000-0000-000000000099");
    expect(found).toBeNull();
  });

  it("lists tickets filtered by status", async () => {
    const db = dbConn.db;
    const tickets = await listSupportTickets(db, { status: "open" });
    expect(tickets.length).toBeGreaterThanOrEqual(1);
    for (const t of tickets) {
      expect(t.status).toBe("open");
    }
    // Verify our test tickets appear
    const ourIds = createdTicketIds.filter((id) => tickets.some((t) => t.id === id));
    expect(ourIds.length).toBeGreaterThanOrEqual(1);
  });

  it("lists tickets filtered by customer ID", async () => {
    const db = dbConn.db;
    const tickets = await listTicketsByCustomerId(db, testCustomerId);
    expect(tickets.length).toBeGreaterThanOrEqual(1);
    for (const t of tickets) {
      expect(t.customerId).toBe(testCustomerId);
    }
  });

  it("lists tickets filtered by order ID", async () => {
    const db = dbConn.db;
    const tickets = await listSupportTickets(db, { orderId: testOrderId });
    expect(tickets.length).toBeGreaterThanOrEqual(1);
    for (const t of tickets) {
      expect(t.orderId).toBe(testOrderId);
    }
  });

  it("lists tickets filtered by priority", async () => {
    const db = dbConn.db;
    const tickets = await listSupportTickets(db, { priority: "high" });
    expect(tickets.length).toBeGreaterThanOrEqual(1);
    for (const t of tickets) {
      expect(t.priority).toBe("high");
    }
  });

  it("search by customer returns empty for unknown customer", async () => {
    const db = dbConn.db;
    const tickets = await listTicketsByCustomerId(db, "00000000-0000-0000-0000-ffffffffffff");
    expect(tickets).toHaveLength(0);
  });

  it("customer2 cannot see customer1's tickets", async () => {
    const db = dbConn.db;
    const tickets = await listTicketsByCustomerId(db, testCustomerId2);
    const customer1Tickets = tickets.filter((t) => t.customerId === testCustomerId);
    expect(customer1Tickets).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle: customer creates -> admin replies -> internal note
  //   (not visible to customer) -> resolve -> close
  // ---------------------------------------------------------------------------

  it("full ticket lifecycle: create -> reply -> internal note -> resolve -> close", async () => {
    const db = dbConn.db;

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
    expect(customerMsg.customerId).toBe(testCustomerId);
    expect(customerMsg.isInternalNote).toBe(false);
    expect(customerMsg.body).toBe("The package was crushed and the item inside is broken.");
    expect(customerMsg.ticketId).toBe(ticket.id);
    expect(customerMsg.createdAt).toBeInstanceOf(Date);

    // Step 3: Admin replies (customer-visible)
    const adminReply = await createTicketMessage(db, {
      ticketId: ticket.id,
      authorType: "admin",
      adminUserId: testAdminUserId,
      body: "I'm sorry to hear that. We'll send a replacement right away.",
    });
    expect(adminReply.authorType).toBe("admin");
    expect(adminReply.adminUserId).toBe(testAdminUserId);
    expect(adminReply.isInternalNote).toBe(false);

    // Step 4: Admin adds internal note (NOT visible to customer)
    const internalNote = await createTicketMessage(db, {
      ticketId: ticket.id,
      authorType: "admin",
      adminUserId: testAdminUserId,
      body: "Customer seems upset. Expedite replacement. Flagging for manager review.",
      isInternalNote: true,
    });
    expect(internalNote.isInternalNote).toBe(true);
    expect(internalNote.body).toContain("Flagging for manager review");

    // Step 5: Verify customer sees only non-internal messages
    const customerMessages = await listTicketMessages(db, ticket.id, {
      includeInternalNotes: false,
    });
    expect(customerMessages).toHaveLength(2); // customer + admin reply
    for (const m of customerMessages) {
      expect(m.isInternalNote).toBe(false);
    }
    expect(customerMessages[0].authorType).toBe("customer");
    expect(customerMessages[1].authorType).toBe("admin");

    // Step 6: Admin sees all messages including internal notes
    const adminMessages = await listTicketMessages(db, ticket.id, {
      includeInternalNotes: true,
    });
    expect(adminMessages).toHaveLength(3); // customer + admin reply + internal note
    const noteMsg = adminMessages.find((m) => m.isInternalNote);
    expect(noteMsg).toBeDefined();
    expect(noteMsg!.body).toContain("Flagging for manager review");
    expect(noteMsg!.adminUserId).toBe(testAdminUserId);

    // Step 7: Transition open -> resolved
    const resolved = await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "resolved",
      reason: "Replacement shipped",
      actorAdminUserId: testAdminUserId,
    });
    expect(resolved.oldStatus).toBe("open");
    expect(resolved.newStatus).toBe("resolved");
    expect(resolved.resolvedAt).toBeInstanceOf(Date);

    // Step 8: Transition resolved -> closed
    const closed = await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "closed",
      reason: "Resolution accepted by customer",
      actorAdminUserId: testAdminUserId,
    });
    expect(closed.oldStatus).toBe("resolved");
    expect(closed.newStatus).toBe("closed");

    // Step 9: Verify status history is correct and ordered
    const history = await findTicketStatusHistory(db, ticket.id);
    expect(history).toHaveLength(2);
    // History ordered desc by created_at
    expect(history[0].oldStatus).toBe("resolved");
    expect(history[0].newStatus).toBe("closed");
    expect(history[0].actorAdminUserId).toBe(testAdminUserId);
    expect(history[0].createdAt).toBeInstanceOf(Date);
    expect(history[1].oldStatus).toBe("open");
    expect(history[1].newStatus).toBe("resolved");
    expect(history[1].actorAdminUserId).toBe(testAdminUserId);

    // Step 10: Verify final ticket state via DB
    const finalTicket = await findTicketById(db, ticket.id);
    expect(finalTicket!.status).toBe("closed");
    expect(finalTicket!.resolvedAt).toBeInstanceOf(Date);
  });

  // ---------------------------------------------------------------------------
  // Transition edge cases
  // ---------------------------------------------------------------------------

  it("rejects invalid transition (open -> closed directly)", async () => {
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
      from: "open",
      to: "closed",
    });

    // Verify ticket status unchanged
    const unchanged = await findTicketById(db, ticket.id);
    expect(unchanged!.status).toBe("open");
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

  it("supports reopen: resolved -> open", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Reopen test",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "resolved",
    });

    const reopened = await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "open",
    });
    expect(reopened.oldStatus).toBe("resolved");
    expect(reopened.newStatus).toBe("open");

    // resolvedAt should still be set from the resolve step
    const afterReopen = await findTicketById(db, ticket.id);
    expect(afterReopen!.status).toBe("open");
  });

  it("supports waiting_on_customer -> open (customer reply)", async () => {
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

  it("supports waiting_on_internal -> open", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Internal wait test",
      category: "product_question",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "waiting_on_internal",
    });

    const result = await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "open",
    });
    expect(result.oldStatus).toBe("waiting_on_internal");
    expect(result.newStatus).toBe("open");
  });

  it("open -> spam (terminal)", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Spam ticket test",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    const result = await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "spam",
      actorAdminUserId: testAdminUserId,
    });
    expect(result.newStatus).toBe("spam");

    // Verify spam is terminal — can't transition out
    await expect(
      transitionTicketStatus(db, {
        ticketId: ticket.id,
        newStatus: "open",
      }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
    });
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

  it("rejects message on spam ticket", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Will be spam",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    await transitionTicketStatus(db, { ticketId: ticket.id, newStatus: "spam" });

    await expect(
      createTicketMessage(db, {
        ticketId: ticket.id,
        authorType: "customer",
        body: "Still here",
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
  // Ticket linked to order — search by order/customer/status
  // ---------------------------------------------------------------------------

  it("creates ticket linked to order_id and finds via order filter", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: testOrderId2,
      subject: "Order linkage test",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    expect(ticket.orderId).toBe(testOrderId2);

    const orderTickets = await listSupportTickets(db, { orderId: testOrderId2 });
    expect(orderTickets.length).toBeGreaterThanOrEqual(1);
    const match = orderTickets.find((t) => t.id === ticket.id);
    expect(match).toBeDefined();
    expect(match!.orderId).toBe(testOrderId2);
    expect(match!.subject).toBe("Order linkage test");
  });

  it("combined filter: status + customerId returns only matching tickets", async () => {
    const db = dbConn.db;

    const tickets = await listSupportTickets(db, {
      status: "open",
      customerId: testCustomerId,
    });
    for (const t of tickets) {
      expect(t.status).toBe("open");
      expect(t.customerId).toBe(testCustomerId);
    }
    expect(tickets.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // SLA overdue flag (FR-050)
  // ---------------------------------------------------------------------------

  it("marks ticket as SLA-breached when no admin response within threshold", async () => {
    const db = dbConn.db;

    // Create a ticket and backdate its createdAt to simulate being old
    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "SLA overdue test",
      category: "product_question",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    // Backdate createdAt to 5 hours ago
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    await db
      .update(supportTicket)
      .set({ createdAt: fiveHoursAgo })
      .where(eq(supportTicket.id, ticket.id));

    // Run SLA check with 4-hour threshold
    const breached = await findAndMarkSlaOverdueTickets(db, 4);
    const ourBreach = breached.find((b) => b.ticketId === ticket.id);
    expect(ourBreach).toBeDefined();
    expect(ourBreach!.ticketNumber).toMatch(/^TKT-/);
    expect(ourBreach!.slaBreachedAt).toBeInstanceOf(Date);

    // Verify the flag persisted
    const afterBreach = await findTicketById(db, ticket.id);
    expect(afterBreach!.slaBreachedAt).toBeInstanceOf(Date);
  });

  it("does NOT mark ticket as SLA-breached when admin has responded", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "SLA not overdue — admin responded",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    // Admin replies
    await createTicketMessage(db, {
      ticketId: ticket.id,
      authorType: "admin",
      adminUserId: testAdminUserId,
      body: "Thanks for reaching out, let me check.",
    });

    // Backdate createdAt to 5 hours ago
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    await db
      .update(supportTicket)
      .set({ createdAt: fiveHoursAgo })
      .where(eq(supportTicket.id, ticket.id));

    // Run SLA check — this ticket should NOT appear
    const breached = await findAndMarkSlaOverdueTickets(db, 4);
    const ourBreach = breached.find((b) => b.ticketId === ticket.id);
    expect(ourBreach).toBeUndefined();

    // Verify no SLA flag
    const afterCheck = await findTicketById(db, ticket.id);
    expect(afterCheck!.slaBreachedAt).toBeNull();
  });

  it("SLA check is idempotent — already-breached tickets are skipped", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "SLA idempotency test",
      category: "shipping_issue",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    // Backdate and breach
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    await db
      .update(supportTicket)
      .set({ createdAt: sixHoursAgo })
      .where(eq(supportTicket.id, ticket.id));

    const first = await findAndMarkSlaOverdueTickets(db, 4);
    const firstMatch = first.find((b) => b.ticketId === ticket.id);
    expect(firstMatch).toBeDefined();

    // Run again — should not re-breach
    const second = await findAndMarkSlaOverdueTickets(db, 4);
    const secondMatch = second.find((b) => b.ticketId === ticket.id);
    expect(secondMatch).toBeUndefined();

    // slaBreachedAt should still be set from the first run
    const after = await findTicketById(db, ticket.id);
    expect(after!.slaBreachedAt).toBeInstanceOf(Date);
  });

  it("SLA check skips resolved/closed tickets", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "SLA resolved skip test",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    // Resolve the ticket
    await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "resolved",
    });

    // Backdate createdAt
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await db
      .update(supportTicket)
      .set({ createdAt: tenHoursAgo })
      .where(eq(supportTicket.id, ticket.id));

    // SLA check should not flag resolved tickets
    const breached = await findAndMarkSlaOverdueTickets(db, 4);
    const match = breached.find((b) => b.ticketId === ticket.id);
    expect(match).toBeUndefined();
  });

  it("SLA check does not flag tickets within threshold", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "SLA within window test",
      category: "product_question",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    // Ticket was just created (within 4-hour window)
    const breached = await findAndMarkSlaOverdueTickets(db, 4);
    const match = breached.find((b) => b.ticketId === ticket.id);
    expect(match).toBeUndefined();

    const after = await findTicketById(db, ticket.id);
    expect(after!.slaBreachedAt).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Status history audit trail
  // ---------------------------------------------------------------------------

  it("records audit trail with actor for every transition", async () => {
    const db = dbConn.db;

    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      subject: "Audit trail test",
      category: "billing",
      source: "customer_app",
    });
    createdTicketIds.push(ticket.id);

    // open -> waiting_on_customer
    await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "waiting_on_customer",
      reason: "Awaiting info",
      actorAdminUserId: testAdminUserId,
    });

    // waiting_on_customer -> open
    await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "open",
      reason: "Customer replied",
    });

    // open -> resolved
    await transitionTicketStatus(db, {
      ticketId: ticket.id,
      newStatus: "resolved",
      reason: "Issue fixed",
      actorAdminUserId: testAdminUserId,
    });

    const history = await findTicketStatusHistory(db, ticket.id);
    expect(history).toHaveLength(3);

    // Desc order: most recent first
    expect(history[0].oldStatus).toBe("open");
    expect(history[0].newStatus).toBe("resolved");
    expect(history[0].actorAdminUserId).toBe(testAdminUserId);

    expect(history[1].oldStatus).toBe("waiting_on_customer");
    expect(history[1].newStatus).toBe("open");
    expect(history[1].actorAdminUserId).toBeNull(); // no actor for customer action

    expect(history[2].oldStatus).toBe("open");
    expect(history[2].newStatus).toBe("waiting_on_customer");
    expect(history[2].actorAdminUserId).toBe(testAdminUserId);

    // Each history entry has a unique ID and timestamp
    const ids = history.map((h) => h.id);
    expect(new Set(ids).size).toBe(3);
    for (const h of history) {
      expect(h.createdAt).toBeInstanceOf(Date);
      expect(h.ticketId).toBe(ticket.id);
    }
  });
});
