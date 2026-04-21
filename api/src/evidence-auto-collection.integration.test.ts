import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { order, orderLine } from "./db/schema/order.js";
import { payment } from "./db/schema/payment.js";
import { shipment } from "./db/schema/fulfillment.js";
import { policySnapshot } from "./db/schema/evidence.js";
import { evidenceRecord } from "./db/schema/evidence.js";
import { storeShipmentEvent } from "./db/queries/shipment.js";
import { createTicketMessage, createSupportTicket } from "./db/queries/support-ticket.js";
import { storePaymentEvent } from "./db/queries/webhook.js";
import { createPolicyAcknowledgment } from "./db/queries/policy.js";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("evidence auto-collection (T065)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now();
  let orderId = "";
  let paymentId = "";
  let shipmentId = "";
  let ticketId = "";

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // 1. Create product + variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `evidence-test-prod-${ts}`,
        title: `Evidence Test Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `EVI-VAR-${ts}`,
        title: `Evidence Variant ${ts}`,
        priceMinor: 2500,
        status: "active",
        weight: "24",
      })
      .returning();

    // 2. Create an order directly
    const [orderRow] = await db
      .insert(order)
      .values({
        orderNumber: `ORD-EVI-${ts}`,
        email: `evidence-test-${ts}@example.com`,
        status: "confirmed",
        paymentStatus: "paid",
        subtotalMinor: 2500,
        totalMinor: 2500,
        shippingAddressSnapshotJson: {
          full_name: "Evidence Test User",
          line1: "789 Pine St",
          city: "Portland",
          state: "OR",
          postal_code: "97201",
          country: "US",
        },
      })
      .returning();
    orderId = orderRow.id;

    // 3. Create order line
    await db.insert(orderLine).values({
      orderId,
      variantId: variant.id,
      skuSnapshot: `EVI-VAR-${ts}`,
      titleSnapshot: `Evidence Variant ${ts}`,
      quantity: 1,
      unitPriceMinor: 2500,
      totalMinor: 2500,
    });

    // 4. Create payment
    const [paymentRow] = await db
      .insert(payment)
      .values({
        orderId,
        providerPaymentIntentId: `pi_evi_test_${ts}`,
        amountMinor: 2500,
        currency: "USD",
        status: "succeeded",
      })
      .returning();
    paymentId = paymentRow.id;

    // 5. Store a payment event (triggers payment_receipt evidence)
    await storePaymentEvent(db, {
      paymentId,
      providerEventId: `evt_evidence_test_${ts}`,
      eventType: "payment_intent.succeeded",
      payloadJson: { test: true },
    });

    // 6. Create a shipment for the order
    const [shipmentRow] = await db
      .insert(shipment)
      .values({
        orderId,
        shipmentNumber: `SHP-EVI-${ts}`,
        status: "shipped",
      })
      .returning();
    shipmentId = shipmentRow.id;

    // 7. Store tracking events (triggers tracking_history and delivery_proof)
    await storeShipmentEvent(db, {
      shipmentId,
      providerEventId: `trk_in_transit_${ts}`,
      status: "in_transit",
      description: "Package is in transit",
      occurredAt: new Date(),
      rawPayloadJson: { status: "in_transit" },
    });

    await storeShipmentEvent(db, {
      shipmentId,
      providerEventId: `trk_delivered_${ts}`,
      status: "delivered",
      description: "Package was delivered",
      occurredAt: new Date(),
      rawPayloadJson: { status: "delivered" },
    });

    // 8. Create a support ticket for the order and add a message
    const ticket = await createSupportTicket(db, {
      orderId,
      subject: `Evidence test ticket ${ts}`,
      category: "general",
      source: "customer_app",
    });
    ticketId = ticket.id;

    await createTicketMessage(db, {
      ticketId,
      authorType: "customer",
      body: "I have a question about my order",
    });

    // 9. Create policy snapshots and acknowledgments (triggers policy_acceptance)
    const policyTypes = ["terms_of_service", "refund_policy", "shipping_policy", "privacy_policy"];
    for (const pType of policyTypes) {
      const [snapshot] = await db
        .insert(policySnapshot)
        .values({
          policyType: pType,
          version: (ts % 100000) + 10000,
          contentHtml: `<p>${pType} v100 content</p>`,
          contentText: `${pType} v100 content`,
          effectiveAt: new Date(Date.now() - 86400000),
        })
        .onConflictDoNothing()
        .returning();

      if (snapshot) {
        await createPolicyAcknowledgment(db, {
          orderId,
          policySnapshotId: snapshot.id,
        });
      }
    }
  }, 60000);

  afterAll(async () => {
    const db = dbConn?.db;
    if (db && orderId) {
      try {
        // Evidence records are immutable (trigger prevents DELETE), bypass for cleanup
        await db.execute(
          sql`ALTER TABLE evidence_record DISABLE TRIGGER trg_evidence_record_no_delete`,
        );
        await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, orderId));
        await db.execute(
          sql`ALTER TABLE evidence_record ENABLE TRIGGER trg_evidence_record_no_delete`,
        );
      } catch {
        // cleanup best-effort
      }
    }
    try {
      await dbConn?.close();
    } catch {
      // ignore
    }
  });

  it("should auto-collect tracking_history evidence on shipment event", async () => {
    const db = dbConn.db;

    const records = await db
      .select()
      .from(evidenceRecord)
      .where(eq(evidenceRecord.orderId, orderId));

    const trackingRecords = records.filter((r) => r.type === "tracking_history");
    // 2 tracking events stored (in_transit + delivered)
    expect(trackingRecords.length).toBe(2);
    expect(trackingRecords.every((r) => r.shipmentId === shipmentId)).toBe(true);
    expect(trackingRecords.every((r) => r.textContent !== null)).toBe(true);
  });

  it("should auto-collect delivery_proof evidence on delivered shipment event", async () => {
    const db = dbConn.db;

    const records = await db
      .select()
      .from(evidenceRecord)
      .where(eq(evidenceRecord.orderId, orderId));

    const deliveryRecords = records.filter((r) => r.type === "delivery_proof");
    expect(deliveryRecords.length).toBe(1);
    expect(deliveryRecords[0].shipmentId).toBe(shipmentId);

    const content = JSON.parse(deliveryRecords[0].textContent ?? "");
    expect(content.description).toBe("Package was delivered");
  });

  it("should auto-collect customer_communication evidence on ticket message", async () => {
    const db = dbConn.db;

    const records = await db
      .select()
      .from(evidenceRecord)
      .where(eq(evidenceRecord.orderId, orderId));

    const commRecords = records.filter((r) => r.type === "customer_communication");
    expect(commRecords.length).toBeGreaterThanOrEqual(1);
    expect(commRecords[0].supportTicketId).toBe(ticketId);

    const content = JSON.parse(commRecords[0].textContent ?? "");
    expect(content.body).toBe("I have a question about my order");
  });

  it("should auto-collect payment_receipt evidence on payment event", async () => {
    const db = dbConn.db;

    const records = await db
      .select()
      .from(evidenceRecord)
      .where(eq(evidenceRecord.orderId, orderId));

    const paymentRecords = records.filter((r) => r.type === "payment_receipt");
    expect(paymentRecords.length).toBeGreaterThanOrEqual(1);
    expect(paymentRecords[0].paymentId).toBe(paymentId);

    const content = JSON.parse(paymentRecords[0].textContent ?? "");
    expect(content.eventType).toBe("payment_intent.succeeded");
  });

  it("should auto-collect policy_acceptance evidence on acknowledgment", async () => {
    const db = dbConn.db;

    const records = await db
      .select()
      .from(evidenceRecord)
      .where(eq(evidenceRecord.orderId, orderId));

    const policyRecords = records.filter((r) => r.type === "policy_acceptance");
    // 4 policy types acknowledged
    expect(policyRecords.length).toBe(4);
    expect(policyRecords.every((r) => r.textContent !== null)).toBe(true);
  });

  it("should have all 5 evidence types for the order lifecycle", async () => {
    const db = dbConn.db;

    const records = await db
      .select()
      .from(evidenceRecord)
      .where(eq(evidenceRecord.orderId, orderId));

    const types = new Set(records.map((r) => r.type));
    expect(types.has("tracking_history")).toBe(true);
    expect(types.has("delivery_proof")).toBe(true);
    expect(types.has("customer_communication")).toBe(true);
    expect(types.has("payment_receipt")).toBe(true);
    expect(types.has("policy_acceptance")).toBe(true);
    expect(types.size).toBe(5);
  });

  it("should prevent UPDATE on evidence_record (immutability)", async () => {
    const db = dbConn.db;

    const [record] = await db
      .select()
      .from(evidenceRecord)
      .where(eq(evidenceRecord.orderId, orderId))
      .limit(1);

    expect(record).toBeDefined();

    // Attempt UPDATE — should be rejected by DB trigger
    await expect(
      db
        .update(evidenceRecord)
        .set({ textContent: "tampered" })
        .where(eq(evidenceRecord.id, record.id)),
    ).rejects.toThrow(/evidence_record/);
  });

  it("should prevent DELETE on evidence_record (immutability)", async () => {
    const db = dbConn.db;

    const [record] = await db
      .select()
      .from(evidenceRecord)
      .where(eq(evidenceRecord.orderId, orderId))
      .limit(1);

    expect(record).toBeDefined();

    // Attempt DELETE — should be rejected by DB trigger
    await expect(db.delete(evidenceRecord).where(eq(evidenceRecord.id, record.id))).rejects.toThrow(
      /evidence_record/,
    );
  });
});
