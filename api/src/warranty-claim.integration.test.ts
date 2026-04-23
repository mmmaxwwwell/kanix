import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import { order, orderLine } from "./db/schema/order.js";
import { shipment } from "./db/schema/fulfillment.js";
import {
  supportTicket,
  supportTicketMessage,
  supportTicketStatusHistory,
} from "./db/schema/support.js";
import { product, productVariant } from "./db/schema/catalog.js";
import { customer } from "./db/schema/customer.js";
import { eq, sql } from "drizzle-orm";
import { listTicketMessages } from "./db/queries/support-ticket.js";
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
  const { default: EmailVerification } =
    await import("supertokens-node/recipe/emailverification/index.js");
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

describe("warranty claim integration (T063, FR-055)", () => {
  let ts_: TestServer;
  let dbConn: DatabaseConnection;
  let address: string;

  const ts = Date.now();
  const customerAEmail = `t242-custA-${ts}@kanix.dev`;
  const customerBEmail = `t242-custB-${ts}@kanix.dev`;
  const password = "Test1234!@#$";

  let customerAHeaders: Record<string, string>;
  let customerBHeaders: Record<string, string>;

  let testCustomerAId: string;
  let testCustomerBId: string;
  let testOrderId: string;
  let testOrderLineId: string;
  let testProductId: string;
  let testVariantId: string;

  const createdTicketIds: string[] = [];
  const createdShipmentIds: string[] = [];
  const createdOrderIds: string[] = [];

  beforeAll(async () => {
    ts_ = await createTestServer();
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // -- Customer A setup (order owner) --
    const custAAuthSubject = await signUpUser(address, customerAEmail, password);
    await verifyUserEmail(custAAuthSubject);

    const [custA] = await db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, custAAuthSubject));
    testCustomerAId = custA.id;

    customerAHeaders = await signInAndGetHeaders(address, customerAEmail, password);

    // -- Customer B setup (non-owner) --
    const custBAuthSubject = await signUpUser(address, customerBEmail, password);
    await verifyUserEmail(custBAuthSubject);

    const [custB] = await db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, custBAuthSubject));
    testCustomerBId = custB.id;

    customerBHeaders = await signInAndGetHeaders(address, customerBEmail, password);

    // -- Order for Customer A (confirmed, paid, delivered) --
    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T242-${ts}`,
        email: customerAEmail,
        customerId: testCustomerAId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "fulfilled",
        shippingStatus: "delivered",
        subtotalMinor: 5000,
        taxMinor: 250,
        shippingMinor: 599,
        totalMinor: 5849,
        placedAt: new Date(),
      })
      .returning();
    testOrderId = ord.id;
    createdOrderIds.push(ord.id);

    // -- Product + Variant (FK required by order_line.variant_id) --
    const [prod] = await db
      .insert(product)
      .values({
        slug: `t242-tpu-case-${ts}`,
        title: `TPU Phone Case ${ts}`,
        status: "active",
      })
      .returning();
    testProductId = prod.id;

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `T242-TPU-${ts}`,
        title: `TPU Phone Case Variant ${ts}`,
        priceMinor: 5000,
        status: "active",
      })
      .returning();
    testVariantId = variant.id;

    // -- Order line --
    const [line] = await db
      .insert(orderLine)
      .values({
        orderId: testOrderId,
        variantId: testVariantId,
        skuSnapshot: "KNX-T242-001",
        titleSnapshot: "TPU Phone Case",
        quantity: 1,
        unitPriceMinor: 5000,
        totalMinor: 5000,
      })
      .returning();
    testOrderLineId = line.id;

    // -- Delivered shipment (11 months ago — within warranty) --
    const elevenMonthsAgo = new Date();
    elevenMonthsAgo.setMonth(elevenMonthsAgo.getMonth() - 11);

    const [shp] = await db
      .insert(shipment)
      .values({
        orderId: testOrderId,
        shipmentNumber: `SHP-KNX-T242-${ts}`,
        status: "delivered",
        carrier: "USPS",
        serviceLevel: "Priority",
        shippedAt: elevenMonthsAgo,
        deliveredAt: elevenMonthsAgo,
      })
      .returning();
    createdShipmentIds.push(shp.id);
  }, 30000);

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      // Disable evidence_record immutability triggers
      await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);
      try {
        for (const ticketId of createdTicketIds) {
          await db.execute(sql`DELETE FROM evidence_record WHERE support_ticket_id = ${ticketId}`);
          await db
            .delete(supportTicketStatusHistory)
            .where(eq(supportTicketStatusHistory.ticketId, ticketId));
          await db.delete(supportTicketMessage).where(eq(supportTicketMessage.ticketId, ticketId));
          // Null out self-referencing FK before delete
          await db.execute(
            sql`UPDATE support_ticket SET linked_ticket_id = NULL WHERE linked_ticket_id = ${ticketId}`,
          );
          await db.delete(supportTicket).where(eq(supportTicket.id, ticketId));
        }
        for (const shipId of createdShipmentIds) {
          await db.delete(shipment).where(eq(shipment.id, shipId));
        }
        // Delete order lines for all created orders
        for (const orderId of createdOrderIds) {
          await db.delete(orderLine).where(eq(orderLine.orderId, orderId));
        }
        for (const orderId of createdOrderIds) {
          await db.execute(sql`DELETE FROM order_status_history WHERE order_id = ${orderId}`);
          await db.delete(order).where(eq(order.id, orderId));
        }
        // Clean up product/variant
        if (testVariantId) {
          await db.delete(productVariant).where(eq(productVariant.id, testVariantId));
        }
        if (testProductId) {
          await db.delete(product).where(eq(product.id, testProductId));
        }
      } finally {
        await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);
      }
    }
    await stopTestServer(ts_);
  }, 15000);

  // -------------------------------------------------------------------------
  // Happy path: valid warranty claim (11 months — within warranty)
  // -------------------------------------------------------------------------

  it("creates a warranty claim ticket for a delivered order within warranty period", async () => {
    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...customerAHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: testOrderId,
        order_line_id: testOrderLineId,
        description: "The phone case has a crack along the edge after normal use.",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticket: {
        id: string;
        category: string;
        priority: string;
        status: string;
        orderId: string;
        customerId: string;
        subject: string;
        source: string;
      };
      material_limitation_flagged: boolean;
      material_limitation_note: string | null;
    };

    createdTicketIds.push(body.ticket.id);

    expect(body.ticket.category).toBe("warranty_claim");
    expect(body.ticket.priority).toBe("high");
    expect(body.ticket.status).toBe("open");
    expect(body.ticket.orderId).toBe(testOrderId);
    expect(body.ticket.customerId).toBe(testCustomerAId);
    expect(body.ticket.subject).toContain("Warranty Claim");
    expect(body.ticket.source).toBe("customer_app");
    expect(body.material_limitation_flagged).toBe(false);
    expect(body.material_limitation_note).toBeNull();

    // Verify the initial message was created in the DB
    const messages = await listTicketMessages(dbConn.db, body.ticket.id, {
      includeInternalNotes: true,
    });
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBe("The phone case has a crack along the edge after normal use.");
    expect(messages[0].authorType).toBe("customer");
  });

  // -------------------------------------------------------------------------
  // Warranty expired (13 months — outside window)
  // -------------------------------------------------------------------------

  it("rejects a warranty claim when warranty period has expired (400)", async () => {
    const db = dbConn.db;

    // Create an order with a shipment delivered 13 months ago
    const [expiredOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T242-EXP-${ts}`,
        email: customerAEmail,
        customerId: testCustomerAId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "fulfilled",
        shippingStatus: "delivered",
        subtotalMinor: 3000,
        totalMinor: 3000,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(expiredOrder.id);

    const [expiredLine] = await db
      .insert(orderLine)
      .values({
        orderId: expiredOrder.id,
        variantId: testVariantId,
        skuSnapshot: "KNX-T242-EXP-001",
        titleSnapshot: "Expired Item",
        quantity: 1,
        unitPriceMinor: 3000,
        totalMinor: 3000,
      })
      .returning();

    const thirteenMonthsAgo = new Date();
    thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);

    const [expiredShp] = await db
      .insert(shipment)
      .values({
        orderId: expiredOrder.id,
        shipmentNumber: `SHP-KNX-T242-EXP-${ts}`,
        status: "delivered",
        carrier: "USPS",
        deliveredAt: thirteenMonthsAgo,
      })
      .returning();
    createdShipmentIds.push(expiredShp.id);

    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...customerAHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: expiredOrder.id,
        order_line_id: expiredLine.id,
        description: "Item broke.",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_WARRANTY_EXPIRED");
    expect(body.message).toContain("Warranty period has expired");
  });

  // -------------------------------------------------------------------------
  // TPU heat deformation — flagged with material limitation
  // -------------------------------------------------------------------------

  it("flags material limitation when TPU heat deformation is described", async () => {
    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...customerAHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: testOrderId,
        order_line_id: testOrderLineId,
        description:
          "The case warped and deformed after I left it on my car dashboard in the heat.",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticket: { id: string; category: string; priority: string };
      material_limitation_flagged: boolean;
      material_limitation_note: string;
    };

    createdTicketIds.push(body.ticket.id);

    expect(body.ticket.category).toBe("warranty_claim");
    expect(body.ticket.priority).toBe("high");
    expect(body.material_limitation_flagged).toBe(true);
    expect(body.material_limitation_note).toContain("TPU heat deformation");
    expect(body.material_limitation_note).toContain("documented material limitation");

    // Verify both the customer message and the internal system note in DB
    const allMessages = await listTicketMessages(dbConn.db, body.ticket.id, {
      includeInternalNotes: true,
    });
    expect(allMessages.length).toBe(2);

    const customerMsg = allMessages.find((m) => m.authorType === "customer");
    expect(customerMsg).toBeDefined();
    expect(customerMsg!.body).toContain("car dashboard");
    expect(customerMsg!.isInternalNote).toBe(false);

    const systemNote = allMessages.find((m) => m.authorType === "system");
    expect(systemNote).toBeDefined();
    expect(systemNote!.isInternalNote).toBe(true);
    expect(systemNote!.body).toContain("TPU heat deformation");

    // Verify internal note is NOT visible to customer (no includeInternalNotes)
    const customerVisibleMessages = await listTicketMessages(dbConn.db, body.ticket.id);
    expect(customerVisibleMessages.length).toBe(1);
    expect(customerVisibleMessages[0].authorType).toBe("customer");
  });

  // -------------------------------------------------------------------------
  // Order not delivered — 400
  // -------------------------------------------------------------------------

  it("rejects a warranty claim when order has not been delivered (400)", async () => {
    const db = dbConn.db;

    const [undeliveredOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T242-UND-${ts}`,
        email: customerAEmail,
        customerId: testCustomerAId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "queued",
        shippingStatus: "not_shipped",
        subtotalMinor: 2000,
        totalMinor: 2000,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(undeliveredOrder.id);

    const [undeliveredLine] = await db
      .insert(orderLine)
      .values({
        orderId: undeliveredOrder.id,
        variantId: testVariantId,
        skuSnapshot: "KNX-T242-UND-001",
        titleSnapshot: "Undelivered Item",
        quantity: 1,
        unitPriceMinor: 2000,
        totalMinor: 2000,
      })
      .returning();

    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...customerAHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: undeliveredOrder.id,
        order_line_id: undeliveredLine.id,
        description: "Item is defective.",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_ORDER_NOT_DELIVERED");
    expect(body.message).toContain("not been delivered");
  });

  // -------------------------------------------------------------------------
  // Non-owner submits claim — 404 (existence hidden)
  // -------------------------------------------------------------------------

  it("rejects a warranty claim when order does not belong to the customer (404)", async () => {
    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...customerBHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: testOrderId,
        order_line_id: testOrderLineId,
        description: "Not my order.",
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_ORDER_NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // Invalid order line — 404
  // -------------------------------------------------------------------------

  it("rejects a warranty claim with an invalid order line ID (404)", async () => {
    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...customerAHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: testOrderId,
        order_line_id: "00000000-0000-0000-0000-000000000999",
        description: "Item is defective.",
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_ORDER_LINE_NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // Unauthenticated request — 401
  // -------------------------------------------------------------------------

  it("rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        order_id: testOrderId,
        order_line_id: testOrderLineId,
        description: "Should fail.",
      }),
    });

    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Missing required fields — 400
  // -------------------------------------------------------------------------

  it("rejects request missing required fields (400)", async () => {
    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...customerAHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: testOrderId,
        // missing order_line_id and description
      }),
    });

    expect(res.status).toBe(400);
  });
});
