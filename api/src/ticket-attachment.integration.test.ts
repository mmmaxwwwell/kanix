import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { order } from "./db/schema/order.js";
import {
  supportTicket,
  supportTicketMessage,
  supportTicketAttachment,
  supportTicketStatusHistory,
} from "./db/schema/support.js";
import { customer } from "./db/schema/customer.js";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { ROLE_CAPABILITIES, CAPABILITIES } from "./auth/admin.js";
import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  createSupportTicket,
  createTicketMessage,
} from "./db/queries/support-ticket.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

// ---------------------------------------------------------------------------
// Auth helpers (same pattern as other hardened tests)
// ---------------------------------------------------------------------------

async function signUpUser(address: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${address}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  const body = (await res.json()) as { status: string; user?: { id: string } };
  if (body.status !== "OK" || !body.user) {
    throw new Error(`Signup failed: ${JSON.stringify(body)}`);
  }
  return body.user.id;
}

async function verifyUserEmail(userId: string): Promise<void> {
  const { default: supertokens } = await import("supertokens-node");
  const { default: EmailVerification } = await import(
    "supertokens-node/recipe/emailverification/index.js"
  );
  const tokenRes = await EmailVerification.createEmailVerificationToken(
    "public",
    supertokens.convertToRecipeUserId(userId),
  );
  if (tokenRes.status === "OK") {
    await EmailVerification.verifyEmailUsingToken("public", tokenRes.token);
  }
}

