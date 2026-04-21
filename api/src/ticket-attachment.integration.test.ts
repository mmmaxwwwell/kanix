import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order } from "./db/schema/order.js";
import {
  supportTicket,
  supportTicketMessage,
  supportTicketAttachment,
  supportTicketStatusHistory,
} from "./db/schema/support.js";
import { eq } from "drizzle-orm";
import {
  createSupportTicket,
  createTicketMessage,
  createTicketAttachment,
  findAttachmentById,
  listAttachmentsByTicketId,
  deleteTicketAttachment,
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "./db/queries/support-ticket.js";
import { customer } from "./db/schema/customer.js";
import { createStubStorageAdapter, createLocalStorageAdapter } from "./services/storage-adapter.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("ticket attachment integration (T062)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  const createdTicketIds: string[] = [];
  const createdOrderIds: string[] = [];
  let testCustomerId: string;
  let testCustomerId2: string;
  let testOrderId: string;
  let testTicketId: string;
  let testMessageId: string;

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create test customers
    const [cust] = await db
      .insert(customer)
      .values({
        email: `t062-customer-${ts}@test.kanix.dev`,
        authSubject: `auth-t062-${ts}`,
      })
      .returning();
    testCustomerId = cust.id;

    const [cust2] = await db
      .insert(customer)
      .values({
        email: `t062-customer2-${ts}@test.kanix.dev`,
        authSubject: `auth-t062-2-${ts}`,
      })
      .returning();
    testCustomerId2 = cust2.id;

    // Create a test order
    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T062-${ts}`,
        email: `t062-customer-${ts}@test.kanix.dev`,
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

    // Create a test ticket
    const ticket = await createSupportTicket(db, {
      customerId: testCustomerId,
      orderId: testOrderId,
      subject: "Attachment test ticket",
      category: "general",
      source: "customer_app",
    });
    testTicketId = ticket.id;
    createdTicketIds.push(ticket.id);

    // Create a test message
    const message = await createTicketMessage(db, {
      ticketId: testTicketId,
      authorType: "customer",
      customerId: testCustomerId,
      body: "Here is my attachment",
    });
    testMessageId = message.id;
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      // Clean up in reverse dependency order
      for (const ticketId of createdTicketIds) {
        await db
          .delete(supportTicketAttachment)
          .where(eq(supportTicketAttachment.ticketId, ticketId));
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
      await db.delete(customer).where(eq(customer.id, testCustomerId2));
      await dbConn.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Upload valid file → accessible
  // ---------------------------------------------------------------------------

  it("creates an attachment with valid JPEG content type", async () => {
    const db = dbConn.db;

    const attachment = await createTicketAttachment(db, {
      ticketId: testTicketId,
      messageId: testMessageId,
      storageKey: `tickets/${testTicketId}/test-uuid/photo.jpg`,
      fileName: "photo.jpg",
      contentType: "image/jpeg",
      sizeBytes: 1024,
    });

    expect(attachment.id).toBeDefined();
    expect(attachment.ticketId).toBe(testTicketId);
    expect(attachment.messageId).toBe(testMessageId);
    expect(attachment.fileName).toBe("photo.jpg");
    expect(attachment.contentType).toBe("image/jpeg");
    expect(attachment.sizeBytes).toBe(1024);
    expect(attachment.storageKey).toContain("photo.jpg");
    expect(attachment.createdAt).toBeInstanceOf(Date);
  });

  it("creates an attachment with PNG content type", async () => {
    const db = dbConn.db;

    const attachment = await createTicketAttachment(db, {
      ticketId: testTicketId,
      storageKey: `tickets/${testTicketId}/test-uuid-2/screenshot.png`,
      fileName: "screenshot.png",
      contentType: "image/png",
      sizeBytes: 2048,
    });

    expect(attachment.id).toBeDefined();
    expect(attachment.contentType).toBe("image/png");
    expect(attachment.messageId).toBeNull();
  });

  it("creates an attachment with PDF content type", async () => {
    const db = dbConn.db;

    const attachment = await createTicketAttachment(db, {
      ticketId: testTicketId,
      storageKey: `tickets/${testTicketId}/test-uuid-3/receipt.pdf`,
      fileName: "receipt.pdf",
      contentType: "application/pdf",
      sizeBytes: 4096,
    });

    expect(attachment.id).toBeDefined();
    expect(attachment.contentType).toBe("application/pdf");
  });

  // ---------------------------------------------------------------------------
  // Retrieve attachment
  // ---------------------------------------------------------------------------

  it("retrieves an attachment by ID", async () => {
    const db = dbConn.db;

    const created = await createTicketAttachment(db, {
      ticketId: testTicketId,
      storageKey: `tickets/${testTicketId}/find-test/find-me.jpg`,
      fileName: "find-me.jpg",
      contentType: "image/jpeg",
      sizeBytes: 512,
    });

    const found = await findAttachmentById(db, created.id);
    expect(found).toBeTruthy();
    expect(found?.id).toBe(created.id);
    expect(found?.fileName).toBe("find-me.jpg");
  });

  it("returns null for non-existent attachment", async () => {
    const db = dbConn.db;
    const found = await findAttachmentById(db, "00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // List attachments by ticket
  // ---------------------------------------------------------------------------

  it("lists all attachments for a ticket", async () => {
    const db = dbConn.db;

    const attachments = await listAttachmentsByTicketId(db, testTicketId);
    // We've created several attachments above
    expect(attachments.length).toBeGreaterThanOrEqual(3);
    for (const a of attachments) {
      expect(a.ticketId).toBe(testTicketId);
    }
  });

  // ---------------------------------------------------------------------------
  // Upload invalid type → rejected
  // ---------------------------------------------------------------------------

  it("rejects attachment with disallowed content type", async () => {
    const db = dbConn.db;

    await expect(
      createTicketAttachment(db, {
        ticketId: testTicketId,
        storageKey: `tickets/${testTicketId}/bad/virus.exe`,
        fileName: "virus.exe",
        contentType: "application/x-executable",
        sizeBytes: 1024,
      }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_CONTENT_TYPE",
    });
  });

  it("rejects attachment with disallowed GIF type", async () => {
    const db = dbConn.db;

    await expect(
      createTicketAttachment(db, {
        ticketId: testTicketId,
        storageKey: `tickets/${testTicketId}/bad/anim.gif`,
        fileName: "anim.gif",
        contentType: "image/gif",
        sizeBytes: 1024,
      }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_CONTENT_TYPE",
    });
  });

  // ---------------------------------------------------------------------------
  // File too large → rejected
  // ---------------------------------------------------------------------------

  it("rejects attachment exceeding 10MB size limit", async () => {
    const db = dbConn.db;

    await expect(
      createTicketAttachment(db, {
        ticketId: testTicketId,
        storageKey: `tickets/${testTicketId}/big/huge.pdf`,
        fileName: "huge.pdf",
        contentType: "application/pdf",
        sizeBytes: MAX_ATTACHMENT_SIZE_BYTES + 1,
      }),
    ).rejects.toMatchObject({
      code: "ERR_FILE_TOO_LARGE",
    });
  });

  // ---------------------------------------------------------------------------
  // Max 5 per message
  // ---------------------------------------------------------------------------

  it("enforces max 5 attachments per message", async () => {
    const db = dbConn.db;

    // Create a new message for this test
    const msg = await createTicketMessage(db, {
      ticketId: testTicketId,
      authorType: "customer",
      customerId: testCustomerId,
      body: "Multiple attachments",
    });

    // Create 5 attachments (max)
    for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE; i++) {
      await createTicketAttachment(db, {
        ticketId: testTicketId,
        messageId: msg.id,
        storageKey: `tickets/${testTicketId}/${msg.id}/file-${i}.jpg`,
        fileName: `file-${i}.jpg`,
        contentType: "image/jpeg",
        sizeBytes: 100,
      });
    }

    // The 6th should fail
    await expect(
      createTicketAttachment(db, {
        ticketId: testTicketId,
        messageId: msg.id,
        storageKey: `tickets/${testTicketId}/${msg.id}/file-5.jpg`,
        fileName: "file-5.jpg",
        contentType: "image/jpeg",
        sizeBytes: 100,
      }),
    ).rejects.toMatchObject({
      code: "ERR_TOO_MANY_ATTACHMENTS",
    });
  });

  // ---------------------------------------------------------------------------
  // Attachment for non-existent ticket → rejected
  // ---------------------------------------------------------------------------

  it("rejects attachment for non-existent ticket", async () => {
    const db = dbConn.db;

    await expect(
      createTicketAttachment(db, {
        ticketId: "00000000-0000-0000-0000-000000000000",
        storageKey: "tickets/fake/test.jpg",
        fileName: "test.jpg",
        contentType: "image/jpeg",
        sizeBytes: 100,
      }),
    ).rejects.toMatchObject({
      code: "ERR_TICKET_NOT_FOUND",
    });
  });

  // ---------------------------------------------------------------------------
  // Delete attachment
  // ---------------------------------------------------------------------------

  it("deletes an attachment", async () => {
    const db = dbConn.db;

    const attachment = await createTicketAttachment(db, {
      ticketId: testTicketId,
      storageKey: `tickets/${testTicketId}/delete-test/delete-me.jpg`,
      fileName: "delete-me.jpg",
      contentType: "image/jpeg",
      sizeBytes: 256,
    });

    const deleted = await deleteTicketAttachment(db, attachment.id);
    expect(deleted).toBeTruthy();
    expect(deleted?.id).toBe(attachment.id);

    const notFound = await findAttachmentById(db, attachment.id);
    expect(notFound).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Storage adapter tests
  // ---------------------------------------------------------------------------

  it("stub storage adapter stores and retrieves files", async () => {
    const adapter = createStubStorageAdapter();
    const data = Buffer.from("test file content");
    const key = "test/file.jpg";

    await adapter.put(key, data, "image/jpeg");

    const result = await adapter.get(key);
    expect(result).toBeTruthy();
    expect(result?.data.toString()).toBe("test file content");
    expect(result?.contentType).toBe("image/jpeg");

    await adapter.delete(key);
    const deleted = await adapter.get(key);
    expect(deleted).toBeNull();
  });

  it("local storage adapter stores and retrieves files on filesystem", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kanix-storage-test-"));

    try {
      const adapter = createLocalStorageAdapter(tempDir);
      const data = Buffer.from("PDF file content");
      const key = "tickets/abc/test.pdf";

      await adapter.put(key, data, "application/pdf");

      const result = await adapter.get(key);
      expect(result).toBeTruthy();
      expect(result?.data.toString()).toBe("PDF file content");
      expect(result?.contentType).toBe("application/pdf");

      await adapter.delete(key);
      const deleted = await adapter.get(key);
      expect(deleted).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("local storage adapter returns null for non-existent key", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kanix-storage-test-"));

    try {
      const adapter = createLocalStorageAdapter(tempDir);
      const result = await adapter.get("nonexistent/file.jpg");
      expect(result).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Constants validation
  // ---------------------------------------------------------------------------

  it("allowed attachment types include JPEG, PNG, and PDF", () => {
    expect(ALLOWED_ATTACHMENT_TYPES).toContain("image/jpeg");
    expect(ALLOWED_ATTACHMENT_TYPES).toContain("image/png");
    expect(ALLOWED_ATTACHMENT_TYPES).toContain("application/pdf");
    expect(ALLOWED_ATTACHMENT_TYPES).toHaveLength(3);
  });

  it("max attachment size is 10MB", () => {
    expect(MAX_ATTACHMENT_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("max attachments per message is 5", () => {
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5);
  });
});
