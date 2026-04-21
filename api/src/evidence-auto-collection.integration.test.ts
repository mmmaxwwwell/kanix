import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { order, orderLine } from "./db/schema/order.js";
import { payment, dispute } from "./db/schema/payment.js";
import { shipment } from "./db/schema/fulfillment.js";
import { policySnapshot, evidenceRecord, evidenceBundle } from "./db/schema/evidence.js";
import { storeShipmentEvent } from "./db/queries/shipment.js";
import { createTicketMessage, createSupportTicket } from "./db/queries/support-ticket.js";
import { storePaymentEvent } from "./db/queries/webhook.js";
import { createPolicyAcknowledgment } from "./db/queries/policy.js";
import {
  findEvidenceByOrderId,
  computeReadinessSummary,
  generateEvidenceBundle,
} from "./db/queries/evidence.js";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("evidence auto-collection (T065)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now();
  let orderId = "";
  let paymentId = "";
  let shipmentId = "";
  let ticketId = "";
  let disputeId = "";

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Re-enable immutability triggers in case a prior run crashed mid-cleanup
    await db.execute(
      sql`ALTER TABLE evidence_record ENABLE TRIGGER trg_evidence_record_no_update`,
    );
    await db.execute(
      sql`ALTER TABLE evidence_record ENABLE TRIGGER trg_evidence_record_no_delete`,
    );

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
        providerChargeId: `ch_evi_test_${ts}`,
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

    // 10. Create a dispute for this order (simulating charge.dispute.created)
    const [disputeRow] = await db
      .insert(dispute)
      .values({
        paymentId,
        orderId,
        providerDisputeId: `dp_evi_test_${ts}`,
        reason: "fraudulent",
        amountMinor: 2500,
        currency: "USD",
        status: "opened",
        openedAt: new Date(),
        dueBy: new Date(Date.now() + 7 * 86400000),
      })
      .returning();
    disputeId = disputeRow.id;
  }, 60000);

  afterAll(async () => {
    const db = dbConn?.db;
    if (db && orderId) {
      try {
        // Evidence records are immutable (triggers prevent UPDATE/DELETE), bypass for cleanup
        await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);
        await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, orderId));
        await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);

        // Clean up evidence bundles
        if (disputeId) {
          await db.delete(evidenceBundle).where(eq(evidenceBundle.disputeId, disputeId));
          await db.delete(dispute).where(eq(dispute.id, disputeId));
        }
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

  // ---- Auto-collection: tracking_history ----

  it("should auto-collect tracking_history evidence for each shipment event", async () => {
    const db = dbConn.db;

    const records = await findEvidenceByOrderId(db, orderId);
    const trackingRecords = records.filter((r) => r.type === "tracking_history");

    // 2 tracking events stored (in_transit + delivered)
    expect(trackingRecords.length).toBe(2);
    expect(trackingRecords.every((r) => r.shipmentId === shipmentId)).toBe(true);

    // Verify concrete content of each tracking record
    for (const rec of trackingRecords) {
      expect(rec.orderId).toBe(orderId);
      expect(rec.textContent).not.toBeNull();
      const content = JSON.parse(rec.textContent!);
      expect(typeof content.providerEventId).toBe("string");
      expect(typeof content.status).toBe("string");
      expect(typeof content.description).toBe("string");
      expect(["in_transit", "delivered"]).toContain(content.status);
    }
  });

  // ---- Auto-collection: delivery_proof ----

  it("should auto-collect delivery_proof evidence only on delivered status", async () => {
    const db = dbConn.db;

    const records = await findEvidenceByOrderId(db, orderId);
    const deliveryRecords = records.filter((r) => r.type === "delivery_proof");

    expect(deliveryRecords.length).toBe(1);
    expect(deliveryRecords[0].shipmentId).toBe(shipmentId);
    expect(deliveryRecords[0].orderId).toBe(orderId);

    const content = JSON.parse(deliveryRecords[0].textContent!);
    expect(content.description).toBe("Package was delivered");
    expect(content.providerEventId).toBe(`trk_delivered_${ts}`);
    expect(typeof content.deliveredAt).toBe("string");
  });

  // ---- Auto-collection: customer_communication ----

  it("should auto-collect customer_communication evidence on ticket message", async () => {
    const db = dbConn.db;

    const records = await findEvidenceByOrderId(db, orderId);
    const commRecords = records.filter((r) => r.type === "customer_communication");

    expect(commRecords.length).toBe(1);
    expect(commRecords[0].supportTicketId).toBe(ticketId);
    expect(commRecords[0].orderId).toBe(orderId);

    const content = JSON.parse(commRecords[0].textContent!);
    expect(content.body).toBe("I have a question about my order");
    expect(content.authorType).toBe("customer");
    expect(typeof content.messageId).toBe("string");
  });

  // ---- Auto-collection: payment_receipt ----

  it("should auto-collect payment_receipt evidence on payment event", async () => {
    const db = dbConn.db;

    const records = await findEvidenceByOrderId(db, orderId);
    const paymentRecords = records.filter((r) => r.type === "payment_receipt");

    expect(paymentRecords.length).toBe(1);
    expect(paymentRecords[0].paymentId).toBe(paymentId);
    expect(paymentRecords[0].orderId).toBe(orderId);

    const content = JSON.parse(paymentRecords[0].textContent!);
    expect(content.eventType).toBe("payment_intent.succeeded");
    expect(content.providerEventId).toBe(`evt_evidence_test_${ts}`);
    expect(typeof content.paymentEventId).toBe("string");
  });

  // ---- Auto-collection: policy_acceptance ----

  it("should auto-collect policy_acceptance evidence for each acknowledged policy", async () => {
    const db = dbConn.db;

    const records = await findEvidenceByOrderId(db, orderId);
    const policyRecords = records.filter((r) => r.type === "policy_acceptance");

    // 4 policy types acknowledged
    expect(policyRecords.length).toBe(4);
    for (const rec of policyRecords) {
      expect(rec.orderId).toBe(orderId);
      expect(rec.textContent).not.toBeNull();
      const content = JSON.parse(rec.textContent!);
      expect(typeof content.acknowledgmentId).toBe("string");
      expect(typeof content.policySnapshotId).toBe("string");
      expect(typeof content.acknowledgedAt).toBe("string");
    }
  });

  // ---- All 5 evidence types present ----

  it("should have all 5 evidence types collected for a complete order lifecycle", async () => {
    const db = dbConn.db;

    const records = await findEvidenceByOrderId(db, orderId);
    const types = new Set(records.map((r) => r.type));

    expect(types.has("tracking_history")).toBe(true);
    expect(types.has("delivery_proof")).toBe(true);
    expect(types.has("customer_communication")).toBe(true);
    expect(types.has("payment_receipt")).toBe(true);
    expect(types.has("policy_acceptance")).toBe(true);
    expect(types.size).toBe(5);

    // Total evidence count: 2 tracking + 1 delivery + 1 communication + 1 payment + 4 policies = 9
    expect(records.length).toBe(9);
  });

  // ---- Readiness summary ----

  it("should compute complete readiness when all evidence types are present", async () => {
    const db = dbConn.db;

    const records = await findEvidenceByOrderId(db, orderId);
    const readiness = computeReadinessSummary(records);

    expect(readiness.complete).toBe(true);
    expect(readiness.missing_types).toEqual([]);
    expect(readiness.tracking_history_present).toBe(true);
    expect(readiness.delivery_proof_present).toBe(true);
    expect(readiness.customer_communication_present).toBe(true);
    expect(readiness.policy_acceptance_present).toBe(true);
    expect(readiness.payment_receipt_present).toBe(true);
  });

  it("should report incomplete readiness when evidence types are missing", () => {
    // Simulate partial evidence (only tracking + delivery)
    const partial = [
      { type: "tracking_history" } as { type: string },
      { type: "delivery_proof" } as { type: string },
    ];
    const readiness = computeReadinessSummary(partial as any);

    expect(readiness.complete).toBe(false);
    expect(readiness.tracking_history_present).toBe(true);
    expect(readiness.delivery_proof_present).toBe(true);
    expect(readiness.customer_communication_present).toBe(false);
    expect(readiness.policy_acceptance_present).toBe(false);
    expect(readiness.payment_receipt_present).toBe(false);
    expect(readiness.missing_types).toEqual([
      "customer_communication",
      "policy_acceptance",
      "payment_receipt",
    ]);
  });

  // ---- Evidence bundle generation (dispute → bundle) ----

  it("should generate evidence bundle for a dispute with complete evidence", async () => {
    const db = dbConn.db;

    const result = await generateEvidenceBundle(db, disputeId);

    expect(result.bundleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.disputeId).toBe(disputeId);
    expect(result.evidenceCount).toBe(9);
    expect(result.readiness.complete).toBe(true);
    expect(result.readiness.missing_types).toEqual([]);
    expect(result.storageKey).toMatch(/^evidence-bundles\//);
    expect(result.storageKey).toContain(disputeId);
  });

  it("should keep evidence bundle size within Stripe limit", async () => {
    const db = dbConn.db;

    const result = (await generateEvidenceBundle(db, disputeId)) as any;
    // Stripe evidence limit is ~10MB; our JSON bundles should be far under
    const bundleJson = JSON.stringify(result._content);
    const bundleSizeBytes = Buffer.byteLength(bundleJson, "utf-8");

    // Bundle should exist and be non-trivial
    expect(bundleSizeBytes).toBeGreaterThan(100);
    // Must be under Stripe's 10MB evidence size limit
    expect(bundleSizeBytes).toBeLessThan(10 * 1024 * 1024);
  });

  // ---- Idempotency ----

  it("should produce equivalent bundles when generated twice for the same dispute", async () => {
    const db = dbConn.db;

    const first = await generateEvidenceBundle(db, disputeId);
    const second = await generateEvidenceBundle(db, disputeId);

    // Same evidence count and readiness
    expect(second.evidenceCount).toBe(first.evidenceCount);
    expect(second.readiness.complete).toBe(first.readiness.complete);
    expect(second.readiness.missing_types).toEqual(first.readiness.missing_types);
    expect(second.disputeId).toBe(first.disputeId);

    // Different bundle IDs (each generation creates a new bundle record)
    expect(second.bundleId).not.toBe(first.bundleId);
  });

  // ---- Error path: dispute not found ----

  it("should reject bundle generation for non-existent dispute", async () => {
    const db = dbConn.db;
    const fakeDisputeId = "00000000-0000-0000-0000-000000000000";

    await expect(generateEvidenceBundle(db, fakeDisputeId)).rejects.toMatchObject({
      code: "ERR_DISPUTE_NOT_FOUND",
    });
  });

  // ---- Immutability: UPDATE blocked ----

  it("should prevent UPDATE on evidence_record (immutability trigger)", async () => {
    const db = dbConn.db;

    const records = await findEvidenceByOrderId(db, orderId);
    expect(records.length).toBeGreaterThan(0);
    const record = records[0];

    await expect(
      db
        .update(evidenceRecord)
        .set({ textContent: "tampered" })
        .where(eq(evidenceRecord.id, record.id)),
    ).rejects.toThrow(/evidence_record/);
  });

  // ---- Immutability: DELETE blocked ----

  it("should prevent DELETE on evidence_record (immutability trigger)", async () => {
    const db = dbConn.db;

    const records = await findEvidenceByOrderId(db, orderId);
    expect(records.length).toBeGreaterThan(0);
    const record = records[0];

    await expect(
      db.delete(evidenceRecord).where(eq(evidenceRecord.id, record.id)),
    ).rejects.toThrow(/evidence_record/);
  });
});
