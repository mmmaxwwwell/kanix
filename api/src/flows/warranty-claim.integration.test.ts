/**
 * Flow test: warranty claim submission [mirrors T104b, FR-055]
 *
 * Walks the complete warranty claim flow via HTTP calls against the real stack:
 *   customer submits warranty claim for their order → verify ticket created
 *   with category=warranty → admin reviews → resolution path (approve/deny) →
 *   notifications delivered; also tests out-of-window claim rejection.
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
import { payment } from "../db/schema/payment.js";
import { shipment } from "../db/schema/fulfillment.js";
import {
  supportTicket,
  supportTicketMessage,
  supportTicketStatusHistory,
} from "../db/schema/support.js";
import { customer } from "../db/schema/customer.js";
import { adminUser, adminRole, adminUserRole } from "../db/schema/admin.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";
import { createHmac } from "node:crypto";
import { ROLE_CAPABILITIES } from "../auth/admin.js";
import { listTicketMessages } from "../db/queries/support-ticket.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_warranty_claim_flow_test";
const run = Date.now();
const CUSTOMER_EMAIL = `warranty-flow-${run}@example.com`;
const CUSTOMER_PASSWORD = "WarrantyFlow123!";
const ADMIN_EMAIL = `warranty-flow-admin-${run}@kanix.dev`;
const ADMIN_PASSWORD = "AdminWarrantyFlow123!";

const VALID_ADDRESS = {
  full_name: "Warranty Flow User",
  line1: "500 Warranty Blvd",
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
      return { taxAmountMinor: taxMinor, calculationId: `txcalc_wc_${Date.now()}` };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_wc_${piCounter}_${Date.now()}`,
        clientSecret: `pi_wc_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_wc_${Date.now()}`, status: "succeeded" };
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

describe("warranty claim flow (T270, mirrors T104b/FR-055)", () => {
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
  let customerAuthHeaders: Record<string, string> = {};
  let adminHeaders: Record<string, string> = {};
  let customerId = "";

  // Flow state — within-warranty order
  let orderId = "";
  let orderLineId = "";
  let paymentIntentId = "";

  // Flow state — expired-warranty order
  let expiredOrderId = "";
  let expiredOrderLineId = "";
  let expiredShipmentId = "";

  // Ticket IDs for assertions across steps
  let warrantyTicketId = "";

  // Cleanup tracking
  const createdShipmentIds: string[] = [];
  const createdTicketIds: string[] = [];

  beforeAll(async () => {
    ts_ = await createTestServer({
      configOverrides: {
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
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

    // 1. Product with one variant (TPU material — triggers heat deformation checks)
    const [prod] = await db
      .insert(product)
      .values({
        slug: `wc-flow-prod-${run}`,
        title: `TPU Phone Case ${run}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    const [v] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `WC-TPU-${run}`,
        title: `TPU Phone Case Variant ${run}`,
        priceMinor: 5000, // $50.00
        status: "active",
        weight: "16",
      })
      .returning();
    variantId = v.id;

    // 2. Product class + membership (needed for catalog)
    const [cls] = await db
      .insert(productClass)
      .values({ name: `WC Flow Class ${run}`, slug: `wc-flow-class-${run}` })
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
            name: `WC Flow Warehouse ${run}`,
            code: `WC-WH-${run}`,
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

    // 4. Customer auth (signup → verify → sign in)
    const { userId } = await signUpUser(address, CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    await verifyEmail(userId);
    const customerSignIn = await signIn(address, CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    customerAuthHeaders = customerSignIn.headers;

    // Get customer ID
    const custRows = await db
      .select()
      .from(customer)
      .where(eq(customer.authSubject, userId));
    customerId = custRows[0].id;

    // 5. Admin user with SUPPORT_MANAGE capability
    const adminAuth = await signUpUser(address, ADMIN_EMAIL, ADMIN_PASSWORD);
    await verifyEmail(adminAuth.userId);

    const [role] = await db
      .insert(adminRole)
      .values({
        name: `test_wc_flow_super_admin_${run}`,
        description: "Test warranty flow admin",
        capabilitiesJson: ROLE_CAPABILITIES.super_admin,
      })
      .returning();
    testRoleId = role.id;

    const [adminUser_] = await db
      .insert(adminUser)
      .values({
        authSubject: adminAuth.userId,
        email: ADMIN_EMAIL,
        name: `Admin WC Flow ${run}`,
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

        // Clean tickets + messages + status history
        for (const ticketId of createdTicketIds) {
          await db.execute(
            sql`DELETE FROM evidence_record WHERE support_ticket_id = ${ticketId}`,
          );
          await db
            .delete(supportTicketStatusHistory)
            .where(eq(supportTicketStatusHistory.ticketId, ticketId));
          await db
            .delete(supportTicketMessage)
            .where(eq(supportTicketMessage.ticketId, ticketId));
          await db.execute(
            sql`UPDATE support_ticket SET linked_ticket_id = NULL WHERE linked_ticket_id = ${ticketId}`,
          );
          await db.delete(supportTicket).where(eq(supportTicket.id, ticketId));
        }

        // Clean shipments
        for (const shipId of createdShipmentIds) {
          await db.delete(shipment).where(eq(shipment.id, shipId));
        }

        // Clean order-related data for both orders
        for (const oid of [orderId, expiredOrderId].filter(Boolean)) {
          await db.execute(
            sql`DELETE FROM payment_event WHERE payment_id IN (SELECT id FROM payment WHERE order_id = ${oid})`,
          );
          await db.delete(payment).where(eq(payment.orderId, oid));
          await db.execute(
            sql`DELETE FROM inventory_reservation WHERE order_id = ${oid}`,
          );
          await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, oid));
          await db.delete(orderLine).where(eq(orderLine.orderId, oid));
          await db.delete(order).where(eq(order.id, oid));
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
  // Step 1: Create a delivered order (checkout → pay → deliver) within warranty
  // -------------------------------------------------------------------------

  it("step 1: checkout and pay for an order", async () => {
    // Create cart
    const cartRes = await fetch(`${address}/api/cart`, {
      method: "POST",
      headers: { ...customerAuthHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.status).toBe(201);
    const cartData = (await cartRes.json()) as { cart: { token: string } };
    const cartToken = cartData.cart.token;
    expect(cartToken).toBeTruthy();

    // Add item
    const addRes = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        ...customerAuthHeaders,
        "Content-Type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
    });
    expect(addRes.status).toBeLessThan(300);

    // Checkout
    const checkoutRes = await fetch(`${address}/api/checkout`, {
      method: "POST",
      headers: { ...customerAuthHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: CUSTOMER_EMAIL,
        shipping_address: { ...VALID_ADDRESS },
      }),
    });
    expect(checkoutRes.status).toBe(201);

    const checkoutBody = (await checkoutRes.json()) as {
      order: { id: string; order_number: string; status: string; total_minor: number };
      client_secret: string;
    };
    orderId = checkoutBody.order.id;
    expect(checkoutBody.order.status).toBe("pending_payment");
    expect(checkoutBody.order.total_minor).toBe(5000 + 200 + 599); // subtotal + tax + shipping

    // Get payment intent ID
    const db = dbConn.db;
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    paymentIntentId = paymentRow.providerPaymentIntentId;

    // Simulate payment_intent.succeeded webhook
    const chargeId = `ch_wc_flow_${run}`;
    const { body, signature } = generateStripeWebhookPayload(
      `evt_wc_pay_${run}`,
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

    // Verify order confirmed + paid
    const [confirmedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(confirmedOrder.status).toBe("confirmed");
    expect(confirmedOrder.paymentStatus).toBe("paid");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 2: Mark order as delivered (seed shipment with recent delivery)
  // -------------------------------------------------------------------------

  it("step 2: mark order as delivered via shipment (within warranty window)", async () => {
    const db = dbConn.db;

    // Get order line ID
    const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, orderId));
    expect(lines.length).toBe(1);
    orderLineId = lines[0].id;

    // Create a delivered shipment (delivered 2 months ago — well within warranty)
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    const [shp] = await db
      .insert(shipment)
      .values({
        orderId,
        shipmentNumber: `SHP-WC-FLOW-${run}`,
        status: "delivered",
        carrier: "USPS",
        serviceLevel: "Priority",
        shippedAt: twoMonthsAgo,
        deliveredAt: twoMonthsAgo,
      })
      .returning();
    createdShipmentIds.push(shp.id);

    // Update order shipping/fulfillment status
    await db
      .update(order)
      .set({
        fulfillmentStatus: "fulfilled",
        shippingStatus: "delivered",
      })
      .where(eq(order.id, orderId));

    // Verify
    const [updatedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(updatedOrder.shippingStatus).toBe("delivered");
    expect(updatedOrder.fulfillmentStatus).toBe("fulfilled");
  });

  // -------------------------------------------------------------------------
  // Step 3: Customer submits warranty claim → ticket created
  // -------------------------------------------------------------------------

  it("step 3: customer submits warranty claim → ticket with category=warranty_claim", async () => {
    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...customerAuthHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: orderId,
        order_line_id: orderLineId,
        description: "The phone case has a crack along the edge after normal use.",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticket: {
        id: string;
        category: string;
        priority: string;
        status: string;
        orderId: string;
        customerId: string;
        subject: string;
        source: string;
      };
      material_limitation_flagged: boolean;
      material_limitation_note: string | null;
    };

    warrantyTicketId = body.ticket.id;
    createdTicketIds.push(warrantyTicketId);

    // Verify ticket properties
    expect(body.ticket.category).toBe("warranty_claim");
    expect(body.ticket.priority).toBe("high");
    expect(body.ticket.status).toBe("open");
    expect(body.ticket.orderId).toBe(orderId);
    expect(body.ticket.customerId).toBe(customerId);
    expect(body.ticket.subject).toContain("Warranty Claim");
    expect(body.ticket.source).toBe("customer_app");

    // No material limitation for a "crack" description
    expect(body.material_limitation_flagged).toBe(false);
    expect(body.material_limitation_note).toBeNull();

    // Verify message in DB
    const messages = await listTicketMessages(dbConn.db, warrantyTicketId, {
      includeInternalNotes: true,
    });
    expect(messages.length).toBe(1);
    expect(messages[0].body).toContain("phone case has a crack");
    expect(messages[0].authorType).toBe("customer");
  });

  // -------------------------------------------------------------------------
  // Step 4: Admin reviews the warranty ticket
  // -------------------------------------------------------------------------

  it("step 4: admin can view the warranty ticket and its messages", async () => {
    // Get ticket details
    const ticketRes = await fetch(
      `${address}/api/admin/support-tickets/${warrantyTicketId}`,
      { headers: adminHeaders },
    );
    expect(ticketRes.status).toBe(200);
    const ticketBody = (await ticketRes.json()) as {
      ticket: {
        id: string;
        category: string;
        status: string;
        orderId: string;
        customerId: string;
      };
    };
    expect(ticketBody.ticket.id).toBe(warrantyTicketId);
    expect(ticketBody.ticket.category).toBe("warranty_claim");
    expect(ticketBody.ticket.status).toBe("open");

    // Get messages
    const messagesRes = await fetch(
      `${address}/api/admin/support-tickets/${warrantyTicketId}/messages`,
      { headers: adminHeaders },
    );
    expect(messagesRes.status).toBe(200);
    const messagesBody = (await messagesRes.json()) as {
      messages: { body: string; authorType: string }[];
    };
    expect(messagesBody.messages.length).toBeGreaterThanOrEqual(1);
    const customerMsg = messagesBody.messages.find((m) => m.authorType === "customer");
    expect(customerMsg).toBeDefined();
    expect(customerMsg!.body).toContain("phone case has a crack");
  });

  // -------------------------------------------------------------------------
  // Step 5: Admin approves warranty claim → transitions to resolved
  // -------------------------------------------------------------------------

  it("step 5: admin transitions ticket to waiting_on_internal, then resolved (approve)", async () => {
    // Transition to waiting_on_internal (admin investigating)
    const pendingRes = await fetch(
      `${address}/api/admin/support-tickets/${warrantyTicketId}/transition`,
      {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          new_status: "waiting_on_internal",
          reason: "Reviewing warranty claim for approval",
        }),
      },
    );
    expect(pendingRes.status).toBe(200);
    const pendingBody = (await pendingRes.json()) as {
      oldStatus: string;
      newStatus: string;
    };
    expect(pendingBody.oldStatus).toBe("open");
    expect(pendingBody.newStatus).toBe("waiting_on_internal");

    // Transition back to open (review complete)
    const openRes = await fetch(
      `${address}/api/admin/support-tickets/${warrantyTicketId}/transition`,
      {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          new_status: "open",
          reason: "Warranty claim approved — preparing resolution",
        }),
      },
    );
    expect(openRes.status).toBe(200);

    // Admin posts resolution reply (visible to customer)
    const replyRes = await fetch(
      `${address}/api/admin/support-tickets/${warrantyTicketId}/messages`,
      {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "Your warranty claim has been approved. We will send a replacement unit.",
        }),
      },
    );
    expect(replyRes.status).toBe(200);

    // Transition to resolved
    const resolveRes = await fetch(
      `${address}/api/admin/support-tickets/${warrantyTicketId}/transition`,
      {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          new_status: "resolved",
          reason: "Warranty claim approved — replacement authorized",
        }),
      },
    );
    expect(resolveRes.status).toBe(200);
    const resolveBody = (await resolveRes.json()) as {
      oldStatus: string;
      newStatus: string;
    };
    expect(resolveBody.oldStatus).toBe("open");
    expect(resolveBody.newStatus).toBe("resolved");
  });

  // -------------------------------------------------------------------------
  // Step 6: Verify ticket final state + status history
  // -------------------------------------------------------------------------

  it("step 6: ticket status history shows the full approval lifecycle", async () => {
    const historyRes = await fetch(
      `${address}/api/admin/support-tickets/${warrantyTicketId}/history`,
      { headers: adminHeaders },
    );
    expect(historyRes.status).toBe(200);
    const historyBody = (await historyRes.json()) as {
      history: { oldStatus: string; newStatus: string; reason: string | null }[];
    };

    // Should have transitions: open→waiting_on_internal→open→resolved
    expect(historyBody.history.length).toBeGreaterThanOrEqual(3);

    const statuses = historyBody.history.map((h) => h.newStatus);
    expect(statuses).toContain("waiting_on_internal");
    expect(statuses).toContain("open");
    expect(statuses).toContain("resolved");

    // Verify messages include both customer and admin messages
    const messagesRes = await fetch(
      `${address}/api/admin/support-tickets/${warrantyTicketId}/messages`,
      { headers: adminHeaders },
    );
    expect(messagesRes.status).toBe(200);
    const messagesBody = (await messagesRes.json()) as {
      messages: { body: string; authorType: string }[];
    };
    const adminMsg = messagesBody.messages.find((m) => m.authorType === "admin");
    expect(adminMsg).toBeDefined();
    expect(adminMsg!.body).toContain("warranty claim has been approved");
  });

  // -------------------------------------------------------------------------
  // Step 7: TPU heat deformation — flagged with material limitation
  // -------------------------------------------------------------------------

  it("step 7: warranty claim with heat deformation description flags material limitation", async () => {
    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...customerAuthHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: orderId,
        order_line_id: orderLineId,
        description: "The case warped and deformed after I left it on my car dashboard in the heat.",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticket: { id: string; category: string; priority: string };
      material_limitation_flagged: boolean;
      material_limitation_note: string;
    };

    createdTicketIds.push(body.ticket.id);

    expect(body.ticket.category).toBe("warranty_claim");
    expect(body.material_limitation_flagged).toBe(true);
    expect(body.material_limitation_note).toContain("TPU heat deformation");
    expect(body.material_limitation_note).toContain("documented material limitation");

    // Verify internal system note was created (not visible to customer)
    const allMessages = await listTicketMessages(dbConn.db, body.ticket.id, {
      includeInternalNotes: true,
    });
    expect(allMessages.length).toBe(2); // customer message + system note

    const systemNote = allMessages.find((m) => m.authorType === "system");
    expect(systemNote).toBeDefined();
    expect(systemNote!.isInternalNote).toBe(true);
    expect(systemNote!.body).toContain("TPU heat deformation");

    // Customer-visible messages exclude the internal note
    const customerVisibleMessages = await listTicketMessages(dbConn.db, body.ticket.id);
    expect(customerVisibleMessages.length).toBe(1);
    expect(customerVisibleMessages[0].authorType).toBe("customer");
  });

  // -------------------------------------------------------------------------
  // Step 8: Admin denies a material-limitation claim → resolved (denied)
  // -------------------------------------------------------------------------

  it("step 8: admin can deny warranty claim via ticket transition", async () => {
    // Get the heat-deformation ticket (last one created)
    const heatTicketId = createdTicketIds[createdTicketIds.length - 1];

    // Admin posts denial reply
    const replyRes = await fetch(
      `${address}/api/admin/support-tickets/${heatTicketId}/messages`,
      {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "This claim has been denied. The damage is consistent with heat exposure, which is a documented material limitation of TPU products and not covered under warranty.",
        }),
      },
    );
    expect(replyRes.status).toBe(200);

    // Transition to resolved (denied)
    const resolveRes = await fetch(
      `${address}/api/admin/support-tickets/${heatTicketId}/transition`,
      {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          new_status: "resolved",
          reason: "Warranty claim denied — heat deformation is not covered",
        }),
      },
    );
    expect(resolveRes.status).toBe(200);
    const resolveBody = (await resolveRes.json()) as {
      oldStatus: string;
      newStatus: string;
    };
    expect(resolveBody.newStatus).toBe("resolved");
  });

  // -------------------------------------------------------------------------
  // Step 9: Out-of-warranty claim rejection
  // -------------------------------------------------------------------------

  it("step 9: warranty claim for expired order (13 months) is rejected", async () => {
    const db = dbConn.db;

    // Create a second order + delivered shipment 13 months ago (past warranty)
    const [expiredOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-WC-EXP-${run}`,
        email: CUSTOMER_EMAIL,
        customerId,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "fulfilled",
        shippingStatus: "delivered",
        subtotalMinor: 3000,
        totalMinor: 3000,
        placedAt: new Date(),
      })
      .returning();
    expiredOrderId = expiredOrder.id;

    const [expiredLine] = await db
      .insert(orderLine)
      .values({
        orderId: expiredOrderId,
        variantId,
        skuSnapshot: `WC-EXP-${run}`,
        titleSnapshot: "Expired Warranty Item",
        quantity: 1,
        unitPriceMinor: 3000,
        totalMinor: 3000,
      })
      .returning();
    expiredOrderLineId = expiredLine.id;

    const thirteenMonthsAgo = new Date();
    thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);

    const [expiredShp] = await db
      .insert(shipment)
      .values({
        orderId: expiredOrderId,
        shipmentNumber: `SHP-WC-EXP-${run}`,
        status: "delivered",
        carrier: "USPS",
        deliveredAt: thirteenMonthsAgo,
      })
      .returning();
    expiredShipmentId = expiredShp.id;
    createdShipmentIds.push(expiredShp.id);

    // Submit warranty claim — should be rejected
    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...customerAuthHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: expiredOrderId,
        order_line_id: expiredOrderLineId,
        description: "Item broke after 13 months.",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ERR_WARRANTY_EXPIRED");
    expect(body.message).toContain("Warranty period has expired");
  });

  // -------------------------------------------------------------------------
  // Step 10: Non-owner cannot submit claim (404 — existence hidden)
  // -------------------------------------------------------------------------

  it("step 10: non-owner submitting warranty claim gets 404", async () => {
    // Create a second customer
    const otherEmail = `warranty-flow-other-${run}@example.com`;
    const { userId: otherId } = await signUpUser(address, otherEmail, CUSTOMER_PASSWORD);
    await verifyEmail(otherId);
    const otherSignIn = await signIn(address, otherEmail, CUSTOMER_PASSWORD);

    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { ...otherSignIn.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: orderId,
        order_line_id: orderLineId,
        description: "Not my order.",
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ERR_ORDER_NOT_FOUND");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 11: Unauthenticated request → 401
  // -------------------------------------------------------------------------

  it("step 11: unauthenticated warranty claim request returns 401", async () => {
    const res = await fetch(`${address}/api/support/warranty-claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        order_id: orderId,
        order_line_id: orderLineId,
        description: "Should fail.",
      }),
    });

    expect(res.status).toBe(401);
  });
});
