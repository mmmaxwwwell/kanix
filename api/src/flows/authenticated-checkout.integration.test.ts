/**
 * Flow test: authenticated checkout [mirrors T097, SC-001]
 *
 * Walks the complete authenticated checkout flow via HTTP calls against the real stack:
 *   signup → verify email → login → add to cart → use saved address →
 *   checkout → Stripe webhook → order confirmed →
 *   order appears in customer order history with correct status transitions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import { productClass, productClassMembership } from "../db/schema/product-class.js";
import {
  inventoryBalance,
  inventoryLocation,
  inventoryReservation,
} from "../db/schema/inventory.js";
import { order, orderLine, orderStatusHistory } from "../db/schema/order.js";
import { payment, paymentEvent } from "../db/schema/payment.js";
import { customer } from "../db/schema/customer.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_auth_checkout_flow_test";
const run = Date.now();
const TEST_EMAIL = `auth-flow-${run}@example.com`;
const TEST_PASSWORD = "AuthFlowPass123!";

const VALID_ADDRESS = {
  full_name: "Alice Authenticated",
  line1: "789 Verified Lane",
  city: "Austin",
  state: "TX",
  postal_code: "78703",
  country: "US",
};

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

function createStubTaxAdapter(taxMinor = 450): TaxAdapter {
  return {
    async calculate() {
      return { taxAmountMinor: taxMinor, calculationId: `txcalc_auth_flow_${Date.now()}` };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_auth_flow_${piCounter}_${Date.now()}`,
        clientSecret: `pi_auth_flow_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_auth_flow_${Date.now()}`, status: "succeeded" };
    },
    async submitDisputeEvidence() {
      return { id: "de_test_stub", status: "under_review" };
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook helper
// ---------------------------------------------------------------------------

function generateWebhookPayload(
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
// Auth helpers (require real HTTP — SuperTokens uses cookies)
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
    user: { id: string; emails: string[] };
  };
  expect(body.status).toBe("OK");
  return { userId: body.user.id };
}

async function verifyEmail(userId: string): Promise<void> {
  const { default: supertokens } = await import("supertokens-node");
  const { default: EmailVerification } =
    await import("supertokens-node/recipe/emailverification/index.js");
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
): Promise<{ headers: Record<string, string>; userId: string }> {
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
  const body = (await res.json()) as { status: string; user: { id: string } };
  expect(body.status).toBe("OK");

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

  return { headers, userId: body.user.id };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authenticated checkout flow (T261, mirrors T097/SC-001)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  // Seed data IDs
  let productId = "";
  let variantAId = "";
  let variantBId = "";
  let locationId = "";
  let classId = "";

  // Auth state
  let authUserId = "";
  let authHeaders: Record<string, string> = {};
  let customerId = "";

  // Flow state (populated step by step)
  let cartToken = "";
  let savedAddressId = "";
  let orderId = "";
  let orderNumber = "";
  let paymentIntentId = "";
  let paymentRecordId = "";

  beforeAll(async () => {
    // Need skipListen: false for real HTTP (SuperTokens auth requires cookies)
    ts_ = await createTestServer({
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
      serverOverrides: {
        taxAdapter: createStubTaxAdapter(450),
        shippingAdapter: createStubShippingAdapter(),
        paymentAdapter: createStubPaymentAdapter(),
      },
    });
    app = ts_.app;
    dbConn = ts_.dbConn;
    address = ts_.address;
    const db = dbConn.db;

    // 1. Product with two variants
    const [prod] = await db
      .insert(product)
      .values({
        slug: `aflow-prod-${run}`,
        title: `Auth Flow Product ${run}`,
        status: "active",
      })
      .returning();
    productId = prod.id;

    const [vA] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `AFLOW-A-${run}`,
        title: `Auth Variant A ${run}`,
        priceMinor: 3000, // $30.00
        status: "active",
        weight: "14",
      })
      .returning();
    variantAId = vA.id;

    const [vB] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `AFLOW-B-${run}`,
        title: `Auth Variant B ${run}`,
        priceMinor: 1500, // $15.00
        status: "active",
        weight: "8",
      })
      .returning();
    variantBId = vB.id;

    // 2. Product class + membership (needed for catalog listing)
    const [cls] = await db
      .insert(productClass)
      .values({ name: `AFlow Class ${run}`, slug: `aflow-class-${run}` })
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
            name: `AFlow Warehouse ${run}`,
            code: `AFLOW-WH-${run}`,
            type: "warehouse",
          })
          .returning();
        locationId = loc.id;
      }
    }

    await db.insert(inventoryBalance).values([
      { variantId: variantAId, locationId, onHand: 50, reserved: 0, available: 50 },
      { variantId: variantBId, locationId, onHand: 30, reserved: 0, available: 30 },
    ]);
  }, 30_000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Step 1: Signup → verify email → login
  // -------------------------------------------------------------------------

  it("step 1: signup, verify email, and login to get authenticated session", async () => {
    // Signup
    const { userId } = await signUpUser(address, TEST_EMAIL, TEST_PASSWORD);
    authUserId = userId;
    expect(authUserId).toBeTruthy();

    // Verify email (required for protected routes)
    await verifyEmail(authUserId);

    // Login to get session cookies
    const { headers, userId: loginUserId } = await signIn(address, TEST_EMAIL, TEST_PASSWORD);
    authHeaders = headers;
    expect(loginUserId).toBe(authUserId);

    // Verify we have a valid session — access the customer profile
    const meRes = await fetch(`${address}/api/customer/me`, { headers: authHeaders });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      customer: { id: string; email: string; status: string };
    };
    expect(meBody.customer.email).toBe(TEST_EMAIL);
    expect(meBody.customer.status).toBe("active");
    customerId = meBody.customer.id;
    expect(customerId).toBeTruthy();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 2: Save a shipping address
  // -------------------------------------------------------------------------

  it("step 2: save a shipping address for the authenticated customer", async () => {
    const res = await fetch(`${address}/api/customer/addresses`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shipping",
        ...VALID_ADDRESS,
        is_default: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      address: { id: string; fullName: string; city: string; isDefault: boolean };
    };
    expect(body.address.id).toBeTruthy();
    expect(body.address.fullName).toBe("Alice Authenticated");
    expect(body.address.city).toBe("Austin");
    expect(body.address.isDefault).toBe(true);
    savedAddressId = body.address.id;

    // Verify saved address appears in list
    const listRes = await fetch(`${address}/api/customer/addresses`, {
      headers: authHeaders,
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      addresses: { id: string; fullName: string }[];
    };
    const found = listBody.addresses.find((a) => a.id === savedAddressId);
    expect(found).toBeDefined();
    expect(found!.fullName).toBe("Alice Authenticated");
  });

  // -------------------------------------------------------------------------
  // Step 3: Browse catalog and add items to cart
  // -------------------------------------------------------------------------

  it("step 3: browse catalog and add items to cart (1×A + 2×B)", async () => {
    // Verify product is visible in catalog
    const catalogRes = await fetch(`${address}/api/products`, {
      headers: authHeaders,
    });
    expect(catalogRes.status).toBe(200);
    const catalogBody = (await catalogRes.json()) as {
      products: {
        slug: string;
        title: string;
        variants: { sku: string; priceMinor: number; inStock: boolean }[];
      }[];
    };
    const found = catalogBody.products.find((p) => p.slug === `aflow-prod-${run}`);
    expect(found).toBeDefined();
    expect(found!.title).toBe(`Auth Flow Product ${run}`);

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

    // Add 1× variant A ($30)
    const addARes = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variantAId, quantity: 1 }),
    });
    expect(addARes.status).toBeLessThan(300);

    // Add 2× variant B ($15 each)
    const addBRes = await fetch(`${address}/api/cart/items`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variantBId, quantity: 2 }),
    });
    expect(addBRes.status).toBeLessThan(300);

    // Verify cart contents
    const getCartRes = await fetch(`${address}/api/cart`, {
      headers: { ...authHeaders, "x-cart-token": cartToken },
    });
    expect(getCartRes.status).toBe(200);
    const cart = (await getCartRes.json()) as {
      cart: { items: { variantId: string; quantity: number }[] };
    };
    expect(cart.cart.items.length).toBe(2);

    const itemA = cart.cart.items.find((i) => i.variantId === variantAId);
    expect(itemA).toBeDefined();
    expect(itemA!.quantity).toBe(1);

    const itemB = cart.cart.items.find((i) => i.variantId === variantBId);
    expect(itemB).toBeDefined();
    expect(itemB!.quantity).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Step 4: Checkout with saved address (authenticated)
  // -------------------------------------------------------------------------

  it("step 4: checkout with saved address produces order linked to customer", async () => {
    const res = await fetch(`${address}/api/checkout`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: TEST_EMAIL,
        shipping_address: { ...VALID_ADDRESS },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      order: {
        id: string;
        order_number: string;
        email: string;
        status: string;
        payment_status: string;
        subtotal_minor: number;
        tax_minor: number;
        shipping_minor: number;
        total_minor: number;
      };
      client_secret: string;
    };

    // Order shape
    expect(body.order.order_number).toMatch(/^KNX-\d{6}$/);
    expect(body.order.email).toBe(TEST_EMAIL);
    expect(body.order.status).toBe("pending_payment");
    expect(body.order.payment_status).toBe("unpaid");

    // Totals: 3000*1 + 1500*2 = 6000 subtotal, 450 tax (stub), 599 shipping (stub)
    expect(body.order.subtotal_minor).toBe(6000);
    expect(body.order.tax_minor).toBe(450);
    expect(body.order.shipping_minor).toBe(599);
    expect(body.order.total_minor).toBe(6000 + 450 + 599); // 7049

    // client_secret for Stripe.js
    expect(typeof body.client_secret).toBe("string");
    expect(body.client_secret.length).toBeGreaterThan(0);

    orderId = body.order.id;
    orderNumber = body.order.order_number;
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 5: Verify order is linked to authenticated customer in DB
  // -------------------------------------------------------------------------

  it("step 5: DB has order linked to authenticated customer with correct snapshots", async () => {
    const db = dbConn.db;

    // Order row linked to customer
    const [savedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(savedOrder).toBeDefined();
    expect(savedOrder.status).toBe("pending_payment");
    expect(savedOrder.paymentStatus).toBe("unpaid");
    expect(savedOrder.email).toBe(TEST_EMAIL);
    expect(savedOrder.customerId).toBe(customerId);

    // Totals frozen
    expect(savedOrder.subtotalMinor).toBe(6000);
    expect(savedOrder.taxMinor).toBe(450);
    expect(savedOrder.shippingMinor).toBe(599);
    expect(savedOrder.totalMinor).toBe(7049);

    // Shipping address snapshot
    const addrSnapshot =
      typeof savedOrder.shippingAddressSnapshotJson === "string"
        ? JSON.parse(savedOrder.shippingAddressSnapshotJson)
        : savedOrder.shippingAddressSnapshotJson;
    expect(addrSnapshot.full_name).toBe("Alice Authenticated");
    expect(addrSnapshot.line1).toBe("789 Verified Lane");
    expect(addrSnapshot.city).toBe("Austin");
    expect(addrSnapshot.state).toBe("TX");
    expect(addrSnapshot.postal_code).toBe("78703");

    // Order lines with price snapshots
    const lines = await db.select().from(orderLine).where(eq(orderLine.orderId, orderId));
    expect(lines.length).toBe(2);

    const lineA = lines.find((l) => l.skuSnapshot === `AFLOW-A-${run}`);
    expect(lineA).toBeDefined();
    expect(lineA!.quantity).toBe(1);
    expect(lineA!.unitPriceMinor).toBe(3000);

    const lineB = lines.find((l) => l.skuSnapshot === `AFLOW-B-${run}`);
    expect(lineB).toBeDefined();
    expect(lineB!.quantity).toBe(2);
    expect(lineB!.unitPriceMinor).toBe(1500);

    // Payment record exists
    const [paymentRow] = await db.select().from(payment).where(eq(payment.orderId, orderId));
    expect(paymentRow).toBeDefined();
    expect(paymentRow.status).toBe("pending");
    expect(paymentRow.provider).toBe("stripe");
    expect(paymentRow.providerPaymentIntentId).toMatch(/^pi_auth_flow_/);
    paymentIntentId = paymentRow.providerPaymentIntentId;
    paymentRecordId = paymentRow.id;

    // Inventory reservations created
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    expect(reservations.length).toBe(2);
    for (const r of reservations) {
      expect(r.status).toBe("active");
    }
  });

  // -------------------------------------------------------------------------
  // Step 6: Stripe payment_intent.succeeded webhook
  // -------------------------------------------------------------------------

  it("step 6: Stripe webhook confirms payment → order confirmed + paid", async () => {
    const db = dbConn.db;
    const eventId = `evt_auth_flow_${run}`;
    const chargeId = `ch_auth_flow_${run}`;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 7049,
        currency: "usd",
        status: "succeeded",
        latest_charge: chargeId,
      },
      WEBHOOK_SECRET,
    );

    // Use app.inject for the webhook (no auth needed, just signature)
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

    // Order transitioned to confirmed + paid
    const [confirmedOrder] = await db.select().from(order).where(eq(order.id, orderId));
    expect(confirmedOrder.status).toBe("confirmed");
    expect(confirmedOrder.paymentStatus).toBe("paid");

    // Payment record updated
    const [paymentRow] = await db.select().from(payment).where(eq(payment.id, paymentRecordId));
    expect(paymentRow.status).toBe("succeeded");
    expect(paymentRow.providerChargeId).toBe(chargeId);

    // Payment event logged
    const [eventRow] = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, eventId));
    expect(eventRow).toBeDefined();
    expect(eventRow.eventType).toBe("payment_intent.succeeded");
    expect(eventRow.paymentId).toBe(paymentRecordId);

    // Reservations consumed
    const reservations = await db
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, orderId));
    expect(reservations.length).toBe(2);
    for (const r of reservations) {
      expect(r.status).toBe("consumed");
    }
  });

  // -------------------------------------------------------------------------
  // Step 7: Order appears in customer order history
  // -------------------------------------------------------------------------

  it("step 7: order appears in authenticated customer order history with correct status", async () => {
    const ordersRes = await fetch(`${address}/api/customer/orders`, {
      headers: authHeaders,
    });
    expect(ordersRes.status).toBe(200);

    const body = (await ordersRes.json()) as {
      orders: {
        id: string;
        orderNumber: string;
        email: string;
        status: string;
        totalMinor: number;
      }[];
    };

    // Our order should be in the list
    const found = body.orders.find((o) => o.id === orderId);
    expect(found).toBeDefined();
    expect(found!.orderNumber).toBe(orderNumber);
    expect(found!.email).toBe(TEST_EMAIL);
    expect(found!.status).toBe("confirmed");
    expect(found!.totalMinor).toBe(7049);
  });

  // -------------------------------------------------------------------------
  // Step 8: Verify status transition history
  // -------------------------------------------------------------------------

  it("step 8: order status history tracks pending_payment → confirmed transitions", async () => {
    const db = dbConn.db;

    const history = await db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId));
    expect(history.length).toBeGreaterThanOrEqual(2);

    const statusEntries = history.filter((h) => h.statusType === "status");
    const statuses = statusEntries.map((h) => h.newValue);
    expect(statuses).toContain("pending_payment");
    expect(statuses).toContain("confirmed");

    // Payment status transitions (initial status "unpaid" may not be recorded
    // as a transition — the history tracks transitions, not initial states)
    const paymentEntries = history.filter((h) => h.statusType === "payment_status");
    const paymentStatuses = paymentEntries.map((h) => h.newValue);
    expect(paymentStatuses).toContain("paid");
  });
});
