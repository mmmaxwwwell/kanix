import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { order } from "./db/schema/order.js";
import { payment, dispute } from "./db/schema/payment.js";
import { evidenceRecord, evidenceBundle } from "./db/schema/evidence.js";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { adminAuditLog } from "./db/schema/admin.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";

// ---------------------------------------------------------------------------
// Auth helpers (same pattern as evidence-bundle, evidence-browsing, etc.)
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

describe("manual evidence attachment (T066a)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const adminEmail = `test-mevi-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  let orderId = "";
  let paymentId = "";
  let disputeId = "";
  let testRoleId: string;
  let testAdminUserId: string;

  // Track created evidence IDs for cleanup
  const createdEvidenceIds: string[] = [];

  beforeAll(async () => {
    ts_ = await createTestServer();
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // Re-enable immutability triggers in case a prior run crashed mid-cleanup
    await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER trg_evidence_record_no_update`);
    await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER trg_evidence_record_no_delete`);

    // ----- Admin user with DISPUTES_MANAGE capability (super_admin) -----
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `test_mevi_super_admin_${ts}`,
        description: "Test manual evidence admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Manual Evidence Admin",
        status: "active",
      })
      .returning();
    testAdminUserId = user.id;

    await db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

    // ----- Test fixtures: product → order → payment → dispute -----

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
        // Clean up evidence bundles first (FK to dispute)
        if (disputeId) {
          await db.delete(evidenceBundle).where(eq(evidenceBundle.disputeId, disputeId));
        }

        // Bypass immutability triggers for evidence record cleanup
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
    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Admin attaches manual text evidence via HTTP
  // -------------------------------------------------------------------------

  it("admin attaches text-based manual evidence to a dispute", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "customer_communication",
        textContent: JSON.stringify({
          note: "Customer confirmed receipt via phone call",
          callDate: "2026-04-15",
        }),
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      evidence: {
        id: string;
        orderId: string;
        disputeId: string;
        type: string;
        storageKey: string | null;
        textContent: string | null;
        metadataJson: { source: string; adminAttached: boolean };
      };
    };

    createdEvidenceIds.push(body.evidence.id);

    // Concrete assertions — not just toBeDefined()
    expect(body.evidence.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.evidence.orderId).toBe(orderId);
    expect(body.evidence.disputeId).toBe(disputeId);
    expect(body.evidence.type).toBe("customer_communication");
    expect(body.evidence.storageKey).toBeNull();

    // Verify text content round-trips correctly
    const parsed = JSON.parse(body.evidence.textContent as string);
    expect(parsed.note).toBe("Customer confirmed receipt via phone call");
    expect(parsed.callDate).toBe("2026-04-15");

    // Admin-added evidence tagged with actor metadata
    expect(body.evidence.metadataJson.source).toBe("manual");
    expect(body.evidence.metadataJson.adminAttached).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Admin attaches file-based evidence via HTTP
  // -------------------------------------------------------------------------

  it("admin attaches file-based manual evidence with PDF content type", async () => {
    const pdfData = Buffer.from("%PDF-1.4 fake pdf content for test").toString("base64");

    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "delivery_proof",
        fileName: "signed-delivery-receipt.pdf",
        contentType: "application/pdf",
        data: pdfData,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      evidence: {
        id: string;
        orderId: string;
        disputeId: string;
        type: string;
        storageKey: string;
        metadataJson: {
          source: string;
          adminAttached: boolean;
          fileName: string;
          contentType: string;
        };
      };
    };

    createdEvidenceIds.push(body.evidence.id);

    expect(body.evidence.orderId).toBe(orderId);
    expect(body.evidence.disputeId).toBe(disputeId);
    expect(body.evidence.type).toBe("delivery_proof");
    expect(body.evidence.storageKey).toContain(`evidence/${disputeId}/`);
    expect(body.evidence.storageKey).toContain("signed-delivery-receipt.pdf");

    // Actor tagging in metadata
    expect(body.evidence.metadataJson.source).toBe("manual");
    expect(body.evidence.metadataJson.adminAttached).toBe(true);
    expect(body.evidence.metadataJson.fileName).toBe("signed-delivery-receipt.pdf");
    expect(body.evidence.metadataJson.contentType).toBe("application/pdf");
  });

  // -------------------------------------------------------------------------
  // Rejected content types
  // -------------------------------------------------------------------------

  it("rejects evidence with disallowed content type (executable)", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "delivery_proof",
        fileName: "malware.exe",
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

  it("rejects evidence with HTML content type", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "customer_communication",
        fileName: "phishing.html",
        contentType: "text/html",
        data: Buffer.from("<html>bad</html>").toString("base64"),
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_INVALID_CONTENT_TYPE");
  });

  // -------------------------------------------------------------------------
  // Missing content validation
  // -------------------------------------------------------------------------

  it("rejects evidence without textContent or file data", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "customer_communication",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_MISSING_CONTENT");
  });

  it("rejects file upload without fileName and contentType", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "delivery_proof",
        data: Buffer.from("some file").toString("base64"),
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_MISSING_FILE_METADATA");
  });

  // -------------------------------------------------------------------------
  // Non-existent dispute → 404
  // -------------------------------------------------------------------------

  it("returns 404 when attaching evidence to non-existent dispute", async () => {
    const fakeDisputeId = "00000000-0000-0000-0000-000000000099";
    const res = await fetch(`${address}/api/admin/disputes/${fakeDisputeId}/evidence`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "customer_communication",
        textContent: "test",
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_DISPUTE_NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // Evidence locked after bundle submission
  // -------------------------------------------------------------------------

  it("rejects new evidence after bundle has been submitted", async () => {
    const db = dbConn.db;

    // Create a submitted bundle for this dispute
    const [bundle] = await db
      .insert(evidenceBundle)
      .values({
        disputeId,
        status: "submitted",
        generatedAt: new Date(),
        storageKey: `evidence-bundles/${disputeId}/submitted.json`,
        metadataJson: { evidenceCount: 1, readiness: {} },
      })
      .returning();

    try {
      const res = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "customer_communication",
          textContent: "too late",
        }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_EVIDENCE_LOCKED");
    } finally {
      // Clean up the submitted bundle to not block subsequent tests
      await db.delete(evidenceBundle).where(eq(evidenceBundle.id, bundle.id));
    }
  });

  // -------------------------------------------------------------------------
  // Evidence listing includes manual records
  // -------------------------------------------------------------------------

  it("lists evidence by dispute via GET /api/admin/evidence", async () => {
    const res = await fetch(`${address}/api/admin/evidence?dispute_id=${disputeId}`, {
      headers: adminHeaders,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidence: Array<{
        id: string;
        type: string;
        disputeId: string;
        metadataJson: { source?: string; adminAttached?: boolean } | null;
      }>;
      total: number;
    };

    expect(body.total).toBeGreaterThanOrEqual(2);

    // All records belong to our dispute
    for (const record of body.evidence) {
      expect(record.disputeId).toBe(disputeId);
    }

    // Manual records are present with correct tagging
    const manualRecords = body.evidence.filter((r) => r.metadataJson?.source === "manual");
    expect(manualRecords.length).toBeGreaterThanOrEqual(2);

    // Verify different types are present
    const types = new Set(manualRecords.map((r) => r.type));
    expect(types.has("customer_communication")).toBe(true);
    expect(types.has("delivery_proof")).toBe(true);

    // All manual records are tagged as admin-attached
    for (const record of manualRecords) {
      expect(record.metadataJson?.adminAttached).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Single evidence record retrieval
  // -------------------------------------------------------------------------

  it("retrieves a single evidence record by ID", async () => {
    const evidenceId = createdEvidenceIds[0];
    const res = await fetch(`${address}/api/admin/evidence/${evidenceId}`, {
      headers: adminHeaders,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      evidence: { id: string; type: string; orderId: string; disputeId: string };
    };

    expect(body.evidence.id).toBe(evidenceId);
    expect(body.evidence.type).toBe("customer_communication");
    expect(body.evidence.orderId).toBe(orderId);
    expect(body.evidence.disputeId).toBe(disputeId);
  });

  it("returns 404 for non-existent evidence ID", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const res = await fetch(`${address}/api/admin/evidence/${fakeId}`, {
      headers: adminHeaders,
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_EVIDENCE_NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // Removal path with audit
  // -------------------------------------------------------------------------

  it("admin removes manual evidence and audit log is created", async () => {
    // First create a new evidence record to remove
    const createRes = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "tracking_history",
        textContent: JSON.stringify({ note: "Evidence to be removed" }),
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      evidence: { id: string; type: string };
    };
    const evidenceIdToRemove = created.evidence.id;

    // Remove it
    const deleteRes = await fetch(
      `${address}/api/admin/disputes/${disputeId}/evidence/${evidenceIdToRemove}`,
      { method: "DELETE", headers: adminHeaders },
    );

    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { removed: boolean; evidenceId: string };
    expect(deleteBody.removed).toBe(true);
    expect(deleteBody.evidenceId).toBe(evidenceIdToRemove);

    // Verify the evidence record is actually gone
    const getRes = await fetch(`${address}/api/admin/evidence/${evidenceIdToRemove}`, {
      headers: adminHeaders,
    });
    expect(getRes.status).toBe(404);

    // Verify audit log entry (async hook — wait briefly)
    await new Promise((resolve) => setTimeout(resolve, 200));
    const db = dbConn.db;
    const auditEntries = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.entityId, evidenceIdToRemove));
    const auditEntry = auditEntries.find((e) => e.action === "evidence.manual_remove");

    expect(auditEntry).toBeTruthy();
    if (!auditEntry) throw new Error("auditEntry not found");
    expect(auditEntry.action).toBe("evidence.manual_remove");
    expect(auditEntry.entityType).toBe("evidence_record");
    expect(auditEntry.actorAdminUserId).toBe(testAdminUserId);
    const beforeJson = auditEntry.beforeJson as {
      disputeId: string;
      type: string;
    };
    expect(beforeJson.disputeId).toBe(disputeId);
    expect(beforeJson.type).toBe("tracking_history");
  });

  // -------------------------------------------------------------------------
  // Removal edge cases
  // -------------------------------------------------------------------------

  it("returns 404 when removing non-existent evidence", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence/${fakeId}`, {
      method: "DELETE",
      headers: adminHeaders,
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_EVIDENCE_NOT_FOUND");
  });

  it("removal is locked after bundle submission", async () => {
    const db = dbConn.db;

    // Create evidence to attempt removal of
    const createRes = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "customer_communication",
        textContent: JSON.stringify({ note: "Should not be removable" }),
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { evidence: { id: string } };
    createdEvidenceIds.push(created.evidence.id);

    // Create a submitted bundle
    const [bundle] = await db
      .insert(evidenceBundle)
      .values({
        disputeId,
        status: "submitted",
        generatedAt: new Date(),
        storageKey: `evidence-bundles/${disputeId}/submitted2.json`,
        metadataJson: { evidenceCount: 1, readiness: {} },
      })
      .returning();

    try {
      const res = await fetch(
        `${address}/api/admin/disputes/${disputeId}/evidence/${created.evidence.id}`,
        { method: "DELETE", headers: adminHeaders },
      );

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("ERR_EVIDENCE_LOCKED");
    } finally {
      await db.delete(evidenceBundle).where(eq(evidenceBundle.id, bundle.id));
    }
  });

  // -------------------------------------------------------------------------
  // Unauthenticated access → 401
  // -------------------------------------------------------------------------

  it("unauthenticated request to evidence endpoint returns 401", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        type: "customer_communication",
        textContent: "test",
      }),
    });

    expect(res.status).toBe(401);
  });
});
