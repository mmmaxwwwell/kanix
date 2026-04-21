import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { order } from "./db/schema/order.js";
import { payment, dispute } from "./db/schema/payment.js";
import { shipment } from "./db/schema/fulfillment.js";
import { supportTicket } from "./db/schema/support.js";
import { evidenceRecord } from "./db/schema/evidence.js";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { createEvidenceRecord } from "./db/queries/evidence.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

// ---------------------------------------------------------------------------
// Auth helpers (same pattern as admin-settings, refund, etc.)
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

describe("evidence browsing API (T066b)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const adminEmail = `test-evibro-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  let testRoleId: string;
  let testAdminUserId: string;
  let orderId = "";
  let orderId2 = "";
  let paymentId = "";
  let disputeId = "";
  let disputeId2 = "";
  let shipmentId = "";
  let ticketId = "";
  const createdIds: string[] = [];

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // Re-enable immutability triggers in case a prior run crashed mid-cleanup
    await db.execute(
      sql`ALTER TABLE evidence_record ENABLE TRIGGER trg_evidence_record_no_update`,
    );
    await db.execute(
      sql`ALTER TABLE evidence_record ENABLE TRIGGER trg_evidence_record_no_delete`,
    );

    // ----- Admin user with DISPUTES_READ capability (super_admin) -----
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `test_evibro_super_admin_${ts}`,
        description: "Test evidence browsing admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Evidence Browsing Admin",
        status: "active",
      })
      .returning();
    testAdminUserId = user.id;

    await db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // ----- Test data: products, orders, payments, disputes -----

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

    // 2. Two orders
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
        paymentStatus: "disputed",
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

    // 3. Two payments
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

    const [paymentRow2] = await db
      .insert(payment)
      .values({
        orderId: orderId2,
        providerPaymentIntentId: `pi_ebro_test2_${ts}`,
        amountMinor: 5000,
        currency: "USD",
        status: "succeeded",
      })
      .returning();

    // 4. Two disputes with different statuses
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

    const [disputeRow2] = await db
      .insert(dispute)
      .values({
        paymentId: paymentRow2.id,
        orderId: orderId2,
        providerDisputeId: `dp_ebro_test2_${ts}`,
        reason: "product_not_received",
        amountMinor: 5000,
        currency: "USD",
        status: "won",
        openedAt: new Date(Date.now() - 86400000),
        closedAt: new Date(),
      })
      .returning();
    disputeId2 = disputeRow2.id;

    // 5. Shipment (linked to order 1)
    const [shipmentRow] = await db
      .insert(shipment)
      .values({
        orderId,
        shipmentNumber: `SHP-EBRO-${ts}`,
        status: "delivered",
      })
      .returning();
    shipmentId = shipmentRow.id;

    // 6. Support ticket (linked to order 1)
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

    // 7. Create evidence records with various types and links

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

    // Record 6: tracking_history for order 2
    const r6 = await createEvidenceRecord(db, {
      orderId: orderId2,
      disputeId: disputeId2,
      type: "tracking_history",
      textContent: JSON.stringify({ status: "shipped", description: "Label created" }),
      metadataJson: { source: "auto" },
    });
    createdIds.push(r6.id);

    // Record 7: manual evidence for dispute 1
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
        await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);
        if (orderId) {
          await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, orderId));
        }
        if (orderId2) {
          await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, orderId2));
        }
        await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);
      } catch {
        // cleanup best-effort
      }
      try {
        // Clean up admin data
        if (testAdminUserId) {
          await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, testAdminUserId));
          await db.delete(adminUser).where(eq(adminUser.id, testAdminUserId));
        }
        if (testRoleId) {
          await db.delete(adminRole).where(eq(adminRole.id, testRoleId));
        }
      } catch {
        // cleanup best-effort
      }
    }
    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/disputes — list disputes with evidence status
  // -------------------------------------------------------------------------

  it("should list all disputes with evidence counts", async () => {
    const res = await fetch(`${address}/api/admin/disputes`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      disputes: Array<{
        id: string;
        status: string;
        amountMinor: number;
        reason: string | null;
        evidenceCount: number;
        orderId: string;
      }>;
      total: number;
    };

    expect(body.total).toBeGreaterThanOrEqual(2);

    // Find our two disputes
    const d1 = body.disputes.find((d) => d.id === disputeId);
    const d2 = body.disputes.find((d) => d.id === disputeId2);
    expect(d1).toBeDefined();
    expect(d2).toBeDefined();

    // Dispute 1 has 2 evidence records linked via disputeId (r4 + r7)
    expect(d1!.status).toBe("evidence_gathering");
    expect(d1!.amountMinor).toBe(3000);
    expect(d1!.reason).toBe("fraudulent");
    expect(d1!.evidenceCount).toBe(2);

    // Dispute 2 has 1 evidence record linked via disputeId (r6)
    expect(d2!.status).toBe("won");
    expect(d2!.amountMinor).toBe(5000);
    expect(d2!.reason).toBe("product_not_received");
    expect(d2!.evidenceCount).toBe(1);
  });

  it("should filter disputes by status", async () => {
    // Filter by evidence_gathering — should include dispute 1
    const res = await fetch(`${address}/api/admin/disputes?status=evidence_gathering`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      disputes: Array<{ id: string; status: string }>;
      total: number;
    };

    const found = body.disputes.find((d) => d.id === disputeId);
    expect(found).toBeDefined();
    expect(found!.status).toBe("evidence_gathering");
    // dispute 2 is "won", should not appear here
    expect(body.disputes.find((d) => d.id === disputeId2)).toBeUndefined();
  });

  it("should filter disputes by won status", async () => {
    const res = await fetch(`${address}/api/admin/disputes?status=won`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      disputes: Array<{ id: string; status: string }>;
      total: number;
    };

    const found = body.disputes.find((d) => d.id === disputeId2);
    expect(found).toBeDefined();
    expect(found!.status).toBe("won");
    expect(body.disputes.find((d) => d.id === disputeId)).toBeUndefined();
  });

  it("should return empty list for status with no matches", async () => {
    const res = await fetch(`${address}/api/admin/disputes?status=lost`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      disputes: Array<{ id: string }>;
      total: number;
    };

    // Our test data has no "lost" disputes
    expect(body.disputes.find((d) => d.id === disputeId)).toBeUndefined();
    expect(body.disputes.find((d) => d.id === disputeId2)).toBeUndefined();
  });

  it("should reject unauthenticated requests to disputes list", async () => {
    const res = await fetch(`${address}/api/admin/disputes`);
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/evidence — list evidence with filters (drill-down)
  // -------------------------------------------------------------------------

  it("should list evidence for a specific order via HTTP", async () => {
    const res = await fetch(`${address}/api/admin/evidence?order_id=${orderId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      evidence: Array<{
        id: string;
        orderId: string;
        type: string;
        metadataJson: unknown;
      }>;
      total: number;
    };

    // Order 1 has 6 evidence records (r1-r5 + r7)
    expect(body.total).toBe(6);
    expect(body.evidence.every((r) => r.orderId === orderId)).toBe(true);
  });

  it("should list evidence for order 2 separately", async () => {
    const res = await fetch(`${address}/api/admin/evidence?order_id=${orderId2}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      evidence: Array<{ id: string; orderId: string; type: string }>;
      total: number;
    };

    expect(body.total).toBe(1);
    expect(body.evidence[0].orderId).toBe(orderId2);
    expect(body.evidence[0].type).toBe("tracking_history");
  });

  it("should filter evidence by type", async () => {
    const res = await fetch(`${address}/api/admin/evidence?type=delivery_proof&order_id=${orderId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      evidence: Array<{ type: string; orderId: string }>;
      total: number;
    };

    expect(body.total).toBe(1);
    expect(body.evidence[0].type).toBe("delivery_proof");
    expect(body.evidence[0].orderId).toBe(orderId);
  });

  it("should filter evidence by shipment_id", async () => {
    const res = await fetch(`${address}/api/admin/evidence?shipment_id=${shipmentId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      evidence: Array<{ id: string; shipmentId: string; type: string }>;
      total: number;
    };

    // Shipment has tracking_history (r1) + delivery_proof (r2)
    expect(body.total).toBe(2);
    expect(body.evidence.every((r) => r.shipmentId === shipmentId)).toBe(true);
    const types = new Set(body.evidence.map((r) => r.type));
    expect(types.has("tracking_history")).toBe(true);
    expect(types.has("delivery_proof")).toBe(true);
  });

  it("should filter evidence by dispute_id", async () => {
    const res = await fetch(`${address}/api/admin/evidence?dispute_id=${disputeId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      evidence: Array<{ id: string; disputeId: string; type: string }>;
      total: number;
    };

    // Dispute 1 has payment_receipt (r4) + manual customer_communication (r7)
    expect(body.total).toBe(2);
    expect(body.evidence.every((r) => r.disputeId === disputeId)).toBe(true);
  });

  it("should filter evidence by ticket_id", async () => {
    const res = await fetch(`${address}/api/admin/evidence?ticket_id=${ticketId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      evidence: Array<{ id: string; supportTicketId: string; type: string }>;
      total: number;
    };

    expect(body.total).toBe(1);
    expect(body.evidence[0].supportTicketId).toBe(ticketId);
    expect(body.evidence[0].type).toBe("customer_communication");
  });

  it("should combine type and order filters", async () => {
    const res = await fetch(`${address}/api/admin/evidence?type=customer_communication&order_id=${orderId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      evidence: Array<{ type: string; orderId: string }>;
      total: number;
    };

    // Order 1 has 2 customer_communication records (auto from ticket r3 + manual r7)
    expect(body.total).toBe(2);
    expect(body.evidence.every((r) => r.type === "customer_communication")).toBe(true);
    expect(body.evidence.every((r) => r.orderId === orderId)).toBe(true);
  });

  it("should reject unauthenticated evidence list request", async () => {
    const res = await fetch(`${address}/api/admin/evidence`);
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/evidence/:id — drill-down to single record with source
  // -------------------------------------------------------------------------

  it("should return single evidence record with source metadata", async () => {
    const res = await fetch(`${address}/api/admin/evidence/${createdIds[0]}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      evidence: {
        id: string;
        type: string;
        orderId: string;
        shipmentId: string | null;
        textContent: string | null;
        metadataJson: { source: string };
        createdAt: string;
      };
      download_url: string | null;
    };

    expect(body.evidence.id).toBe(createdIds[0]);
    expect(body.evidence.type).toBe("tracking_history");
    expect(body.evidence.orderId).toBe(orderId);
    expect(body.evidence.shipmentId).toBe(shipmentId);
    expect(body.evidence.metadataJson.source).toBe("auto");
    expect(body.evidence.textContent).toBeTruthy();
    const content = JSON.parse(body.evidence.textContent!);
    expect(content.status).toBe("in_transit");
    expect(content.description).toBe("Package picked up");
    // No storageKey → no download URL
    expect(body.download_url).toBeNull();
  });

  it("should show file-based evidence with storageKey and metadata", async () => {
    // Record 7 (index 6) has a storageKey
    const res = await fetch(`${address}/api/admin/evidence/${createdIds[6]}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      evidence: {
        id: string;
        storageKey: string | null;
        metadataJson: { source: string; fileName: string; contentType: string; adminAttached: boolean };
      };
      download_url: string | null;
    };

    expect(body.evidence.id).toBe(createdIds[6]);
    expect(body.evidence.storageKey).toContain("screenshot.png");
    expect(body.evidence.metadataJson.source).toBe("manual");
    expect(body.evidence.metadataJson.adminAttached).toBe(true);
    expect(body.evidence.metadataJson.fileName).toBe("screenshot.png");
    expect(body.evidence.metadataJson.contentType).toBe("image/png");
  });

  it("should show evidence linked to a dispute with source detail", async () => {
    // Record 4 (index 3) — payment_receipt linked to dispute
    const res = await fetch(`${address}/api/admin/evidence/${createdIds[3]}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      evidence: {
        id: string;
        type: string;
        disputeId: string;
        paymentId: string;
        orderId: string;
        metadataJson: { source: string };
        textContent: string;
      };
      download_url: string | null;
    };

    expect(body.evidence.id).toBe(createdIds[3]);
    expect(body.evidence.type).toBe("payment_receipt");
    expect(body.evidence.disputeId).toBe(disputeId);
    expect(body.evidence.paymentId).toBe(paymentId);
    expect(body.evidence.orderId).toBe(orderId);
    expect(body.evidence.metadataJson.source).toBe("auto");
    const content = JSON.parse(body.evidence.textContent);
    expect(content.eventType).toBe("payment_intent.succeeded");
  });

  it("should return 404 for non-existent evidence ID", async () => {
    const res = await fetch(`${address}/api/admin/evidence/00000000-0000-0000-0000-000000000099`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_EVIDENCE_NOT_FOUND");
  });

  it("should reject unauthenticated evidence detail request", async () => {
    const res = await fetch(`${address}/api/admin/evidence/${createdIds[0]}`);
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/disputes/:id/readiness — evidence readiness for dispute
  // -------------------------------------------------------------------------

  it("should return evidence readiness for a dispute", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/readiness`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      dispute_id: string;
      readiness: {
        tracking_history_present: boolean;
        delivery_proof_present: boolean;
        customer_communication_present: boolean;
        policy_acceptance_present: boolean;
        payment_receipt_present: boolean;
        complete: boolean;
        missing_types: string[];
      };
    };

    expect(body.dispute_id).toBe(disputeId);
    // Order 1 has all 5 evidence types (r1-r5)
    expect(body.readiness.tracking_history_present).toBe(true);
    expect(body.readiness.delivery_proof_present).toBe(true);
    expect(body.readiness.customer_communication_present).toBe(true);
    expect(body.readiness.policy_acceptance_present).toBe(true);
    expect(body.readiness.payment_receipt_present).toBe(true);
    expect(body.readiness.complete).toBe(true);
    expect(body.readiness.missing_types).toEqual([]);
  });
});
