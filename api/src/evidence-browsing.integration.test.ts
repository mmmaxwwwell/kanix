import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { order } from "./db/schema/order.js";
import { payment, dispute } from "./db/schema/payment.js";
import { shipment } from "./db/schema/fulfillment.js";
import { supportTicket } from "./db/schema/support.js";
import { evidenceRecord } from "./db/schema/evidence.js";
import { createEvidenceRecord, findEvidenceById, listEvidence } from "./db/queries/evidence.js";

const DATABASE_URL = process.env["DATABASE_URL"];

const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("evidence browsing API (T066b)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now();
  let orderId = "";
  let orderId2 = "";
  let paymentId = "";
  let disputeId = "";
  let shipmentId = "";
  let ticketId = "";

  // Track created evidence IDs for assertions
  const createdIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

    // 1. Product + variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `evi-browse-prod-${ts}`,
        title: `Evidence Browse Test Product ${ts}`,
        status: "active",
      })
      .returning();

    await db.insert(productVariant).values({
      productId: prod.id,
      sku: `EVI-BRO-VAR-${ts}`,
      title: `Evidence Browse Variant ${ts}`,
      priceMinor: 3000,
      status: "active",
      weight: "30",
    });

    // 2. Two orders (so we can test filtering by order)
    const [orderRow] = await db
      .insert(order)
      .values({
        orderNumber: `ORD-EBRO-${ts}`,
        email: `evi-browse-${ts}@example.com`,
        status: "confirmed",
        paymentStatus: "disputed",
        subtotalMinor: 3000,
        totalMinor: 3000,
        shippingAddressSnapshotJson: {
          full_name: "Evidence Browse User",
          line1: "400 Main St",
          city: "Portland",
          state: "OR",
          postal_code: "97201",
          country: "US",
        },
      })
      .returning();
    orderId = orderRow.id;

    const [orderRow2] = await db
      .insert(order)
      .values({
        orderNumber: `ORD-EBRO2-${ts}`,
        email: `evi-browse2-${ts}@example.com`,
        status: "confirmed",
        paymentStatus: "paid",
        subtotalMinor: 5000,
        totalMinor: 5000,
        shippingAddressSnapshotJson: {
          full_name: "Evidence Browse User 2",
          line1: "500 Main St",
          city: "Portland",
          state: "OR",
          postal_code: "97201",
          country: "US",
        },
      })
      .returning();
    orderId2 = orderRow2.id;

    // 3. Payment + Dispute (linked to order 1)
    const [paymentRow] = await db
      .insert(payment)
      .values({
        orderId,
        providerPaymentIntentId: `pi_ebro_test_${ts}`,
        amountMinor: 3000,
        currency: "USD",
        status: "succeeded",
      })
      .returning();
    paymentId = paymentRow.id;

    const [disputeRow] = await db
      .insert(dispute)
      .values({
        paymentId,
        orderId,
        providerDisputeId: `dp_ebro_test_${ts}`,
        reason: "fraudulent",
        amountMinor: 3000,
        currency: "USD",
        status: "evidence_gathering",
        openedAt: new Date(),
      })
      .returning();
    disputeId = disputeRow.id;

    // 4. Shipment (linked to order 1)
    const [shipmentRow] = await db
      .insert(shipment)
      .values({
        orderId,
        shipmentNumber: `SHP-EBRO-${ts}`,
        status: "delivered",
      })
      .returning();
    shipmentId = shipmentRow.id;

    // 5. Support ticket (linked to order 1)
    const [ticketRow] = await db
      .insert(supportTicket)
      .values({
        ticketNumber: `TKT-EBRO-${ts}`,
        orderId,
        subject: "Test ticket for evidence browsing",
        category: "general",
        status: "open",
        priority: "normal",
        source: "email",
      })
      .returning();
    ticketId = ticketRow.id;

    // 6. Create evidence records with various types and links
    // Record 1: tracking_history for order 1, shipment
    const r1 = await createEvidenceRecord(db, {
      orderId,
      shipmentId,
      type: "tracking_history",
      textContent: JSON.stringify({ status: "in_transit", description: "Package picked up" }),
      metadataJson: { source: "auto" },
    });
    createdIds.push(r1.id);

    // Record 2: delivery_proof for order 1, shipment
    const r2 = await createEvidenceRecord(db, {
      orderId,
      shipmentId,
      type: "delivery_proof",
      textContent: JSON.stringify({ deliveredAt: "2026-04-10T14:00:00Z" }),
      metadataJson: { source: "auto" },
    });
    createdIds.push(r2.id);

    // Record 3: customer_communication for order 1, ticket
    const r3 = await createEvidenceRecord(db, {
      orderId,
      supportTicketId: ticketId,
      type: "customer_communication",
      textContent: JSON.stringify({ body: "I received the package" }),
      metadataJson: { source: "auto" },
    });
    createdIds.push(r3.id);

    // Record 4: payment_receipt for order 1, dispute
    const r4 = await createEvidenceRecord(db, {
      orderId,
      disputeId,
      paymentId,
      type: "payment_receipt",
      textContent: JSON.stringify({ eventType: "payment_intent.succeeded" }),
      metadataJson: { source: "auto" },
    });
    createdIds.push(r4.id);

    // Record 5: policy_acceptance for order 1
    const r5 = await createEvidenceRecord(db, {
      orderId,
      type: "policy_acceptance",
      textContent: JSON.stringify({ policySnapshotId: "snap-1" }),
      metadataJson: { source: "auto" },
    });
    createdIds.push(r5.id);

    // Record 6: tracking_history for order 2 (different order)
    const r6 = await createEvidenceRecord(db, {
      orderId: orderId2,
      type: "tracking_history",
      textContent: JSON.stringify({ status: "shipped", description: "Label created" }),
      metadataJson: { source: "auto" },
    });
    createdIds.push(r6.id);

    // Record 7: manual evidence for dispute
    const r7 = await createEvidenceRecord(db, {
      orderId,
      disputeId,
      type: "customer_communication",
      storageKey: `evidence/${disputeId}/${ts}/screenshot.png`,
      metadataJson: {
        source: "manual",
        adminAttached: true,
        fileName: "screenshot.png",
        contentType: "image/png",
      },
    });
    createdIds.push(r7.id);
  }, 60000);

  afterAll(async () => {
    const db = dbConn?.db;
    if (db) {
      try {
        // Evidence records are immutable — bypass triggers for cleanup
        await db.execute(
          sql`ALTER TABLE evidence_record DISABLE TRIGGER trg_evidence_record_no_delete`,
        );
        if (orderId) {
          await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, orderId));
        }
        if (orderId2) {
          await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, orderId2));
        }
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

  // -------------------------------------------------------------------------
  // listEvidence — filter by orderId
  // -------------------------------------------------------------------------

  it("should return all evidence for a specific order when filtering by order_id", async () => {
    const db = dbConn.db;
    const records = await listEvidence(db, { orderId });

    // Order 1 has records 1-5 and 7 (6 records total)
    expect(records.length).toBe(6);
    expect(records.every((r) => r.orderId === orderId)).toBe(true);
  });

  it("should return only evidence for order 2 when filtering by that order", async () => {
    const db = dbConn.db;
    const records = await listEvidence(db, { orderId: orderId2 });

    // Order 2 has 1 record (tracking_history)
    expect(records.length).toBe(1);
    expect(records[0].orderId).toBe(orderId2);
    expect(records[0].type).toBe("tracking_history");
  });

  // -------------------------------------------------------------------------
  // listEvidence — filter by type
  // -------------------------------------------------------------------------

  it("should return matching records when filtering by type", async () => {
    const db = dbConn.db;

    // Filter by tracking_history — should include records from both orders
    const records = await listEvidence(db, { type: "tracking_history" });

    // At least 2 records (from order 1 and order 2)
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(records.every((r) => r.type === "tracking_history")).toBe(true);
  });

  it("should return only delivery_proof records when filtering by that type", async () => {
    const db = dbConn.db;
    const records = await listEvidence(db, { type: "delivery_proof", orderId });

    expect(records.length).toBe(1);
    expect(records[0].type).toBe("delivery_proof");
    expect(records[0].orderId).toBe(orderId);
  });

  // -------------------------------------------------------------------------
  // listEvidence — filter by shipmentId
  // -------------------------------------------------------------------------

  it("should return evidence linked to a specific shipment", async () => {
    const db = dbConn.db;
    const records = await listEvidence(db, { shipmentId });

    // Shipment has tracking_history and delivery_proof
    expect(records.length).toBe(2);
    expect(records.every((r) => r.shipmentId === shipmentId)).toBe(true);
    const types = new Set(records.map((r) => r.type));
    expect(types.has("tracking_history")).toBe(true);
    expect(types.has("delivery_proof")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // listEvidence — filter by disputeId
  // -------------------------------------------------------------------------

  it("should return evidence linked to a specific dispute", async () => {
    const db = dbConn.db;
    const records = await listEvidence(db, { disputeId });

    // Dispute has payment_receipt and manual customer_communication
    expect(records.length).toBe(2);
    expect(records.every((r) => r.disputeId === disputeId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // listEvidence — filter by supportTicketId
  // -------------------------------------------------------------------------

  it("should return evidence linked to a specific ticket", async () => {
    const db = dbConn.db;
    const records = await listEvidence(db, { supportTicketId: ticketId });

    expect(records.length).toBe(1);
    expect(records[0].supportTicketId).toBe(ticketId);
    expect(records[0].type).toBe("customer_communication");
  });

  // -------------------------------------------------------------------------
  // listEvidence — combined filters
  // -------------------------------------------------------------------------

  it("should support combining type and order filters", async () => {
    const db = dbConn.db;
    const records = await listEvidence(db, { type: "customer_communication", orderId });

    // Order 1 has 2 customer_communication records (auto from ticket + manual for dispute)
    expect(records.length).toBe(2);
    expect(records.every((r) => r.type === "customer_communication")).toBe(true);
    expect(records.every((r) => r.orderId === orderId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // listEvidence — no filters returns all
  // -------------------------------------------------------------------------

  it("should return all evidence when no filters provided", async () => {
    const db = dbConn.db;
    const records = await listEvidence(db, {});

    // At least 7 records from our test setup
    expect(records.length).toBeGreaterThanOrEqual(7);
  });

  // -------------------------------------------------------------------------
  // findEvidenceById — single record with download URL
  // -------------------------------------------------------------------------

  it("should return single evidence record by ID", async () => {
    const db = dbConn.db;
    const record = await findEvidenceById(db, createdIds[0]);

    expect(record).toBeDefined();
    expect(record?.id).toBe(createdIds[0]);
    expect(record?.type).toBe("tracking_history");
    expect(record?.orderId).toBe(orderId);
  });

  it("should return file-based evidence record with storageKey", async () => {
    const db = dbConn.db;
    // Record 7 (index 6) has a storageKey
    const record = await findEvidenceById(db, createdIds[6]);

    expect(record).toBeDefined();
    expect(record?.storageKey).toBeDefined();
    expect(record?.storageKey).toContain("screenshot.png");

    const metadata = record?.metadataJson as { fileName?: string; contentType?: string } | null;
    expect(metadata?.fileName).toBe("screenshot.png");
    expect(metadata?.contentType).toBe("image/png");
  });

  it("should return null for non-existent evidence ID", async () => {
    const db = dbConn.db;
    const record = await findEvidenceById(db, "00000000-0000-0000-0000-000000000099");
    expect(record).toBeNull();
  });
});
