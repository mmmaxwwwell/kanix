import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseConnection } from "./db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "./db/schema/catalog.js";
import { order, orderLine } from "./db/schema/order.js";
import { payment, dispute } from "./db/schema/payment.js";
import { shipment } from "./db/schema/fulfillment.js";
import { policySnapshot, evidenceBundle, evidenceRecord } from "./db/schema/evidence.js";
import { adminUser, adminRole, adminUserRole } from "./db/schema/admin.js";
import { storeShipmentEvent } from "./db/queries/shipment.js";
import { createSupportTicket, createTicketMessage } from "./db/queries/support-ticket.js";
import { storePaymentEvent } from "./db/queries/webhook.js";
import { createPolicyAcknowledgment } from "./db/queries/policy.js";
import { ROLE_CAPABILITIES } from "./auth/admin.js";
import { createTestServer, stopTestServer, type TestServer } from "./test-server.js";
import type { PaymentAdapter } from "./services/payment-adapter.js";

// ---------------------------------------------------------------------------
// Auth helpers (same pattern as evidence-browsing, refund, etc.)
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

describe("evidence bundle submission (T066)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;
  let adminHeaders: Record<string, string>;

  const ts = Date.now();
  const adminEmail = `test-evibund-admin-${ts}@kanix.dev`;
  const adminPassword = "AdminPassword123!";

  // Controllable payment adapter for testing Stripe submission + rejection
  let submitBehavior: "success" | "reject" = "success";
  const stubPaymentAdapter: PaymentAdapter = {
    async createPaymentIntent() {
      return { id: `pi_stub_${Date.now()}`, clientSecret: `secret_${Date.now()}` };
    },
    async createRefund() {
      return { id: `re_stub_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence(input) {
      if (submitBehavior === "reject") {
        const err = new Error("Evidence submission rejected: invalid evidence format");
        (err as unknown as Record<string, string>).type = "StripeInvalidRequestError";
        throw err;
      }
      return { id: input.providerDisputeId, status: "under_review" };
    },
  };

  // IDs for the complete evidence order
  let orderId = "";
  let paymentId = "";
  let shipmentId = "";
  let disputeId = "";

  // IDs for the incomplete evidence order
  let incompleteOrderId = "";
  let incompleteDisputeId = "";
  let incompletePaymentId = "";

  let testRoleId: string;
  let testAdminUserId: string;

  beforeAll(async () => {
    ts_ = await createTestServer({
      serverOverrides: {
        paymentAdapter: stubPaymentAdapter,
      },
    });
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

    // ----- Admin user with DISPUTES_MANAGE capability (super_admin) -----
    const authSubject = await signUpUser(address, adminEmail, adminPassword);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `test_evibund_super_admin_${ts}`,
        description: "Test evidence bundle admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [user] = await db
      .insert(adminUser)
      .values({
        authSubject,
        email: adminEmail,
        name: "Test Evidence Bundle Admin",
        status: "active",
      })
      .returning();
    testAdminUserId = user.id;

    await db.insert(adminUserRole).values({ adminUserId: user.id, adminRoleId: role.id });
    adminHeaders = await signInAndGetHeaders(address, adminEmail, adminPassword);

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

    // 5. Shipment + tracking events
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

    // 6. Support ticket + message
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

    // 7. Policy acknowledgments
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
        await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);
        if (orderId) {
          await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, orderId));
        }
        if (incompleteOrderId) {
          await db.delete(evidenceRecord).where(eq(evidenceRecord.orderId, incompleteOrderId));
        }
        await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);
      } catch {
        // cleanup best-effort
      }
    }
    await stopTestServer(ts_);
  }, 30000);

  // -------------------------------------------------------------------------
  // Readiness endpoint tests
  // -------------------------------------------------------------------------

  it("GET /api/admin/disputes/:id/readiness returns complete readiness for order with all 5 evidence types", async () => {
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
    expect(body.readiness.tracking_history_present).toBe(true);
    expect(body.readiness.delivery_proof_present).toBe(true);
    expect(body.readiness.customer_communication_present).toBe(true);
    expect(body.readiness.policy_acceptance_present).toBe(true);
    expect(body.readiness.payment_receipt_present).toBe(true);
    expect(body.readiness.complete).toBe(true);
    expect(body.readiness.missing_types).toEqual([]);
  });

  it("GET /api/admin/disputes/:id/readiness returns incomplete readiness with missing types", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${incompleteDisputeId}/readiness`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dispute_id: string;
      readiness: {
        payment_receipt_present: boolean;
        tracking_history_present: boolean;
        delivery_proof_present: boolean;
        customer_communication_present: boolean;
        policy_acceptance_present: boolean;
        complete: boolean;
        missing_types: string[];
      };
    };

    expect(body.dispute_id).toBe(incompleteDisputeId);
    expect(body.readiness.payment_receipt_present).toBe(true);
    expect(body.readiness.tracking_history_present).toBe(false);
    expect(body.readiness.delivery_proof_present).toBe(false);
    expect(body.readiness.customer_communication_present).toBe(false);
    expect(body.readiness.policy_acceptance_present).toBe(false);
    expect(body.readiness.complete).toBe(false);
    expect(body.readiness.missing_types).toHaveLength(4);
    expect(body.readiness.missing_types).toContain("tracking_history");
    expect(body.readiness.missing_types).toContain("delivery_proof");
    expect(body.readiness.missing_types).toContain("customer_communication");
    expect(body.readiness.missing_types).toContain("policy_acceptance");
  });

  it("GET /api/admin/disputes/:id/readiness returns 404 for non-existent dispute", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const res = await fetch(`${address}/api/admin/disputes/${fakeId}/readiness`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_DISPUTE_NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // Bundle generation tests (via HTTP)
  // -------------------------------------------------------------------------

  it("POST /api/admin/disputes/:id/generate-bundle succeeds with complete evidence", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/generate-bundle`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle_id: string;
      dispute_id: string;
      evidence_count: number;
      storage_key: string;
      readiness: { complete: boolean; missing_types: string[] };
    };

    expect(body.dispute_id).toBe(disputeId);
    expect(body.bundle_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.evidence_count).toBeGreaterThanOrEqual(5);
    expect(body.storage_key).toContain("evidence-bundles/");
    expect(body.storage_key).toContain(disputeId);
    expect(body.readiness.complete).toBe(true);
    expect(body.readiness.missing_types).toEqual([]);

    // Verify the bundle record was created in the DB
    const db = dbConn.db;
    const [bundleRow] = await db
      .select()
      .from(evidenceBundle)
      .where(eq(evidenceBundle.id, body.bundle_id));
    expect(bundleRow).toBeDefined();
    expect(bundleRow.status).toBe("generated");
    expect(bundleRow.disputeId).toBe(disputeId);
    expect(bundleRow.generatedAt).toBeInstanceOf(Date);
    expect(bundleRow.storageKey).toBe(body.storage_key);
  });

  it("POST /api/admin/disputes/:id/generate-bundle returns 422 when evidence is incomplete", async () => {
    const res = await fetch(
      `${address}/api/admin/disputes/${incompleteDisputeId}/generate-bundle`,
      {
        method: "POST",
        headers: adminHeaders,
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      message: string;
      readiness: {
        complete: boolean;
        payment_receipt_present: boolean;
        tracking_history_present: boolean;
        missing_types: string[];
      };
    };

    expect(body.error).toBe("ERR_EVIDENCE_INCOMPLETE");
    expect(body.readiness.complete).toBe(false);
    expect(body.readiness.payment_receipt_present).toBe(true);
    expect(body.readiness.tracking_history_present).toBe(false);
    expect(body.readiness.missing_types).toContain("tracking_history");
    expect(body.readiness.missing_types).toContain("delivery_proof");
    expect(body.readiness.missing_types).toContain("customer_communication");
    expect(body.readiness.missing_types).toContain("policy_acceptance");
  });

  it("POST /api/admin/disputes/:id/generate-bundle returns 404 for non-existent dispute", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const res = await fetch(`${address}/api/admin/disputes/${fakeId}/generate-bundle`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_DISPUTE_NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // Bundle submission to Stripe tests
  // -------------------------------------------------------------------------

  it("POST /api/admin/disputes/:id/submit-bundle succeeds when bundle is generated", async () => {
    submitBehavior = "success";
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/submit-bundle`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle_id: string;
      dispute_id: string;
      provider_dispute_id: string;
      provider_status: string;
      status: string;
    };

    expect(body.dispute_id).toBe(disputeId);
    expect(body.bundle_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.provider_dispute_id).toBe(`dp_bnd_test_${ts}`);
    expect(body.provider_status).toBe("under_review");
    expect(body.status).toBe("submitted");

    // Verify the bundle record status was updated to "submitted" in the DB
    const db = dbConn.db;
    const [bundleRow] = await db
      .select()
      .from(evidenceBundle)
      .where(eq(evidenceBundle.id, body.bundle_id));
    expect(bundleRow).toBeDefined();
    expect(bundleRow.status).toBe("submitted");
  });

  it("POST /api/admin/disputes/:id/submit-bundle returns 422 when no bundle exists", async () => {
    const res = await fetch(
      `${address}/api/admin/disputes/${incompleteDisputeId}/submit-bundle`,
      {
        method: "POST",
        headers: adminHeaders,
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_NO_BUNDLE");
    expect(body.message).toMatch(/generate a bundle first/i);
  });

  it("POST /api/admin/disputes/:id/submit-bundle returns 404 for non-existent dispute", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const res = await fetch(`${address}/api/admin/disputes/${fakeId}/submit-bundle`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_DISPUTE_NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // Stripe rejection + resubmit path
  // -------------------------------------------------------------------------

  it("POST /api/admin/disputes/:id/submit-bundle captures Stripe rejection with specific error", async () => {
    // First, reset the dispute and bundle state so we can test rejection
    const db = dbConn.db;

    // Delete existing submitted bundles and re-generate a fresh one
    await db.delete(evidenceBundle).where(eq(evidenceBundle.disputeId, disputeId));

    // Reset dispute status back to evidence_gathering
    await db
      .update(dispute)
      .set({ status: "evidence_gathering" })
      .where(eq(dispute.id, disputeId));

    // Re-generate bundle
    const genRes = await fetch(`${address}/api/admin/disputes/${disputeId}/generate-bundle`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(genRes.status).toBe(200);
    const genBody = (await genRes.json()) as { bundle_id: string };
    const bundleId = genBody.bundle_id;

    // Now attempt submission with rejection behavior
    submitBehavior = "reject";
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/submit-bundle`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      message: string;
      provider_error: string;
      bundle_id: string;
    };

    expect(body.error).toBe("ERR_STRIPE_REJECTION");
    expect(body.message).toMatch(/invalid evidence format/i);
    expect(body.provider_error).toBe("StripeInvalidRequestError");
    expect(body.bundle_id).toBe(bundleId);

    // Verify bundle status was updated to "rejected" in the DB
    const [bundleRow] = await db
      .select()
      .from(evidenceBundle)
      .where(eq(evidenceBundle.id, bundleId));
    expect(bundleRow.status).toBe("failed");
  });

  it("resubmit after correction succeeds on a previously rejected bundle", async () => {
    // The previous test left the bundle in "rejected" state. Submit again with success.
    submitBehavior = "success";
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/submit-bundle`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle_id: string;
      status: string;
      provider_status: string;
    };

    expect(body.status).toBe("submitted");
    expect(body.provider_status).toBe("under_review");

    // Verify bundle status is now "submitted"
    const db = dbConn.db;
    const [bundleRow] = await db
      .select()
      .from(evidenceBundle)
      .where(eq(evidenceBundle.id, body.bundle_id));
    expect(bundleRow.status).toBe("submitted");
  });

  // -------------------------------------------------------------------------
  // Edit-locking after submission
  // -------------------------------------------------------------------------

  it("POST /api/admin/disputes/:id/evidence is blocked (409) after bundle submission", async () => {
    // At this point the dispute's bundle is "submitted" from the previous test
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "customer_communication",
        textContent: "Additional evidence after submission attempt",
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_EVIDENCE_LOCKED");
    expect(body.message).toMatch(/locked/i);
  });

  // -------------------------------------------------------------------------
  // Auth boundary
  // -------------------------------------------------------------------------

  it("unauthenticated request to generate-bundle returns 401", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/generate-bundle`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });

  it("unauthenticated request to submit-bundle returns 401", async () => {
    const res = await fetch(`${address}/api/admin/disputes/${disputeId}/submit-bundle`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(401);
  });
});
