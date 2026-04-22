/**
 * Flow test: guest-order → account linking [mirrors T104a, FR-066]
 *
 * Walks the complete guest-order-to-account-linking flow via HTTP calls:
 *   guest checkout with email X → order confirmed via Stripe webhook →
 *   signup with email X → verify email → guest order linked to new account →
 *   order appears in authenticated order history → link is idempotent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, stopTestServer, type TestServer } from "../test-server.js";
import type { DatabaseConnection } from "../db/connection.js";
import type { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { product, productVariant } from "../db/schema/catalog.js";
import { productClass, productClassMembership } from "../db/schema/product-class.js";
import {
  inventoryBalance,
  inventoryLocation,
} from "../db/schema/inventory.js";
import { order } from "../db/schema/order.js";
import { customer } from "../db/schema/customer.js";
import type { TaxAdapter } from "../services/tax-adapter.js";
import { createStubShippingAdapter } from "../services/shipping-adapter.js";
import type { PaymentAdapter } from "../services/payment-adapter.js";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_guest_order_link_flow_test";
const run = Date.now();
const GUEST_EMAIL = `guest-link-flow-${run}@example.com`;
const PASSWORD = "GuestLinkFlow123!";

const VALID_ADDRESS = {
  full_name: "Guest Linker",
  line1: "101 Link Street",
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
      return { taxAmountMinor: taxMinor, calculationId: `txcalc_gol_${Date.now()}` };
    },
  };
}

let piCounter = 0;
function createStubPaymentAdapter(): PaymentAdapter {
  return {
    async createPaymentIntent() {
      piCounter++;
      return {
        id: `pi_gol_${piCounter}_${Date.now()}`,
        clientSecret: `pi_gol_${piCounter}_secret_${Date.now()}`,
      };
    },
    async createRefund() {
      return { id: `re_gol_${Date.now()}`, status: "succeeded" };
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

async function verifyEmail(address: string, userId: string): Promise<void> {
  const { default: supertokens } = await import("supertokens-node");
  const { default: EmailVerification } = await import(
    "supertokens-node/recipe/emailverification/index.js"
  );
  const tokenRes = await EmailVerification.createEmailVerificationToken(
    "public",
    supertokens.convertToRecipeUserId(userId),
  );
  expect(tokenRes.status).toBe("OK");
  if (tokenRes.status !== "OK") return;

  // Use HTTP endpoint to trigger the verifyEmailPOST override that links guest orders
  const verifyRes = await fetch(`${address}/auth/user/email/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ method: "token", token: tokenRes.token }),
  });
  expect(verifyRes.status).toBe(200);
  const body = (await verifyRes.json()) as { status: string };
  expect(body.status).toBe("OK");
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

describe("guest-order → account linking flow (T269, mirrors T104a/FR-066)", () => {
  let ts_: TestServer;
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let address: string;

  // Seed data IDs
  let variantId = "";
  let locationId = "";

  // Flow state
  let guestOrderId = "";
  let guestOrderNumber = "";
  let paymentIntentId = "";
  let authUserId = "";
  let customerId = "";

  beforeAll(async () => {
    // skipListen: false (default) — need real HTTP for SuperTokens auth
    ts_ = await createTestServer({
      configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
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

    // Product + variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `gol-prod-${run}`,
        title: `Guest Order Link Product ${run}`,
        status: "active",
      })
      .returning();

    const [v] = await db
      .insert(productVariant)
      .values({
        productId: prod.id,
        sku: `GOL-V-${run}`,
        title: `GOL Variant ${run}`,
        priceMinor: 2000,
        status: "active",
        weight: "10",
      })
      .returning();
    variantId = v.id;

    // Product class + membership (for catalog visibility)
    const [cls] = await db
      .insert(productClass)
      .values({ name: `GOL Class ${run}`, slug: `gol-class-${run}` })
      .returning();

    await db.insert(productClassMembership).values({
      productId: prod.id,
      productClassId: cls.id,
    });

    // Inventory
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
            name: `GOL Warehouse ${run}`,
            code: `GOL-WH-${run}`,
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
  }, 30_000);

  afterAll(async () => {
    await stopTestServer(ts_);
  });

  // -------------------------------------------------------------------------
  // Step 1: Guest checkout — create cart, add items, checkout (no auth)
  // -------------------------------------------------------------------------

  it("step 1: guest checkout creates order with email but no customer link", async () => {
    // Create cart
    const cartRes = await app.inject({
      method: "POST",
      url: "/api/cart",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cartRes.statusCode).toBe(201);
    const cartToken = JSON.parse(cartRes.body).cart.token;
    expect(typeof cartToken).toBe("string");

    // Add item
    const addRes = await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: {
        "content-type": "application/json",
        "x-cart-token": cartToken,
      },
      body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
    });
    expect(addRes.statusCode).toBeLessThan(300);

    // Checkout as guest (no auth headers)
    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cart_token: cartToken,
        email: GUEST_EMAIL,
        shipping_address: { ...VALID_ADDRESS },
      }),
    });

    expect(checkoutRes.statusCode).toBe(201);
    const body = JSON.parse(checkoutRes.body);
    expect(body.order.email).toBe(GUEST_EMAIL);
    expect(body.order.status).toBe("pending_payment");
    expect(body.order.subtotal_minor).toBe(2000);
    expect(body.order.tax_minor).toBe(200);
    expect(body.order.shipping_minor).toBe(599);
    expect(body.order.total_minor).toBe(2799);

    guestOrderId = body.order.id;
    guestOrderNumber = body.order.order_number;
    expect(guestOrderId).toBeTruthy();

    // Verify order has no customer link in DB
    const [dbOrder] = await dbConn.db
      .select({ customerId: order.customerId })
      .from(order)
      .where(eq(order.id, guestOrderId));
    expect(dbOrder.customerId).toBeNull();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 2: Confirm payment via Stripe webhook → order confirmed
  // -------------------------------------------------------------------------

  it("step 2: Stripe webhook confirms guest payment → order status=confirmed", async () => {
    const db = dbConn.db;

    // Get the payment intent ID from DB
    const { payment } = await import("../db/schema/payment.js");
    const [paymentRow] = await db
      .select()
      .from(payment)
      .where(eq(payment.orderId, guestOrderId));
    expect(paymentRow).toBeDefined();
    paymentIntentId = paymentRow.providerPaymentIntentId;

    const eventId = `evt_gol_${run}`;
    const chargeId = `ch_gol_${run}`;

    const { body, signature } = generateWebhookPayload(
      eventId,
      "payment_intent.succeeded",
      {
        id: paymentIntentId,
        object: "payment_intent",
        amount: 2799,
        currency: "usd",
        status: "succeeded",
        latest_charge: chargeId,
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

    // Order confirmed + paid
    const [confirmedOrder] = await db
      .select()
      .from(order)
      .where(eq(order.id, guestOrderId));
    expect(confirmedOrder.status).toBe("confirmed");
    expect(confirmedOrder.paymentStatus).toBe("paid");

    // Still no customer link
    expect(confirmedOrder.customerId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Step 3: Signup with same email — orders NOT linked yet (unverified)
  // -------------------------------------------------------------------------

  it("step 3: signup with guest email does NOT link orders before verification", async () => {
    const { userId } = await signUpUser(address, GUEST_EMAIL, PASSWORD);
    authUserId = userId;
    expect(authUserId).toBeTruthy();

    // Customer row created by signUpPOST override
    const custRows = await dbConn.db
      .select({ id: customer.id })
      .from(customer)
      .where(eq(customer.email, GUEST_EMAIL));
    expect(custRows.length).toBe(1);
    customerId = custRows[0].id;

    // Guest order still unlinked (linking happens on email verification per FR-066)
    const [dbOrder] = await dbConn.db
      .select({ customerId: order.customerId })
      .from(order)
      .where(eq(order.id, guestOrderId));
    expect(dbOrder.customerId).toBeNull();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 4: Verify email → guest orders linked to new account
  // -------------------------------------------------------------------------

  it("step 4: email verification triggers guest order linking", async () => {
    await verifyEmail(address, authUserId);

    // Guest order now linked to the customer
    const [dbOrder] = await dbConn.db
      .select({ customerId: order.customerId, email: order.email })
      .from(order)
      .where(eq(order.id, guestOrderId));
    expect(dbOrder.customerId).toBe(customerId);
    expect(dbOrder.email).toBe(GUEST_EMAIL);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 5: Sign in → order appears in authenticated order history
  // -------------------------------------------------------------------------

  it("step 5: linked guest order appears in authenticated order history", async () => {
    const { headers } = await signIn(address, GUEST_EMAIL, PASSWORD);

    const ordersRes = await fetch(`${address}/api/customer/orders`, { headers });
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

    // Our guest order should now appear in the customer's order history
    const found = body.orders.find((o) => o.id === guestOrderId);
    expect(found).toBeDefined();
    expect(found!.orderNumber).toBe(guestOrderNumber);
    expect(found!.email).toBe(GUEST_EMAIL);
    expect(found!.status).toBe("confirmed");
    expect(found!.totalMinor).toBe(2799);
  });

  // -------------------------------------------------------------------------
  // Step 6: Idempotency — re-linking returns 0 updated
  // -------------------------------------------------------------------------

  it("step 6: re-linking is idempotent (no orders updated on repeat)", async () => {
    const { linkGuestOrdersByEmail } = await import("../db/queries/order.js");
    const updated = await linkGuestOrdersByEmail(dbConn.db, GUEST_EMAIL, customerId);
    expect(updated).toBe(0);

    // Order still linked to same customer
    const [dbOrder] = await dbConn.db
      .select({ customerId: order.customerId })
      .from(order)
      .where(eq(order.id, guestOrderId));
    expect(dbOrder.customerId).toBe(customerId);
  });
});
