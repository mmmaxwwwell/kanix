import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { order, orderLine } from "./db/schema/order.js";
import { payment, dispute } from "./db/schema/payment.js";
import { shipment } from "./db/schema/fulfillment.js";
import { policySnapshot, evidenceBundle } from "./db/schema/evidence.js";
import { evidenceRecord } from "./db/schema/evidence.js";
import { storeShipmentEvent } from "./db/queries/shipment.js";
import { createTicketMessage, createSupportTicket } from "./db/queries/support-ticket.js";
import { storePaymentEvent } from "./db/queries/webhook.js";
import { createPolicyAcknowledgment } from "./db/queries/policy.js";
import { requireDatabaseUrl } from "./test-helpers.js";
import {
  computeReadinessSummary,
  findEvidenceByOrderId,
  generateEvidenceBundle,
} from "./db/queries/evidence.js";

const DATABASE_URL = requireDatabaseUrl();

describe("evidence bundle generation (T066)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now();
  let orderId = "";
  let paymentId = "";
  let shipmentId = "";
  let disputeId = "";

  // A second order with incomplete evidence for testing rejection
  let incompleteOrderId = "";
  let incompleteDisputeId = "";
  let incompletePaymentId = "";

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // --- Complete evidence order ---

    // 1. Product + variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `bundle-test-prod-${ts}`,
        title: `Bundle Test Product ${ts}`,
        status: "active",
      })
      .returning();

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `BND-VAR-${ts}`,
        title: `Bundle Variant ${ts}`,
        priceMinor: 3000,
        status: "active",
        weight: "30",
      })
      .returning();

    // 2. Order
    const [orderRow] = await db
      .insert(order)
      .values({
        orderNumber: `ORD-BND-${ts}`,
        email: `bundle-test-${ts}@example.com`,
        status: "confirmed",
        paymentStatus: "disputed",
        subtotalMinor: 3000,
        totalMinor: 3000,
        shippingAddressSnapshotJson: {
          full_name: "Bundle Test User",
          line1: "100 Main St",
          city: "Portland",
          state: "OR",
          postal_code: "97201",
          country: "US",
        },
      })
      .returning();
    orderId = orderRow.id;

    await db.insert(orderLine).values({
      orderId,
      variantId: variant.id,
      skuSnapshot: `BND-VAR-${ts}`,
      titleSnapshot: `Bundle Variant ${ts}`,
      quantity: 1,
      unitPriceMinor: 3000,
      totalMinor: 3000,
    });

    // 3. Payment
    const [paymentRow] = await db
      .insert(payment)
      .values({
        orderId,
        providerPaymentIntentId: `pi_bnd_test_${ts}`,
        amountMinor: 3000,
        currency: "USD",
        status: "succeeded",
      })
      .returning();
    paymentId = paymentRow.id;

    // Payment event (triggers payment_receipt evidence)
    await storePaymentEvent(db, {
      paymentId,
      providerEventId: `evt_bnd_test_${ts}`,
      eventType: "payment_intent.succeeded",
      payloadJson: { test: true },
    });

    // 4. Dispute record
    const [disputeRow] = await db
      .insert(dispute)
      .values({
        paymentId,
        orderId,
        providerDisputeId: `dp_bnd_test_${ts}`,
        reason: "fraudulent",
        amountMinor: 3000,
        currency: "USD",
        status: "evidence_gathering",
        openedAt: new Date(),
      })
      .returning();
    disputeId = disputeRow.id;

    // 5. Shipment + tracking events (triggers tracking_history + delivery_proof)
    const [shipmentRow] = await db
      .insert(shipment)
      .values({
        orderId,
        shipmentNumber: `SHP-BND-${ts}`,
        status: "shipped",
      })
      .returning();
    shipmentId = shipmentRow.id;

    await storeShipmentEvent(db, {
      shipmentId,
      providerEventId: `trk_bnd_transit_${ts}`,
      status: "in_transit",
      description: "Package in transit",
      occurredAt: new Date(),
      rawPayloadJson: { status: "in_transit" },
    });

    await storeShipmentEvent(db, {
      shipmentId,
      providerEventId: `trk_bnd_delivered_${ts}`,
      status: "delivered",
      description: "Package delivered",
      occurredAt: new Date(),
      rawPayloadJson: { status: "delivered" },
    });

    // 6. Support ticket + message (triggers customer_communication)
    const ticket = await createSupportTicket(db, {
      orderId,
      subject: `Bundle test ticket ${ts}`,
      category: "general",
      source: "customer_app",
    });

    await createTicketMessage(db, {
      ticketId: ticket.id,
      authorType: "customer",
      body: "Question about my order for bundle test",
    });

    // 7. Policy acknowledgments (triggers policy_acceptance)
    const policyTypes = ["terms_of_service", "refund_policy", "shipping_policy", "privacy_policy"];
    for (const pType of policyTypes) {
      const [snapshot] = await db
        .insert(policySnapshot)
        .values({
          policyType: pType,
          version: (ts % 100000) + 20000,
          contentHtml: `<p>${pType} bundle test</p>`,
          contentText: `${pType} bundle test`,
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

    // --- Incomplete evidence order (only payment_receipt) ---

    const [incompleteOrderRow] = await db
      .insert(order)
      .values({
        orderNumber: `ORD-BND-INC-${ts}`,
        email: `bundle-inc-${ts}@example.com`,
        status: "confirmed",
        paymentStatus: "disputed",
        subtotalMinor: 1500,
        totalMinor: 1500,
        shippingAddressSnapshotJson: {
          full_name: "Incomplete User",
          line1: "200 Oak St",
          city: "Portland",
          state: "OR",
          postal_code: "97201",
          country: "US",
        },
      })
      .returning();
    incompleteOrderId = incompleteOrderRow.id;

    const [incompletePaymentRow] = await db
      .insert(payment)
      .values({
        orderId: incompleteOrderId,
        providerPaymentIntentId: `pi_bnd_inc_${ts}`,
        amountMinor: 1500,
        currency: "USD",
        status: "succeeded",
      })
      .returning();
    incompletePaymentId = incompletePaymentRow.id;

    // Only payment event — no shipment, no ticket, no policy
    await storePaymentEvent(db, {
      paymentId: incompletePaymentId,
      providerEventId: `evt_bnd_inc_${ts}`,
      eventType: "payment_intent.succeeded",
      payloadJson: { test: true },
    });

    const [incDisputeRow] = await db
      .insert(dispute)
      .values({
        paymentId: incompletePaymentId,
        orderId: incompleteOrderId,
        providerDisputeId: `dp_bnd_inc_${ts}`,
        reason: "product_not_received",
        amountMinor: 1500,
        currency: "USD",
        status: "evidence_gathering",
        openedAt: new Date(),
      })
      .returning();
    incompleteDisputeId = incDisputeRow.id;
  }, 60000);

  afterAll(async () => {
    const db = dbConn?.db;
    if (db) {
      try {
        // Clean up evidence bundles
        if (disputeId) {
          await db.delete(evidenceBundle).where(eq(evidenceBundle.disputeId, disputeId));
        }
        if (incompleteDisputeId) {
          await db.delete(evidenceBundle).where(eq(evidenceBundle.disputeId, incompleteDisputeId));
        }

        // Evidence records are immutable — bypass triggers for cleanup
        await db.execute(
          sql`ALTER TABLE evidence_record DISABLE TRIGGER trg_evidence_record_no_delete`,
        );
        if (orderId) {
          await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, orderId));
        }
        if (incompleteOrderId) {
          await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, incompleteOrderId));
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
  // Readiness summary tests
  // -------------------------------------------------------------------------

  it("should compute complete readiness for order with all 5 evidence types", async () => {
    const db = dbConn.db;
    const records = await findEvidenceByOrderId(db, orderId);
    const readiness = computeReadinessSummary(records);

    expect(readiness.tracking_history_present).toBe(true);
    expect(readiness.delivery_proof_present).toBe(true);
    expect(readiness.customer_communication_present).toBe(true);
    expect(readiness.policy_acceptance_present).toBe(true);
    expect(readiness.payment_receipt_present).toBe(true);
    expect(readiness.complete).toBe(true);
    expect(readiness.missing_types).toEqual([]);
  });

  it("should compute incomplete readiness showing gaps for order with partial evidence", async () => {
    const db = dbConn.db;
    const records = await findEvidenceByOrderId(db, incompleteOrderId);
    const readiness = computeReadinessSummary(records);

    expect(readiness.payment_receipt_present).toBe(true);
    expect(readiness.tracking_history_present).toBe(false);
    expect(readiness.delivery_proof_present).toBe(false);
    expect(readiness.customer_communication_present).toBe(false);
    expect(readiness.policy_acceptance_present).toBe(false);
    expect(readiness.complete).toBe(false);
    expect(readiness.missing_types).toContain("tracking_history");
    expect(readiness.missing_types).toContain("delivery_proof");
    expect(readiness.missing_types).toContain("customer_communication");
    expect(readiness.missing_types).toContain("policy_acceptance");
    expect(readiness.missing_types.length).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Bundle generation tests
  // -------------------------------------------------------------------------

  it("should generate evidence bundle when all evidence types are present", async () => {
    const db = dbConn.db;
    const result = await generateEvidenceBundle(db, disputeId);

    expect(result.bundleId).toBeDefined();
    expect(result.disputeId).toBe(disputeId);
    expect(result.evidenceCount).toBeGreaterThanOrEqual(5);
    expect(result.readiness.complete).toBe(true);
    expect(result.storageKey).toContain("evidence-bundles/");
    expect(result.storageKey).toContain(disputeId);

    // Verify the bundle record was created in the DB
    const [bundleRow] = await db
      .select()
      .from(evidenceBundle)
      .where(eq(evidenceBundle.id, result.bundleId));
    expect(bundleRow).toBeDefined();
    expect(bundleRow.status).toBe("generated");
    expect(bundleRow.disputeId).toBe(disputeId);
    expect(bundleRow.generatedAt).toBeDefined();
    expect(bundleRow.storageKey).toBe(result.storageKey);
  });

  it("should reject bundle generation when evidence is incomplete", async () => {
    const db = dbConn.db;

    await expect(generateEvidenceBundle(db, incompleteDisputeId)).rejects.toMatchObject({
      code: "ERR_EVIDENCE_INCOMPLETE",
      readiness: expect.objectContaining({
        complete: false,
        payment_receipt_present: true,
        tracking_history_present: false,
        delivery_proof_present: false,
        customer_communication_present: false,
        policy_acceptance_present: false,
      }),
    });
  });

  it("should reject bundle generation for non-existent dispute", async () => {
    const db = dbConn.db;
    const fakeId = "00000000-0000-0000-0000-000000000099";

    await expect(generateEvidenceBundle(db, fakeId)).rejects.toMatchObject({
      code: "ERR_DISPUTE_NOT_FOUND",
    });
  });

  it("readiness missing_types should list exactly the absent evidence types", async () => {
    const db = dbConn.db;

    try {
      await generateEvidenceBundle(db, incompleteDisputeId);
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      const errObj = err as { readiness: { missing_types: string[] } };
      expect(errObj.readiness.missing_types).toContain("tracking_history");
      expect(errObj.readiness.missing_types).toContain("delivery_proof");
      expect(errObj.readiness.missing_types).toContain("customer_communication");
      expect(errObj.readiness.missing_types).toContain("policy_acceptance");
      expect(errObj.readiness.missing_types).not.toContain("payment_receipt");
    }
  });
});
