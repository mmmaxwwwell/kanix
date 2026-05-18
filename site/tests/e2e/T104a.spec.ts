// regression for T104a
import { test, expect, request as pwRequest } from "@playwright/test";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:3000";
const ST_CORE_URL = process.env.SUPERTOKENS_CONNECTION_URI ?? "http://127.0.0.1:3567";
const VARIANT_ID = "0005d585-038d-493b-b68f-d0c17933a2a4"; // base-plate-100 TPU

const SHIPPING_ADDRESS = {
  line1: "100 Main St",
  city: "Austin",
  state: "TX",
  postal_code: "78701",
  country: "US",
};

async function createGuestOrder(email: string): Promise<string> {
  const ctx = await pwRequest.newContext({ baseURL: API_URL });

  // Create cart
  const cartRes = await ctx.post("/api/cart", {
    headers: { "content-type": "application/json" },
    data: {},
  });
  expect(cartRes.ok()).toBeTruthy();
  const cartData = await cartRes.json();
  const token: string = cartData.cart.token;

  // Add item
  const addRes = await ctx.post("/api/cart/items", {
    headers: {
      "content-type": "application/json",
      "x-cart-token": token,
    },
    data: { variant_id: VARIANT_ID, quantity: 1 },
  });
  expect(addRes.ok()).toBeTruthy();

  // Checkout (creates order, sets pending_payment — no Stripe step needed for linking test)
  const checkoutRes = await ctx.post("/api/checkout", {
    headers: { "content-type": "application/json" },
    data: { cart_token: token, email, shipping_address: SHIPPING_ADDRESS },
  });
  expect(checkoutRes.status()).toBe(201);
  const checkoutData = await checkoutRes.json();
  const orderId: string = checkoutData.order.id;
  await ctx.dispose();
  return orderId;
}

test.describe("T104a — Guest order to account linking (FR-066)", () => {
  test("3 guest orders link to customer after email verification", async () => {
    // Use a unique email per run to avoid conflicts
    const email = `jane-t104a-${Date.now()}@example.com`;

    // Step 1: Create 3 guest orders via API
    const orderIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      orderIds.push(await createGuestOrder(email));
    }
    expect(orderIds).toHaveLength(3);

    const ctx = await pwRequest.newContext({ baseURL: API_URL });

    // Step 2: Sign up — orders should NOT be linked yet (email unverified)
    const signupRes = await ctx.post("/auth/signup", {
      headers: { "content-type": "application/json", origin: API_URL },
      data: {
        formFields: [
          { id: "email", value: email },
          { id: "password", value: "JaneGuest2026!" },
        ],
      },
    });
    expect(signupRes.ok()).toBeTruthy();
    const signupData = await signupRes.json();
    expect(signupData.status).toBe("OK");
    const userId: string = signupData.user.id;

    // Step 3: Create verification token via SuperTokens core
    const stCtx = await pwRequest.newContext({ baseURL: ST_CORE_URL });
    const tokenRes = await stCtx.post("/recipe/user/email/verify/token", {
      headers: {
        "content-type": "application/json",
        "api-key": "test",
        "cdi-version": "5.3",
      },
      data: { userId, email },
    });
    expect(tokenRes.ok()).toBeTruthy();
    const tokenData = await tokenRes.json();
    expect(tokenData.status).toBe("OK");
    const verifyToken: string = tokenData.token;
    await stCtx.dispose();

    // Step 4: Verify email via app API — triggers linkGuestOrdersByEmail
    const verifyRes = await ctx.post("/auth/user/email/verify", {
      headers: { "content-type": "application/json", origin: API_URL },
      data: { method: "token", token: verifyToken },
    });
    expect(verifyRes.ok()).toBeTruthy();
    const verifyData = await verifyRes.json();
    expect(verifyData.status).toBe("OK");

    // Step 5: Sign in and verify all 3 orders appear in customer order history
    const signinRes = await ctx.post("/auth/signin", {
      headers: { "content-type": "application/json", origin: API_URL },
      data: {
        formFields: [
          { id: "email", value: email },
          { id: "password", value: "JaneGuest2026!" },
        ],
      },
    });
    expect(signinRes.ok()).toBeTruthy();
    const accessToken = signinRes.headers()["st-access-token"];
    expect(accessToken).toBeTruthy();

    const ordersRes = await ctx.get("/api/customer/orders", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        origin: API_URL,
      },
    });
    expect(ordersRes.ok()).toBeTruthy();
    const ordersData = await ordersRes.json();
    expect(ordersData.orders).toHaveLength(3);

    // All orders should belong to this email
    for (const order of ordersData.orders) {
      expect(order.email).toBe(email);
    }

    // Returned order IDs should match the ones we created
    const returnedIds = ordersData.orders.map((o: { id: string }) => o.id).sort();
    expect(returnedIds).toEqual(orderIds.sort());

    await ctx.dispose();
  });
});