async function signInAndGetHeaders(
  address: string,
  email: string,
  password: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${address}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  if (res.status !== 200) {
    throw new Error(`Sign-in failed with status ${res.status}`);
  }
  const cookies = res.headers.getSetCookie();
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const accessToken = res.headers.get("st-access-token");
  const antiCsrf = res.headers.get("anti-csrf");
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    cookie: cookieHeader,
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  if (antiCsrf) headers["anti-csrf"] = antiCsrf;
  return headers;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("ticket attachment integration (T062)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  const ts = Date.now();
  const adminEmail = `t241-admin-${ts}@kanix.dev`;
  const customerAEmail = `t241-custA-${ts}@kanix.dev`;
  const customerBEmail = `t241-custB-${ts}@kanix.dev`;
  const password = "Test1234!@#$";

  let adminHeaders: Record<string, string>;
  let customerAHeaders: Record<string, string>;
  let customerBHeaders: Record<string, string>;

  let adminUserId: string;
  let adminRoleId: string;
  let testCustomerAId: string;
  let testCustomerBId: string;
  let testOrderId: string;
  let testTicketAId: string; // Customer A's ticket
  let testTicketBId: string; // Customer B's ticket
  let testMessageId: string;

  const createdTicketIds: string[] = [];
  const createdOrderIds: string[] = [];

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // -- Admin setup --
    const adminAuthSubject = await signUpUser(address, adminEmail, password);
    await verifyUserEmail(adminAuthSubject);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `t241-super-${ts}`,
        capabilitiesJson: ROLE_CAPABILITIES["super_admin"],
      })
      .returning();
    adminRoleId = role.id;

    const [adm] = await db
      .insert(adminUser)
      .values({
        authSubject: adminAuthSubject,
        email: adminEmail,
        name: "T241 Admin",
        status: "active",
      })
      .returning();
    adminUserId = adm.id;

    await db.insert(adminUserRole).values({
      adminUserId: adm.id,
      adminRoleId: role.id,
    });

    adminHeaders = await signInAndGetHeaders(address, adminEmail, password);

    // -- Customer A setup --
    const custAAuthSubject = await signUpUser(address, customerAEmail, password);
    await verifyUserEmail(custAAuthSubject);

    // The signUp override creates the customer row automatically
    const [custA] = await db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, custAAuthSubject));
    testCustomerAId = custA.id;

    customerAHeaders = await signInAndGetHeaders(address, customerAEmail, password);

    // -- Customer B setup --
    const custBAuthSubject = await signUpUser(address, customerBEmail, password);
    await verifyUserEmail(custBAuthSubject);

    const [custB] = await db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, custBAuthSubject));
    testCustomerBId = custB.id;

    customerBHeaders = await signInAndGetHeaders(address, customerBEmail, password);

    // -- Test order for Customer A --
    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T241A-${ts}`,
        email: customerAEmail,
        customerId: testCustomerAId,
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

    // -- Test ticket for Customer A --
    const ticketA = await createSupportTicket(db, {
      customerId: testCustomerAId,
      orderId: testOrderId,
      subject: "Customer A attachment test",
      category: "general",
      source: "customer_app",
    });
    testTicketAId = ticketA.id;
    createdTicketIds.push(ticketA.id);

    // -- Test message on Customer A's ticket --
    const msg = await createTicketMessage(db, {
      ticketId: testTicketAId,
      authorType: "customer",
      customerId: testCustomerAId,
      body: "Here is my attachment",
    });
    testMessageId = msg.id;

    // -- Test order + ticket for Customer B --
    const [ordB] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T241B-${ts}`,
        email: customerBEmail,
        customerId: testCustomerBId,
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
    createdOrderIds.push(ordB.id);

    const ticketB = await createSupportTicket(db, {
      customerId: testCustomerBId,
      orderId: ordB.id,
      subject: "Customer B ticket",
      category: "general",
      source: "customer_app",
    });
    testTicketBId = ticketB.id;
    createdTicketIds.push(ticketB.id);
  }, 30000);

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      // Disable evidence_record immutability triggers (FK fk_er_ticket)
      await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);
      try {
        for (const ticketId of createdTicketIds) {
          await db.execute(
            sql`DELETE FROM evidence_record WHERE support_ticket_id = ${ticketId}`,
          );
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
          await db.execute(
            sql`DELETE FROM order_status_history WHERE order_id = ${orderId}`,
          );
          await db.delete(order).where(eq(order.id, orderId));
        }
        // Clean up admin (audit log FK first)
        await db.execute(
          sql`DELETE FROM admin_audit_log WHERE actor_admin_user_id = ${adminUserId}`,
        );
        await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminUserId));
        await db.delete(adminUser).where(eq(adminUser.id, adminUserId));
        await db.delete(adminRole).where(eq(adminRole.id, adminRoleId));
      } finally {
        await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);
      }
    }
    await stopTestServer(ts_);
  }, 15000);

  // ---------------------------------------------------------------------------
  // Constants validation
  // ---------------------------------------------------------------------------

  it("allowed attachment types include exactly JPEG, PNG, and PDF", () => {
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

  // ---------------------------------------------------------------------------
  // Admin upload → returns attachment + downloadUrl
  // ---------------------------------------------------------------------------

  it("admin uploads JPEG attachment and gets back attachment record + downloadUrl", async () => {
    const fileContent = Buffer.from("fake JPEG content").toString("base64");

    const res = await fetch(`${address}/api/admin/support-tickets/${testTicketAId}/attachments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "photo.jpg",
        contentType: "image/jpeg",
        data: fileContent,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      attachment: {
        id: string;
        ticketId: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
        storageKey: string;
        createdAt: string;
      };
      downloadUrl: string;
    };

    expect(body.attachment.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.attachment.ticketId).toBe(testTicketAId);
    expect(body.attachment.fileName).toBe("photo.jpg");
    expect(body.attachment.contentType).toBe("image/jpeg");
    expect(body.attachment.sizeBytes).toBe(Buffer.from("fake JPEG content").length);
    expect(body.attachment.storageKey).toContain("photo.jpg");
    expect(body.downloadUrl).toContain(body.attachment.id);
    expect(body.downloadUrl).toContain("/download");
  });

  it("admin uploads PNG attachment", async () => {
    const fileContent = Buffer.from("fake PNG content").toString("base64");

    const res = await fetch(`${address}/api/admin/support-tickets/${testTicketAId}/attachments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "screenshot.png",
        contentType: "image/png",
        data: fileContent,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { attachment: { contentType: string } };
    expect(body.attachment.contentType).toBe("image/png");
  });

  it("admin uploads PDF attachment", async () => {
    const fileContent = Buffer.from("fake PDF content").toString("base64");

    const res = await fetch(`${address}/api/admin/support-tickets/${testTicketAId}/attachments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "receipt.pdf",
        contentType: "application/pdf",
        data: fileContent,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { attachment: { contentType: string } };
    expect(body.attachment.contentType).toBe("application/pdf");
  });

  // ---------------------------------------------------------------------------
  // Customer upload → returns attachment + downloadUrl
  // ---------------------------------------------------------------------------

  it("customer uploads attachment to own ticket and gets downloadUrl", async () => {
    const fileContent = Buffer.from("customer JPEG data").toString("base64");

    const res = await fetch(`${address}/api/support/tickets/${testTicketAId}/attachments`, {
      method: "POST",
      headers: { ...customerAHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "my-photo.jpg",
        contentType: "image/jpeg",
        data: fileContent,
        messageId: testMessageId,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      attachment: {
        id: string;
        ticketId: string;
        messageId: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
      };
      downloadUrl: string;
    };

    expect(body.attachment.ticketId).toBe(testTicketAId);
    expect(body.attachment.messageId).toBe(testMessageId);
    expect(body.attachment.fileName).toBe("my-photo.jpg");
    expect(body.attachment.contentType).toBe("image/jpeg");
    expect(body.attachment.sizeBytes).toBe(Buffer.from("customer JPEG data").length);
    expect(body.downloadUrl).toContain(body.attachment.id);
  });

  // ---------------------------------------------------------------------------
  // Content-type whitelist enforcement
  // ---------------------------------------------------------------------------

  it("rejects attachment with disallowed content type (executable)", async () => {
    const res = await fetch(`${address}/api/admin/support-tickets/${testTicketAId}/attachments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "virus.exe",
        contentType: "application/x-executable",
        data: Buffer.from("bad content").toString("base64"),
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_INVALID_CONTENT_TYPE");
    expect(body.message).toContain("application/x-executable");
    expect(body.message).toContain("image/jpeg");
  });

  it("rejects GIF content type via customer endpoint", async () => {
    const res = await fetch(`${address}/api/support/tickets/${testTicketAId}/attachments`, {
      method: "POST",
      headers: { ...customerAHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "anim.gif",
        contentType: "image/gif",
        data: Buffer.from("gif content").toString("base64"),
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_INVALID_CONTENT_TYPE");
  });

  // ---------------------------------------------------------------------------
  // Size limit enforcement → 413
  // ---------------------------------------------------------------------------

  it("rejects attachment exceeding 10MB with 413 status (admin)", async () => {
    // Create a base64 string that decodes to > 10MB
    // A base64 string of length ceil(N*4/3) decodes to N bytes
    // 10MB + 1 byte = 10485761 bytes
    // We can't send 10MB+ in a test easily, so create a minimal oversized payload
    const oversizedData = Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1, "A").toString("base64");

    const res = await fetch(`${address}/api/admin/support-tickets/${testTicketAId}/attachments`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "huge.pdf",
        contentType: "application/pdf",
        data: oversizedData,
      }),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_FILE_TOO_LARGE");
    expect(body.message).toContain(`${MAX_ATTACHMENT_SIZE_BYTES}`);
  });

  it("rejects oversized attachment with 413 via customer endpoint", async () => {
    const oversizedData = Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1, "B").toString("base64");

    const res = await fetch(`${address}/api/support/tickets/${testTicketAId}/attachments`, {
      method: "POST",
      headers: { ...customerAHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "huge.jpg",
        contentType: "image/jpeg",
        data: oversizedData,
      }),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_FILE_TOO_LARGE");
  });

  // ---------------------------------------------------------------------------
  // Admin list + download
  // ---------------------------------------------------------------------------

  it("admin lists attachments for a ticket", async () => {
    const res = await fetch(`${address}/api/admin/support-tickets/${testTicketAId}/attachments`, {
      headers: adminHeaders,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachments: Array<{ id: string; ticketId: string; fileName: string }>;
    };
    expect(body.attachments.length).toBeGreaterThanOrEqual(1);
    for (const a of body.attachments) {
      expect(a.ticketId).toBe(testTicketAId);
      expect(a.id).toMatch(/^[0-9a-f]{8}-/);
    }
  });

  it("admin downloads an attachment by ID", async () => {
    // First upload so we have a known attachment
    const content = "download test content";
    const uploadRes = await fetch(
      `${address}/api/admin/support-tickets/${testTicketAId}/attachments`,
      {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "download-test.pdf",
          contentType: "application/pdf",
          data: Buffer.from(content).toString("base64"),
        }),
      },
    );
    expect(uploadRes.status).toBe(201);
    const uploadBody = (await uploadRes.json()) as { attachment: { id: string } };
    const attachmentId = uploadBody.attachment.id;

    // Download it
    const dlRes = await fetch(
      `${address}/api/admin/support-tickets/${testTicketAId}/attachments/${attachmentId}/download`,
      { headers: adminHeaders },
    );

    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("content-type")).toBe("application/pdf");
    expect(dlRes.headers.get("content-disposition")).toContain("download-test.pdf");
    const data = await dlRes.text();
    expect(data).toBe(content);
  });

  it("admin download returns 404 for non-existent attachment", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(
      `${address}/api/admin/support-tickets/${testTicketAId}/attachments/${fakeId}/download`,
      { headers: adminHeaders },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_ATTACHMENT_NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant isolation — customer can only see own ticket's attachments
  // ---------------------------------------------------------------------------

  it("customer B cannot upload to customer A's ticket", async () => {
    const res = await fetch(`${address}/api/support/tickets/${testTicketAId}/attachments`, {
      method: "POST",
      headers: { ...customerBHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "sneaky.jpg",
        contentType: "image/jpeg",
        data: Buffer.from("cross-tenant attempt").toString("base64"),
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_TICKET_NOT_FOUND");
  });

  it("customer B cannot list customer A's ticket attachments", async () => {
    const res = await fetch(`${address}/api/support/tickets/${testTicketAId}/attachments`, {
      headers: customerBHeaders,
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_TICKET_NOT_FOUND");
  });

  it("customer B cannot download customer A's attachment", async () => {
    // First, get an attachment ID from customer A's ticket via admin
    const listRes = await fetch(
      `${address}/api/admin/support-tickets/${testTicketAId}/attachments`,
      { headers: adminHeaders },
    );
    const listBody = (await listRes.json()) as {
      attachments: Array<{ id: string }>;
    };
    expect(listBody.attachments.length).toBeGreaterThanOrEqual(1);
    const attachmentId = listBody.attachments[0].id;

    // Customer B tries to download it
    const dlRes = await fetch(
      `${address}/api/support/tickets/${testTicketAId}/attachments/${attachmentId}/download`,
      { headers: customerBHeaders },
    );

    // Should be blocked — returns 403 because ticket ownership check fails
    expect(dlRes.status).toBe(403);
    const body = (await dlRes.json()) as { error: string };
    expect(body.error).toBe("ERR_FORBIDDEN");
  });

  it("customer A can list and download own ticket's attachments", async () => {
    // List
    const listRes = await fetch(`${address}/api/support/tickets/${testTicketAId}/attachments`, {
      headers: customerAHeaders,
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      attachments: Array<{ id: string; ticketId: string; fileName: string }>;
    };
    expect(listBody.attachments.length).toBeGreaterThanOrEqual(1);
    for (const a of listBody.attachments) {
      expect(a.ticketId).toBe(testTicketAId);
    }

    // Download one
    const attachmentId = listBody.attachments[0].id;
    const dlRes = await fetch(
      `${address}/api/support/tickets/${testTicketAId}/attachments/${attachmentId}/download`,
      { headers: customerAHeaders },
    );
    expect(dlRes.status).toBe(200);
    const contentType = dlRes.headers.get("content-type");
    expect(contentType).toMatch(/^(image\/jpeg|image\/png|application\/pdf)$/);
  });

  // ---------------------------------------------------------------------------
  // Deletion revokes access
  // ---------------------------------------------------------------------------

  it("admin deletes attachment and download returns 404 afterward", async () => {
    // Upload a fresh attachment
    const content = "to be deleted";
    const uploadRes = await fetch(
      `${address}/api/admin/support-tickets/${testTicketAId}/attachments`,
      {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "delete-me.jpg",
          contentType: "image/jpeg",
          data: Buffer.from(content).toString("base64"),
        }),
      },
    );
    expect(uploadRes.status).toBe(201);
    const uploadBody = (await uploadRes.json()) as { attachment: { id: string } };
    const attachmentId = uploadBody.attachment.id;

    // Verify it's downloadable
    const dlBefore = await fetch(
      `${address}/api/admin/support-tickets/${testTicketAId}/attachments/${attachmentId}/download`,
      { headers: adminHeaders },
    );
    expect(dlBefore.status).toBe(200);

    // Delete it
    const deleteRes = await fetch(
      `${address}/api/admin/support-tickets/${testTicketAId}/attachments/${attachmentId}`,
      {
        method: "DELETE",
        headers: adminHeaders,
      },
    );
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { deleted: { id: string; fileName: string } };
    expect(deleteBody.deleted.id).toBe(attachmentId);
    expect(deleteBody.deleted.fileName).toBe("delete-me.jpg");

    // Download after delete → 404
    const dlAfter = await fetch(
      `${address}/api/admin/support-tickets/${testTicketAId}/attachments/${attachmentId}/download`,
      { headers: adminHeaders },
    );
    expect(dlAfter.status).toBe(404);
    const afterBody = (await dlAfter.json()) as { error: string };
    expect(afterBody.error).toBe("ERR_ATTACHMENT_NOT_FOUND");

    // Also verify customer A can no longer access it
    const custDl = await fetch(
      `${address}/api/support/tickets/${testTicketAId}/attachments/${attachmentId}/download`,
      { headers: customerAHeaders },
    );
    expect(custDl.status).toBe(404);
  });

  it("delete returns 404 for non-existent attachment", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(
      `${address}/api/admin/support-tickets/${testTicketAId}/attachments/${fakeId}`,
      {
        method: "DELETE",
        headers: adminHeaders,
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_ATTACHMENT_NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // Upload to non-existent ticket → 404
  // ---------------------------------------------------------------------------

  it("upload to non-existent ticket returns 404", async () => {
    const fakeTicketId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(
      `${address}/api/admin/support-tickets/${fakeTicketId}/attachments`,
      {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "test.jpg",
          contentType: "image/jpeg",
          data: Buffer.from("test").toString("base64"),
        }),
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_TICKET_NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated access blocked
  // ---------------------------------------------------------------------------

  it("unauthenticated request to customer attachment endpoint returns 401", async () => {
    const res = await fetch(`${address}/api/support/tickets/${testTicketAId}/attachments`);
    expect(res.status).toBe(401);
  });

  it("unauthenticated request to admin attachment endpoint returns 401", async () => {
    const res = await fetch(`${address}/api/admin/support-tickets/${testTicketAId}/attachments`);
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Max attachments per message enforcement via HTTP
  // ---------------------------------------------------------------------------

  it("enforces max attachments per message via customer endpoint", async () => {
    const db = dbConn.db;

    // Create a dedicated message for this test
    const msg = await createTicketMessage(db, {
      ticketId: testTicketAId,
      authorType: "customer",
      customerId: testCustomerAId,
      body: "Max attachments test",
    });

    // Upload MAX_ATTACHMENTS_PER_MESSAGE attachments
    for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE; i++) {
      const res = await fetch(`${address}/api/support/tickets/${testTicketAId}/attachments`, {
        method: "POST",
        headers: { ...customerAHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: `msg-file-${i}.jpg`,
          contentType: "image/jpeg",
          data: Buffer.from(`file-${i}-content`).toString("base64"),
          messageId: msg.id,
        }),
      });
      expect(res.status).toBe(201);
    }

    // The (MAX+1)th should fail
    const res = await fetch(`${address}/api/support/tickets/${testTicketAId}/attachments`, {
      method: "POST",
      headers: { ...customerAHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "one-too-many.jpg",
        contentType: "image/jpeg",
        data: Buffer.from("overflow").toString("base64"),
        messageId: msg.id,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_TOO_MANY_ATTACHMENTS");
    expect(body.message).toContain(`${MAX_ATTACHMENTS_PER_MESSAGE}`);
  });
});
