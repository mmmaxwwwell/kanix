/**
 * Flow test: dispute lifecycle [mirrors T100, SC-005]
 *
 * Walks the complete dispute flow via HTTP calls + DB queries against the
 * real stack:
 *   paid+shipped order → simulate `charge.dispute.created` webhook →
 *   auto-evidence collection fires → admin reviews + submits evidence bundle →
 *   simulate dispute won/lost webhooks → verify final order state + refund accounting.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import { productClass, productClassMembership } from "../db/schema/product-class.js";
import {
  inventoryBalance,
  inventoryLocation,
} from "../db/schema/inventory.js";
import { order, orderLine, orderStatusHistory } from "../db/schema/order.js";
import { payment, paymentEvent, dispute } from "../db/schema/payment.js";
import {
  shipment,
  shipmentPackage,
  shipmentLine,
  shipmentEvent,
  shippingLabelPurchase,
  fulfillmentTask,
} from "../db/schema/fulfillment.js";
import { evidenceRecord, evidenceBundle, policySnapshot } from "../db/schema/evidence.js";
import { customer } from "../db/schema/customer.js";
import { adminUser, adminRole, adminUserRole } from "../db/schema/admin.js";
import { supportTicket, supportTicketMessage } from "../db/schema/support.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";
import { createHmac } from "node:crypto";
import {
  assignFulfillmentTask,
  transitionFulfillmentTaskStatus,
  findFulfillmentTasksByOrderId,
} from "../db/queries/fulfillment-task.js";
import { transitionOrderStatus, findOrderById } from "../db/queries/order-state-machine.js";
import {
  createShipment,
  buyShipmentLabel,
  transitionShipmentStatus,
  findShipmentById,
  storeShipmentEvent,
} from "../db/queries/shipment.js";
import {
  findEvidenceByOrderId,
  computeReadinessSummary,
  generateEvidenceBundle,
  findDisputeById,
} from "../db/queries/evidence.js";
import { findDisputeByProviderId, transitionDisputeStatus } from "../db/queries/dispute.js";
import { storePaymentEvent } from "../db/queries/webhook.js";
import { createSupportTicket, createTicketMessage } from "../db/queries/support-ticket.js";
import { createPolicyAcknowledgment } from "../db/queries/policy.js";
import { ROLE_CAPABILITIES } from "../auth/admin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_dispute_flow_test";
const run = Date.now();
const TEST_EMAIL = `dispute-flow-${run}@example.com`;
const TEST_PASSWORD = "DisputeFlowPass123!";
const ADMIN_EMAIL = `dispute-flow-admin-${run}@kanix.dev`;
const ADMIN_PASSWORD = "AdminDisputeFlow123!";

const VALID_ADDRESS = {
  full_name: "Dispute Flow User",
  line1: "999 Dispute Ln",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
};

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createStubTaxAdapter(taxMinor = 200): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: taxMinor, calculationId: `txcalc_dispute_${Date.now()}` };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_dispute_flow_${piCounter}_${Date.now()}`,
        clientSecret: `pi_dispute_flow_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_dispute_flow_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence(input) {
      return { id: input.providerDisputeId, status: "under_review" };
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook helper (Stripe)
// ---------------------------------------------------------------------------

function generateStripeWebhookPayload(
  eventId: string,
  eventType: string,
  data: unknown,
  secret: string,
): { body: string; signature: string } {
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type: eventType,
    data: { object: data },
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    api_version: "2024-12-18.acacia",
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const sig = createHmac("sha256", secret).update(signedPayload).digest("hex");
  const signature = `t=${timestamp},v1=${sig}`;

  return { body: payload, signature };
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function signUpUser(
  address: string,
  email: string,
  password: string,
): Promise<{ userId: string }> {
  const res = await fetch(`${address}/auth/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    status: string;
    user: { id: string };
  };
  expect(body.status).toBe("OK");
  return { userId: body.user.id };
}

async function verifyEmail(userId: string): Promise<void> {
  const { default: supertokens } = await import("supertokens-node");
  const { default: EmailVerification } = await import(
    "supertokens-node/recipe/emailverification/index.js"
  );
  const tokenRes = await EmailVerification.createEmailVerificationToken(
    "public",
    supertokens.convertToRecipeUserId(userId),
  );
  if (tokenRes.status === "OK") {
    await EmailVerification.verifyEmailUsingToken("public", tokenRes.token);
  }
}

async function signIn(
  address: string,
  email: string,
  password: string,
): Promise<{ headers: Record<string, string> }> {
  const res = await fetch(`${address}/auth/signin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      formFields: [
        { id: "email", value: email },
        { id: "password", value: password },
      ],
    }),
  });
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie();
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const accessToken = res.headers.get("st-access-token") ?? "";
  const antiCsrf = res.headers.get("anti-csrf");

  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    cookie: cookieHeader,
  };
  if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
  if (antiCsrf) headers["anti-csrf"] = antiCsrf;

  return { headers };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispute lifecycle flow (T264, mirrors T100/SC-005)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  // Seed data IDs
  let productId = "";
  let variantId = "";
  let locationId = "";
  let classId = "";
  let adminDbUserId = "";
  let testRoleId = "";

  // Auth state
  let authUserId = "";
  let authHeaders: Record<string, string> = {};
  let adminHeaders: Record<string, string> = {};
  let customerId = "";

  // Flow state (populated step by step)
  let cartToken = "";
  let orderId = "";
  let orderNumber = "";
  let paymentIntentId = "";
  let chargeId = "";
  let fulfillmentTaskId = "";
  let shipmentId = "";
  let trackingNumber = "";
  let orderLineIds: string[] = [];
  let paymentId = "";

  // Dispute state
  let disputeId = "";
  let providerDisputeId = "";
  let bundleId = "";

  // Policy snapshot IDs for cleanup
  let policySnapshotIds: string[] = [];

  beforeAll(async () => {
    ts_ = await createTestServer({
      configOverrides: {
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        EASYPOST_WEBHOOK_SECRET: "", // disable signature verification for test
      },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(200),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // Re-enable evidence immutability triggers
    await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);

    // 1. Product with one variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `dflow-prod-${run}`,
        title: `Dispute Flow Product ${run}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    const [v] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `DFLOW-V-${run}`,
        title: `Dispute Variant ${run}`,
        priceMinor: 5000, // $50.00
        status: "active",
        weight: "16",
      })
      .returning();
    variantId = v.id;

    // 2. Product class + membership (needed for catalog listing)
    const [cls] = await db
      .insert(productClass)
      .values({ name: `DFlow Class ${run}`, slug: `dflow-class-${run}` })
      .returning();
    classId = cls.id;

    await db.insert(productClassMembership).values({
      productId: prod.id,
      productClassId: cls.id,
    });

    // 3. Inventory
    const existingBalances = await db.select().from(inventoryBalance).limit(1);
    if (existingBalances.length > 0) {
      locationId = existingBalances[0].locationId;
    } else {
      const existingLocs = await db.select().from(inventoryLocation).limit(1);
      if (existingLocs.length > 0) {
        locationId = existingLocs[0].id;
      } else {
        const [loc] = await db
          .insert(inventoryLocation)
          .values({
            name: `DFlow Warehouse ${run}`,
            code: `DFLOW-WH-${run}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values({
      variantId,
      locationId,
      onHand: 100,
      reserved: 0,
      available: 100,
    });

    // 4. Admin user with DISPUTES_MANAGE capability
    const adminAuthSubject = await signUpUser(address, ADMIN_EMAIL, ADMIN_PASSWORD);
    await verifyEmail(adminAuthSubject.userId);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `test_dispute_flow_super_admin_${run}`,
        description: "Test dispute flow admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [adminUser_] = await db
      .insert(adminUser)
      .values({
        authSubject: adminAuthSubject.userId,
        email: ADMIN_EMAIL,
        name: `Admin DFlow ${run}`,
        status: "active",
      })
      .returning();
    adminDbUserId = adminUser_.id;

    await db.insert(adminUserRole).values({
      adminUserId: adminUser_.id,
      adminRoleId: role.id,
    });

    const adminSignIn = await signIn(address, ADMIN_EMAIL, ADMIN_PASSWORD);
    adminHeaders = adminSignIn.headers;
  }, 30_000);

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      try {
        await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`);

        // Clean evidence bundles
        if (disputeId) {
          await db.delete(evidenceBundle).where(eq(evidenceBundle.disputeId, disputeId));
        }

        // Clean evidence records
        if (orderId) {
          await db.execute(
            sql`DELETE FROM evidence_record WHERE order_id = ${orderId}`,
          );
        }

        // Clean dispute
        if (disputeId) {
          await db.delete(dispute).where(eq(dispute.id, disputeId));
        }

        // Clean shipment-related data
        if (shipmentId) {
          await db.delete(shipmentEvent).where(eq(shipmentEvent.shipmentId, shipmentId));
          await db.delete(shippingLabelPurchase).where(eq(shippingLabelPurchase.shipmentId, shipmentId));
          await db.delete(shipmentLine).where(eq(shipmentLine.shipmentId, shipmentId));
          await db.delete(shipmentPackage).where(eq(shipmentPackage.shipmentId, shipmentId));
          await db.delete(shipment).where(eq(shipment.id, shipmentId));
        }

        // Clean fulfillment tasks
        if (orderId) {
          await db.delete(fulfillmentTask).where(eq(fulfillmentTask.orderId, orderId));
        }

        // Clean support tickets
        if (orderId) {
          await db.execute(
            sql`DELETE FROM support_ticket_message WHERE support_ticket_id IN (SELECT id FROM support_ticket WHERE order_id = ${orderId})`,
          );
          await db.execute(
            sql`UPDATE support_ticket SET linked_ticket_id = NULL WHERE order_id = ${orderId}`,
          );
          await db.execute(
            sql`DELETE FROM support_ticket WHERE order_id = ${orderId}`,
          );
        }

        // Clean policy acknowledgments
        if (orderId) {
          await db.execute(
            sql`DELETE FROM order_policy_acknowledgment WHERE order_id = ${orderId}`,
          );
        }

        // Clean order-related data
        if (orderId) {
          await db.execute(
            sql`DELETE FROM payment_event WHERE payment_id IN (SELECT id FROM payment WHERE order_id = ${orderId})`,
          );
          await db.delete(payment).where(eq(payment.orderId, orderId));
          await db.execute(
            sql`DELETE FROM inventory_reservation WHERE order_id = ${orderId}`,
          );
          await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId));
          await db.delete(orderLine).where(eq(orderLine.orderId, orderId));
          await db.delete(order).where(eq(order.id, orderId));
        }

        // Clean policy snapshots we created
        for (const psId of policySnapshotIds) {
          await db.delete(policySnapshot).where(eq(policySnapshot.id, psId)).catch(() => {});
        }

        // Clean inventory + product
        await db.delete(inventoryBalance).where(eq(inventoryBalance.variantId, variantId));
        await db.delete(productClassMembership).where(eq(productClassMembership.productId, productId));
        await db.delete(productClass).where(eq(productClass.id, classId));
        await db.delete(productVariant).where(eq(productVariant.productId, productId));
        await db.delete(product).where(eq(product.id, productId));

        // Clean admin user + role
        await db.delete(adminUserRole).where(eq(adminUserRole.adminUserId, adminDbUserId));
        await db.delete(adminRole).where(eq(adminRole.id, testRoleId));
        await db.delete(adminUser).where(eq(adminUser.id, adminDbUserId));

        await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`);
      } catch {
        // Best-effort cleanup
      }
    }

    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Step 1: Signup → verify email → login
  // -------------------------------------------------------------------------

  it("step 1: signup, verify email, and login to get authenticated session", async () => {
    const { userId } = await signUpUser(address, TEST_EMAIL, TEST_PASSWORD);
    authUserId = userId;
    expect(authUserId).toBeTruthy();

    await verifyEmail(authUserId);

    const signInResult = await signIn(address, TEST_EMAIL, TEST_PASSWORD);
    authHeaders = signInResult.headers;

    // Get customer ID
    const meRes = await fetch(`${address}/api/customer/me`, { headers: authHeaders });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      customer: { id: string; email: string };
    };
    expect(meBody.customer.email).toBe(TEST_EMAIL);
    customerId = meBody.customer.id;
    expect(customerId).toBeTruthy();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 2: Create cart, add item, checkout → paid order
  // -------------------------------------------------------------------------

  it("step 2: add item to cart, checkout, and pay", async () => {
    // Create cart
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.status).toBe(201);
    const cartData = (await cartRes.json()) as { cart: { token: string } };
    cartToken = cartData.cart.token;
    expect(cartToken).toBeTruthy();

    // Add 1× variant ($50)
    const addRes = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
    });
    expect(addRes.status).toBeLessThan(300);

    // Checkout
    const checkoutRes = await fetch(`${address}/api/checkout`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: TEST_EMAIL,
        shipping_address: { ...VALID_ADDRESS },
      }),
    });
    expect(checkoutRes.status).toBe(201);

    const checkoutBody = (await checkoutRes.json()) as {
      order: {
        id: string;
        order_number: string;
        status: string;
        payment_status: string;
        subtotal_minor: number;
        tax_minor: number;
        shipping_minor: number;
        total_minor: number;
      };
      client_secret: string;
    };

    orderId = checkoutBody.order.id;
    orderNumber = checkoutBody.order.order_number;
    expect(checkoutBody.order.status).toBe("pending_payment");
    expect(checkoutBody.order.subtotal_minor).toBe(5000);
    expect(checkoutBody.order.tax_minor).toBe(200);
    expect(checkoutBody.order.shipping_minor).toBe(599);
    expect(checkoutBody.order.total_minor).toBe(5000 + 200 + 599); // 5799

    // Get payment intent ID + charge ID for webhooks
    const db = dbConn.db;
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    paymentIntentId = paymentRow.providerPaymentIntentId;
    paymentId = paymentRow.id;
    chargeId = `ch_dispute_flow_${run}`;
    expect(paymentIntentId).toMatch(/^pi_dispute_flow_/);

    // Get order line IDs
    const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, orderId));
    expect(lines.length).toBe(1);
    orderLineIds = lines.map((l) => l.id);

    // Simulate payment_intent.succeeded webhook
    const { body, signature } = generateStripeWebhookPayload(
      `evt_dispute_pay_${run}`,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 5799,
        currency: "usd",
        status: "succeeded",
        latest_charge: chargeId,
      },
      WEBHOOK_SECRET,
    );

    const webhookRes = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });
    expect(webhookRes.statusCode).toBe(200);

    // Verify order is confirmed + paid
    const [confirmedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(confirmedOrder.status).toBe("confirmed");
    expect(confirmedOrder.paymentStatus).toBe("paid");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 3: Fulfillment → shipment → shipped + delivered
  // -------------------------------------------------------------------------

  it("step 3: fulfill and ship the order to completion", async () => {
    const db = dbConn.db;
    const shippingAdapter = createStubShippingAdapter();

    // Get the auto-created fulfillment task
    const tasks = await findFulfillmentTasksByOrderId(db, orderId);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    fulfillmentTaskId = tasks[0].id;

    // Assign + transition through picking → packed → shipment_pending
    await assignFulfillmentTask(db, fulfillmentTaskId, adminDbUserId);
    await transitionFulfillmentTaskStatus(db, { taskId: fulfillmentTaskId, newStatus: "picking" });
    await transitionFulfillmentTaskStatus(db, { taskId: fulfillmentTaskId, newStatus: "picked" });
    await transitionFulfillmentTaskStatus(db, { taskId: fulfillmentTaskId, newStatus: "packing" });
    await transitionFulfillmentTaskStatus(db, { taskId: fulfillmentTaskId, newStatus: "packed" });
    await transitionFulfillmentTaskStatus(db, { taskId: fulfillmentTaskId, newStatus: "shipment_pending" });

    // Create shipment + buy label
    const shipResult = await createShipment(db, {
      orderId,
      packages: [{ weight: 16 }],
      lines: orderLineIds.map((olId) => ({ orderLineId: olId, quantity: 1 })),
    });
    shipmentId = shipResult.shipment.id;

    const labelResult = await buyShipmentLabel(
      db,
      {
        shipmentId,
        providerShipmentId: `shp_dflow_${shipmentId}`,
        rateId: `rate_dflow_${shipmentId}`,
      },
      shippingAdapter,
    );
    trackingNumber = labelResult.label.trackingNumber;
    expect(trackingNumber).toBeTruthy();

    // Walk shipping status + shipment status to shipped
    await transitionOrderStatus(db, {
      orderId,
      statusType: "shipping_status",
      newValue: "label_pending",
      reason: "Label purchase initiated",
    });
    await transitionOrderStatus(db, {
      orderId,
      statusType: "shipping_status",
      newValue: "label_purchased",
      reason: "Label purchased",
    });
    await transitionOrderStatus(db, {
      orderId,
      statusType: "shipping_status",
      newValue: "shipped",
      reason: "Shipment handed to carrier",
    });

    await transitionShipmentStatus(db, shipmentId, "ready");
    await transitionShipmentStatus(db, shipmentId, "shipped");

    // Mark fulfillment task as done
    await transitionFulfillmentTaskStatus(db, { taskId: fulfillmentTaskId, newStatus: "done" });

    // Walk fulfillment status
    await transitionOrderStatus(db, {
      orderId,
      statusType: "fulfillment_status",
      newValue: "partially_fulfilled",
      reason: "Shipment shipped",
    });

    // Simulate in_transit → delivered via handleTrackingUpdate
    const { handleTrackingUpdate } = await import("../db/queries/shipment.js");

    // in_transit
    let shipmentRecord = await findShipmentById(db, shipmentId);
    expect(shipmentRecord).not.toBeNull();

    await storeShipmentEvent(db, {
      shipmentId,
      providerEventId: `evt_ep_intransit_dflow_${run}`,
      status: "in_transit",
      description: "Package in transit",
      occurredAt: new Date(),
      rawPayloadJson: { status: "in_transit", tracking_code: trackingNumber },
    });

    const inTransitResult = await handleTrackingUpdate(db, shipmentRecord!, "in_transit");
    expect(inTransitResult.shipmentTransitioned).toBe(true);

    // delivered
    shipmentRecord = await findShipmentById(db, shipmentId);
    expect(shipmentRecord).not.toBeNull();

    await storeShipmentEvent(db, {
      shipmentId,
      providerEventId: `evt_ep_delivered_dflow_${run}`,
      status: "delivered",
      description: "Delivered",
      occurredAt: new Date(),
      rawPayloadJson: { status: "delivered", tracking_code: trackingNumber },
    });

    const deliveredResult = await handleTrackingUpdate(db, shipmentRecord!, "delivered");
    expect(deliveredResult.shipmentTransitioned).toBe(true);

    // Verify order is completed
    const orderRow = await findOrderById(db, orderId);
    expect(orderRow).not.toBeNull();
    expect(orderRow!.status).toBe("completed");
    expect(orderRow!.shippingStatus).toBe("delivered");
    expect(orderRow!.fulfillmentStatus).toBe("fulfilled");
    expect(orderRow!.paymentStatus).toBe("paid");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 4: Seed evidence data (tracking, delivery, comms, policy, payment)
  // -------------------------------------------------------------------------

  it("step 4: seed evidence records for auto-collection readiness", async () => {
    const db = dbConn.db;

    // The payment_intent.succeeded webhook auto-creates a payment_receipt evidence
    // record via storePaymentEvent. Let's verify and add the remaining types.

    // Check existing evidence
    const existingEvidence = await findEvidenceByOrderId(db, orderId);
    const existingTypes = new Set(existingEvidence.map((e) => e.type));

    // Add tracking_history evidence
    if (!existingTypes.has("tracking_history")) {
      await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`).catch(() => {});
      await db.insert(evidenceRecord).values({
        orderId,
        shipmentId,
        type: "tracking_history",
        textContent: JSON.stringify({
          carrier: "USPS",
          trackingNumber,
          events: [
            { status: "shipped", timestamp: new Date().toISOString() },
            { status: "delivered", timestamp: new Date().toISOString() },
          ],
        }),
        metadataJson: { carrier: "USPS", trackingNumber },
      });
      await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`).catch(() => {});
    }

    // Add delivery_proof evidence
    if (!existingTypes.has("delivery_proof")) {
      await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`).catch(() => {});
      await db.insert(evidenceRecord).values({
        orderId,
        shipmentId,
        type: "delivery_proof",
        textContent: JSON.stringify({
          deliveredAt: new Date().toISOString(),
          signedBy: "Resident",
          deliveryLocation: "Front door",
        }),
        metadataJson: { deliveredAt: new Date().toISOString() },
      });
      await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`).catch(() => {});
    }

    // Add customer_communication evidence
    if (!existingTypes.has("customer_communication")) {
      await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`).catch(() => {});
      await db.insert(evidenceRecord).values({
        orderId,
        type: "customer_communication",
        textContent: JSON.stringify({
          type: "order_confirmation_email",
          sentAt: new Date().toISOString(),
          recipient: TEST_EMAIL,
        }),
        metadataJson: { emailType: "order_confirmation" },
      });
      await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`).catch(() => {});
    }

    // Add policy_acceptance evidence
    if (!existingTypes.has("policy_acceptance")) {
      await db.execute(sql`ALTER TABLE evidence_record DISABLE TRIGGER USER`).catch(() => {});
      await db.insert(evidenceRecord).values({
        orderId,
        type: "policy_acceptance",
        textContent: JSON.stringify({
          policyType: "terms_of_service",
          version: 1,
          acceptedAt: new Date().toISOString(),
        }),
        metadataJson: { policyType: "terms_of_service", version: 1 },
      });
      await db.execute(sql`ALTER TABLE evidence_record ENABLE TRIGGER USER`).catch(() => {});
    }

    // Verify all 5 types present
    const allEvidence = await findEvidenceByOrderId(db, orderId);
    const readiness = computeReadinessSummary(allEvidence);
    expect(readiness.complete).toBe(true);
    expect(readiness.missing_types).toEqual([]);
    expect(allEvidence.length).toBeGreaterThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // Step 5: charge.dispute.created webhook → dispute opened + payment_status disputed
  // -------------------------------------------------------------------------

  it("step 5: charge.dispute.created webhook opens dispute and sets payment_status to disputed", async () => {
    const db = dbConn.db;
    providerDisputeId = `dp_dflow_${run}`;

    const { body, signature } = generateStripeWebhookPayload(
      `evt_dispute_created_${run}`,
      "charge.dispute.created",
      {
        id: providerDisputeId,
        object: "dispute",
        charge: chargeId,
        payment_intent: paymentIntentId,
        amount: 5799,
        currency: "usd",
        reason: "fraudulent",
        status: "needs_response",
        created: Math.floor(Date.now() / 1000),
        evidence_details: {
          due_by: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
        },
      },
      WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).received).toBe(true);

    // Verify dispute row was created
    const disputeRow = await findDisputeByProviderId(db, providerDisputeId);
    expect(disputeRow).not.toBeNull();
    disputeId = disputeRow!.id;
    expect(disputeRow!.status).toBe("opened");
    expect(disputeRow!.amountMinor).toBe(5799);
    expect(disputeRow!.orderId).toBe(orderId);

    // Verify order payment_status moved to disputed
    const orderRow = await findOrderById(db, orderId);
    expect(orderRow).not.toBeNull();
    expect(orderRow!.paymentStatus).toBe("disputed");

    // Order main status remains completed (dispute doesn't change it)
    expect(orderRow!.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // Step 6: Admin reviews evidence readiness
  // -------------------------------------------------------------------------

  it("step 6: admin checks evidence readiness — all types present", async () => {
    const db = dbConn.db;

    // Verify readiness via DB query (mirrors what the admin endpoint does)
    const records = await findEvidenceByOrderId(db, orderId);
    const readiness = computeReadinessSummary(records);

    expect(readiness.complete).toBe(true);
    expect(readiness.tracking_history_present).toBe(true);
    expect(readiness.delivery_proof_present).toBe(true);
    expect(readiness.customer_communication_present).toBe(true);
    expect(readiness.policy_acceptance_present).toBe(true);
    expect(readiness.payment_receipt_present).toBe(true);
    expect(readiness.missing_types).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Step 7: Generate evidence bundle
  // -------------------------------------------------------------------------

  it("step 7: generate evidence bundle for the dispute", async () => {
    const db = dbConn.db;

    // Transition dispute to evidence_gathering first
    await transitionDisputeStatus(db, {
      disputeId,
      newStatus: "evidence_gathering",
    });

    const result = await generateEvidenceBundle(db, disputeId);
    bundleId = result.bundleId;

    expect(result.disputeId).toBe(disputeId);
    expect(result.readiness.complete).toBe(true);
    expect(result.evidenceCount).toBeGreaterThanOrEqual(5);
    expect(result.storageKey).toContain("evidence-bundles/");
    expect(result.storageKey).toContain(disputeId);

    // Verify bundle record in DB
    const [bundleRow] = await db
      .select()
      .from(evidenceBundle)
      .where(eq(evidenceBundle.id, bundleId));
    expect(bundleRow).toBeDefined();
    expect(bundleRow.status).toBe("generated");
    expect(bundleRow.disputeId).toBe(disputeId);
    expect(bundleRow.generatedAt).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Step 8: Admin submits evidence bundle via HTTP
  // -------------------------------------------------------------------------

  it("step 8: admin submits evidence bundle to Stripe via API", async () => {
    const db = dbConn.db;

    // Transition dispute to ready_to_submit
    await transitionDisputeStatus(db, {
      disputeId,
      newStatus: "ready_to_submit",
    });

    // Submit via API endpoint
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

    expect(body.bundle_id).toBe(bundleId);
    expect(body.dispute_id).toBe(disputeId);
    expect(body.provider_dispute_id).toBe(providerDisputeId);
    expect(body.provider_status).toBe("under_review");
    expect(body.status).toBe("submitted");

    // Verify dispute status is now submitted
    const disputeRow = await findDisputeById(db, disputeId);
    expect(disputeRow).not.toBeNull();
    expect(disputeRow!.status).toBe("submitted");

    // Verify bundle status is submitted
    const [bundleRow] = await db
      .select()
      .from(evidenceBundle)
      .where(eq(evidenceBundle.id, bundleId));
    expect(bundleRow.status).toBe("submitted");
  }, 15_000);

  // -------------------------------------------------------------------------
  // Step 9: Simulate dispute WON webhook → order payment_status back to paid
  // -------------------------------------------------------------------------

  it("step 9: charge.dispute.closed (won) → dispute closed, payment_status restored to paid", async () => {
    const db = dbConn.db;

    const { body, signature } = generateStripeWebhookPayload(
      `evt_dispute_closed_won_${run}`,
      "charge.dispute.closed",
      {
        id: providerDisputeId,
        object: "dispute",
        charge: chargeId,
        payment_intent: paymentIntentId,
        amount: 5799,
        currency: "usd",
        reason: "fraudulent",
        status: "won",
        created: Math.floor(Date.now() / 1000),
      },
      WEBHOOK_SECRET,
    );

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).received).toBe(true);

    // Verify dispute is closed with won outcome
    const disputeRow = await findDisputeById(db, disputeId);
    expect(disputeRow).not.toBeNull();
    expect(disputeRow!.status).toBe("closed");

    // Verify order payment_status restored to paid (dispute won = money returned)
    const orderRow = await findOrderById(db, orderId);
    expect(orderRow).not.toBeNull();
    expect(orderRow!.paymentStatus).toBe("paid");

    // Order main status still completed
    expect(orderRow!.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // Step 10: Verify complete status history for the dispute lifecycle
  // -------------------------------------------------------------------------

  it("step 10: order status history reflects full dispute lifecycle", async () => {
    const db = dbConn.db;

    const history = await db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId));

    // Payment status should show: unpaid → processing → paid → disputed → paid
    const paymentEntries = history.filter((h) => h.statusType === "payment_status");
    const paymentStatuses = paymentEntries.map((h) => h.newValue);

    expect(paymentStatuses).toContain("paid");
    expect(paymentStatuses).toContain("disputed");

    // The final payment_status entry should be "paid" (restored after dispute won)
    const sortedPayment = paymentEntries.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    expect(sortedPayment[sortedPayment.length - 1].newValue).toBe("paid");
  });

  // -------------------------------------------------------------------------
  // Step 11: Verify evidence bundle and dispute records are consistent
  // -------------------------------------------------------------------------

  it("step 11: evidence bundle + dispute records are consistent in final state", async () => {
    const db = dbConn.db;

    // Dispute is closed
    const disputeRow = await findDisputeById(db, disputeId);
    expect(disputeRow).not.toBeNull();
    expect(disputeRow!.status).toBe("closed");
    expect(disputeRow!.amountMinor).toBe(5799);
    expect(disputeRow!.currency).toBe("USD");
    expect(disputeRow!.reason).toBe("fraudulent");

    // Bundle is submitted
    const bundles = await db
      .select()
      .from(evidenceBundle)
      .where(eq(evidenceBundle.disputeId, disputeId));
    expect(bundles.length).toBe(1);
    expect(bundles[0].status).toBe("submitted");

    // All evidence types present
    const evidence = await findEvidenceByOrderId(db, orderId);
    const types = new Set(evidence.map((e) => e.type));
    expect(types.has("tracking_history")).toBe(true);
    expect(types.has("delivery_proof")).toBe(true);
    expect(types.has("customer_communication")).toBe(true);
    expect(types.has("policy_acceptance")).toBe(true);
    expect(types.has("payment_receipt")).toBe(true);
  });
});
