import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine } from "./db/schema/order.js";
import { shipment } from "./db/schema/fulfillment.js";
import {
  supportTicket,
  supportTicketMessage,
  supportTicketStatusHistory,
} from "./db/schema/support.js";
import { customer } from "./db/schema/customer.js";
import { eq } from "drizzle-orm";
import { createWarrantyClaim, listTicketMessages } from "./db/queries/support-ticket.js";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("warranty claim integration (T063)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  const createdTicketIds: string[] = [];
  const createdShipmentIds: string[] = [];
  const createdOrderIds: string[] = [];
  let testCustomerId: string;
  let testOrderId: string;
  let testOrderLineId: string;
  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create a test customer
    const [cust] = await db
      .insert(customer)
      .values({
        email: `t063-customer-${ts}@test.kanix.dev`,
        authSubject: `auth-t063-${ts}`,
      })
      .returning();
    testCustomerId = cust.id;

    // Create a test order (confirmed, paid, delivered)
    const [ord] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T063-${ts}`,
        email: `t063-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
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

    // Create an order line
    const [line] = await db
      .insert(orderLine)
      .values({
        orderId: testOrderId,
        variantId: "00000000-0000-0000-0000-000000000001",
        skuSnapshot: "KNX-T063-001",
        titleSnapshot: "TPU Phone Case",
        quantity: 1,
        unitPriceMinor: 5000,
        totalMinor: 5000,
      })
      .returning();
    testOrderLineId = line.id;

    // Create a delivered shipment (delivered 11 months ago — within warranty)
    const elevenMonthsAgo = new Date();
    elevenMonthsAgo.setMonth(elevenMonthsAgo.getMonth() - 11);

    const [shp] = await db
      .insert(shipment)
      .values({
        orderId: testOrderId,
        shipmentNumber: `SHP-KNX-T063-${ts}`,
        status: "delivered",
        carrier: "USPS",
        serviceLevel: "Priority",
        shippedAt: elevenMonthsAgo,
        deliveredAt: elevenMonthsAgo,
      })
      .returning();
    createdShipmentIds.push(shp.id);
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
      for (const shipId of createdShipmentIds) {
        await db.delete(shipment).where(eq(shipment.id, shipId));
      }
      await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId));
      for (const orderId of createdOrderIds) {
        await db.delete(order).where(eq(order.id, orderId));
      }
      await db.delete(customer).where(eq(customer.id, testCustomerId));
      await dbConn.close();
    }
  });

  // -------------------------------------------------------------------------
  // Valid warranty claim (11 months — within warranty)
  // -------------------------------------------------------------------------

  it("creates a warranty claim ticket for a delivered order within warranty period", async () => {
    const db = dbConn.db;
    const result = await createWarrantyClaim(db, {
      customerId: testCustomerId,
      orderId: testOrderId,
      orderLineId: testOrderLineId,
      description: "The phone case has a crack along the edge after normal use.",
    });

    createdTicketIds.push(result.ticket.id);

    expect(result.ticket.category).toBe("warranty_claim");
    expect(result.ticket.priority).toBe("high");
    expect(result.ticket.status).toBe("open");
    expect(result.ticket.orderId).toBe(testOrderId);
    expect(result.ticket.customerId).toBe(testCustomerId);
    expect(result.ticket.subject).toContain("Warranty Claim");
    expect(result.ticket.source).toBe("customer_app");
    expect(result.materialLimitationFlagged).toBe(false);
    expect(result.materialLimitationNote).toBeNull();

    // Verify the initial message was created
    const messages = await listTicketMessages(db, result.ticket.id, {
      includeInternalNotes: true,
    });
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBe("The phone case has a crack along the edge after normal use.");
    expect(messages[0].authorType).toBe("customer");
  });

  // -------------------------------------------------------------------------
  // Expired warranty claim (13 months — outside warranty)
  // -------------------------------------------------------------------------

  it("rejects a warranty claim when warranty period has expired", async () => {
    const db = dbConn.db;

    // Create an order with a shipment delivered 13 months ago
    const [expiredOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T063-EXP-${ts}`,
        email: `t063-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
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
        variantId: "00000000-0000-0000-0000-000000000001",
        skuSnapshot: "KNX-T063-EXP-001",
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
        shipmentNumber: `SHP-KNX-T063-EXP-${ts}`,
        status: "delivered",
        carrier: "USPS",
        deliveredAt: thirteenMonthsAgo,
      })
      .returning();
    createdShipmentIds.push(expiredShp.id);

    await expect(
      createWarrantyClaim(db, {
        customerId: testCustomerId,
        orderId: expiredOrder.id,
        orderLineId: expiredLine.id,
        description: "Item broke.",
      }),
    ).rejects.toMatchObject({
      code: "ERR_WARRANTY_EXPIRED",
    });
  });

  // -------------------------------------------------------------------------
  // TPU heat deformation claim — flagged
  // -------------------------------------------------------------------------

  it("flags material limitation when TPU heat deformation is described", async () => {
    const db = dbConn.db;
    const result = await createWarrantyClaim(db, {
      customerId: testCustomerId,
      orderId: testOrderId,
      orderLineId: testOrderLineId,
      description: "The case warped and deformed after I left it on my car dashboard in the heat.",
    });

    createdTicketIds.push(result.ticket.id);

    expect(result.ticket.category).toBe("warranty_claim");
    expect(result.ticket.priority).toBe("high");
    expect(result.materialLimitationFlagged).toBe(true);
    expect(result.materialLimitationNote).toContain("TPU heat deformation");
    expect(result.materialLimitationNote).toContain("documented material limitation");

    // Verify both the customer message and the internal system note were created
    const allMessages = await listTicketMessages(db, result.ticket.id, {
      includeInternalNotes: true,
    });
    expect(allMessages.length).toBe(2);

    const customerMsg = allMessages.find((m) => m.authorType === "customer");
    expect(customerMsg).toBeDefined();
    expect(customerMsg?.body).toContain("car dashboard");
    expect(customerMsg?.isInternalNote).toBe(false);

    const systemNote = allMessages.find((m) => m.authorType === "system");
    expect(systemNote).toBeDefined();
    expect(systemNote?.isInternalNote).toBe(true);
    expect(systemNote?.body).toContain("TPU heat deformation");

    // Verify internal note is NOT visible to customer
    const customerVisibleMessages = await listTicketMessages(db, result.ticket.id);
    expect(customerVisibleMessages.length).toBe(1);
    expect(customerVisibleMessages[0].authorType).toBe("customer");
  });

  // -------------------------------------------------------------------------
  // Order not delivered — rejected
  // -------------------------------------------------------------------------

  it("rejects a warranty claim when order has not been delivered", async () => {
    const db = dbConn.db;

    // Create an order with no delivered shipment
    const [undeliveredOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T063-UND-${ts}`,
        email: `t063-customer-${ts}@test.kanix.dev`,
        customerId: testCustomerId,
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
        variantId: "00000000-0000-0000-0000-000000000001",
        skuSnapshot: "KNX-T063-UND-001",
        titleSnapshot: "Undelivered Item",
        quantity: 1,
        unitPriceMinor: 2000,
        totalMinor: 2000,
      })
      .returning();

    await expect(
      createWarrantyClaim(db, {
        customerId: testCustomerId,
        orderId: undeliveredOrder.id,
        orderLineId: undeliveredLine.id,
        description: "Item is defective.",
      }),
    ).rejects.toMatchObject({
      code: "ERR_ORDER_NOT_DELIVERED",
    });
  });

  // -------------------------------------------------------------------------
  // Wrong customer — rejected
  // -------------------------------------------------------------------------

  it("rejects a warranty claim when order does not belong to customer", async () => {
    const db = dbConn.db;

    // Create another customer
    const [otherCust] = await db
      .insert(customer)
      .values({
        email: `t063-other-${ts}@test.kanix.dev`,
        authSubject: `auth-t063-other-${ts}`,
      })
      .returning();

    try {
      await expect(
        createWarrantyClaim(db, {
          customerId: otherCust.id,
          orderId: testOrderId,
          orderLineId: testOrderLineId,
          description: "Not my order.",
        }),
      ).rejects.toMatchObject({
        code: "ERR_ORDER_NOT_FOUND",
      });
    } finally {
      await db.delete(customer).where(eq(customer.id, otherCust.id));
    }
  });

  // -------------------------------------------------------------------------
  // Invalid order line — rejected
  // -------------------------------------------------------------------------

  it("rejects a warranty claim with an invalid order line ID", async () => {
    const db = dbConn.db;

    await expect(
      createWarrantyClaim(db, {
        customerId: testCustomerId,
        orderId: testOrderId,
        orderLineId: "00000000-0000-0000-0000-000000000999",
        description: "Item is defective.",
      }),
    ).rejects.toMatchObject({
      code: "ERR_ORDER_LINE_NOT_FOUND",
    });
  });
});
