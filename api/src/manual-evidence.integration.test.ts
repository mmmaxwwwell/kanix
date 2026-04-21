import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { order } from "./db/schema/order.js";
import { payment, dispute } from "./db/schema/payment.js";
import { evidenceRecord } from "./db/schema/evidence.js";
import { requireDatabaseUrl } from "./test-helpers.js";
import {
  createEvidenceRecord,
  findEvidenceById,
  findEvidenceByOrderId,
} from "./db/queries/evidence.js";

const DATABASE_URL = requireDatabaseUrl();

describe("manual evidence attachment (T066a)", () => {
  let dbConn: DatabaseConnection;

  const ts = Date.now();
  let orderId = "";
  let paymentId = "";
  let disputeId = "";

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // 1. Product + variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `manual-evi-prod-${ts}`,
        title: `Manual Evidence Test Product ${ts}`,
        status: "active",
      })
      .returning();

    await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `MAN-EVI-VAR-${ts}`,
        title: `Manual Evidence Variant ${ts}`,
        priceMinor: 2000,
        status: "active",
        weight: "20",
      })
      .returning();

    // 2. Order
    const [orderRow] = await db
      .insert(order)
      .values({
        orderNumber: `ORD-MEVI-${ts}`,
        email: `manual-evi-${ts}@example.com`,
        status: "confirmed",
        paymentStatus: "disputed",
        subtotalMinor: 2000,
        totalMinor: 2000,
        shippingAddressSnapshotJson: {
          full_name: "Manual Evidence Test User",
          line1: "300 Main St",
          city: "Portland",
          state: "OR",
          postal_code: "97201",
          country: "US",
        },
      })
      .returning();
    orderId = orderRow.id;

    // 3. Payment
    const [paymentRow] = await db
      .insert(payment)
      .values({
        orderId,
        providerPaymentIntentId: `pi_mevi_test_${ts}`,
        amountMinor: 2000,
        currency: "USD",
        status: "succeeded",
      })
      .returning();
    paymentId = paymentRow.id;

    // 4. Dispute
    const [disputeRow] = await db
      .insert(dispute)
      .values({
        paymentId,
        orderId,
        providerDisputeId: `dp_mevi_test_${ts}`,
        reason: "fraudulent",
        amountMinor: 2000,
        currency: "USD",
        status: "evidence_gathering",
        openedAt: new Date(),
      })
      .returning();
    disputeId = disputeRow.id;
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
  // Manual evidence creation via query layer
  // -------------------------------------------------------------------------

  it("should create a manual text evidence record for a dispute", async () => {
    const db = dbConn.db;

    const record = await createEvidenceRecord(db, {
      orderId,
      disputeId,
      type: "customer_communication",
      textContent: JSON.stringify({
        note: "Customer confirmed receipt via phone call",
        callDate: "2026-04-15",
      }),
      metadataJson: {
        source: "manual",
        adminAttached: true,
      },
    });

    expect(record.id).toBeDefined();
    expect(record.orderId).toBe(orderId);
    expect(record.disputeId).toBe(disputeId);
    expect(record.type).toBe("customer_communication");
    expect(record.textContent).toBeDefined();
    expect(record.storageKey).toBeNull();

    const parsed = JSON.parse(record.textContent as string);
    expect(parsed.note).toBe("Customer confirmed receipt via phone call");

    const metadata = record.metadataJson as { source: string; adminAttached: boolean };
    expect(metadata.source).toBe("manual");
    expect(metadata.adminAttached).toBe(true);
  });

  it("should create a manual file-based evidence record with storageKey", async () => {
    const db = dbConn.db;

    const storageKey = `evidence/${disputeId}/${ts}/signed-delivery-receipt.pdf`;

    const record = await createEvidenceRecord(db, {
      orderId,
      disputeId,
      type: "delivery_proof",
      storageKey,
      metadataJson: {
        source: "manual",
        adminAttached: true,
        fileName: "signed-delivery-receipt.pdf",
        contentType: "application/pdf",
      },
    });

    expect(record.id).toBeDefined();
    expect(record.orderId).toBe(orderId);
    expect(record.disputeId).toBe(disputeId);
    expect(record.type).toBe("delivery_proof");
    expect(record.storageKey).toBe(storageKey);

    const metadata = record.metadataJson as {
      source: string;
      adminAttached: boolean;
      fileName: string;
      contentType: string;
    };
    expect(metadata.fileName).toBe("signed-delivery-receipt.pdf");
    expect(metadata.contentType).toBe("application/pdf");
  });

  // -------------------------------------------------------------------------
  // findEvidenceById
  // -------------------------------------------------------------------------

  it("should retrieve a single evidence record by ID", async () => {
    const db = dbConn.db;

    // Create a record first
    const created = await createEvidenceRecord(db, {
      orderId,
      disputeId,
      type: "tracking_history",
      textContent: JSON.stringify({ note: "Manual tracking note" }),
      metadataJson: { source: "manual", adminAttached: true },
    });

    // Retrieve it
    const found = await findEvidenceById(db, created.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.type).toBe("tracking_history");
    expect(found?.orderId).toBe(orderId);
    expect(found?.disputeId).toBe(disputeId);
  });

  it("should return null for non-existent evidence ID", async () => {
    const db = dbConn.db;
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const found = await findEvidenceById(db, fakeId);
    expect(found).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Manual evidence appears in order evidence listing
  // -------------------------------------------------------------------------

  it("should include manual evidence when listing evidence by order", async () => {
    const db = dbConn.db;
    const records = await findEvidenceByOrderId(db, orderId);

    // We created at least 3 manual evidence records in previous tests
    expect(records.length).toBeGreaterThanOrEqual(3);

    // Verify manual records are present
    const manualRecords = records.filter((r) => {
      const meta = r.metadataJson as { source?: string } | null;
      return meta?.source === "manual";
    });
    expect(manualRecords.length).toBeGreaterThanOrEqual(3);

    // Verify different types are present
    const types = new Set(manualRecords.map((r) => r.type));
    expect(types.has("customer_communication")).toBe(true);
    expect(types.has("delivery_proof")).toBe(true);
    expect(types.has("tracking_history")).toBe(true);
  });
});
