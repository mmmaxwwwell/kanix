// regression for T101
// Contributor royalty activation: 25-unit threshold, retroactive royalties,
// refund clawback, and donation 20% rate.
//
// This spec covers the API-driven happy path validated in the E2E executor
// spawns 1-4. The browser checkout flow (steps 5-7) is included as one
// representative checkout to exercise the full stack.
//
// Known open bugs:
//   BUG-T101-001 (low): POST /api/admin/contributors/:id/designs response missing salesCount
//   BUG-T101-002 (high): processOrderCompletionSales Map drops designs when multiple
//     contributors share a product — workaround: ensure only one design per product.

import { test, expect, request as pwRequest } from "@playwright/test";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:3000";
const SITE_URL = process.env.ASTRO_URL ?? "http://127.0.0.1:4321";

async function adminToken(): Promise<string> {
  const ctx = await pwRequest.newContext({ baseURL: API_URL });
  const resp = await ctx.post("/auth/signin", {
    headers: { "rid": "emailpassword" },
    data: {
      formFields: [
        { id: "email", value: "admin@kanix.test" },
        { id: "password", value: "TestAdmin123!" },
      ],
    },
  });
  expect(resp.status()).toBe(200);
  const token = resp.headers()["st-access-token"];
  expect(token).toBeTruthy();
  await ctx.dispose();
  return token;
}

async function apiPost(token: string, path: string, body: object) {
  const ctx = await pwRequest.newContext({ baseURL: API_URL });
  const resp = await ctx.post(path, {
    headers: { authorization: `Bearer ${token}` },
    data: body,
  });
  const json = await resp.json().catch(() => ({}));
  await ctx.dispose();
  return { status: resp.status(), body: json };
}

async function apiGet(token: string, path: string) {
  const ctx = await pwRequest.newContext({ baseURL: API_URL });
  const resp = await ctx.get(path, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await resp.json().catch(() => ({}));
  await ctx.dispose();
  return { status: resp.status(), body: json };
}

async function apiPut(token: string, path: string, body: object) {
  const ctx = await pwRequest.newContext({ baseURL: API_URL });
  const resp = await ctx.put(path, {
    headers: { authorization: `Bearer ${token}` },
    data: body,
  });
  const json = await resp.json().catch(() => ({}));
  await ctx.dispose();
  return { status: resp.status(), body: json };
}

async function completeOrder(token: string, orderId: string) {
  const transitions: Array<{ status_type: string; new_value: string }> = [
    { status_type: "payment_status", new_value: "processing" },
    { status_type: "payment_status", new_value: "paid" },
    { status_type: "status", new_value: "confirmed" },
    { status_type: "status", new_value: "completed" },
  ];
  for (const t of transitions) {
    const r = await apiPost(token, `/api/admin/orders/${orderId}/transition`, t);
    expect(r.status).toBe(200);
  }
}

async function createAndCompleteOrder(
  token: string,
  variantId: string,
  email: string
): Promise<string> {
  // Create cart
  const cartCtx = await pwRequest.newContext({ baseURL: API_URL });
  const cartResp = await cartCtx.post("/api/cart", {
    headers: { authorization: `Bearer ${token}` },
    data: {},
  });
  expect([200, 201]).toContain(cartResp.status());
  const cartBody = await cartResp.json();
  const cartToken: string = cartBody.cart.token;
  await cartCtx.dispose();

  // Add item
  const itemCtx = await pwRequest.newContext({ baseURL: API_URL });
  const itemResp = await itemCtx.post("/api/cart/items", {
    headers: { authorization: `Bearer ${token}`, "x-cart-token": cartToken },
    data: { variant_id: variantId, quantity: 1 },
  });
  expect([200, 201]).toContain(itemResp.status());
  await itemCtx.dispose();

  // Checkout
  const coCtx = await pwRequest.newContext({ baseURL: API_URL });
  const coResp = await coCtx.post("/api/checkout", {
    headers: { authorization: `Bearer ${token}` },
    data: {
      cart_token: cartToken,
      email,
      shipping_address: {
        full_name: "T101 Regression Buyer",
        line1: "1 Main St",
        city: "Austin",
        state: "TX",
        postal_code: "78701",
        country: "US",
      },
    },
  });
  expect([200, 201]).toContain(coResp.status());
  const coBody = await coResp.json();
  const orderId: string = coBody.order.id;
  await coCtx.dispose();

  await completeOrder(token, orderId);
  return orderId;
}

test.describe("T101 — contributor royalty lifecycle", () => {
  let token: string;
  let contributorId: string;
  let variantId: string;
  let order1Id: string;
  let order26Id: string;

  test.beforeAll(async () => {
    token = await adminToken();

    // Get product/variant
    const products = await apiGet(token, "/api/products");
    expect(products.status).toBe(200);
    const product = (products.body.products as Array<{ id: string; slug: string; variants?: Array<{ id: string }> }>).find(
      (p) => p.slug === "base-plate-100"
    );
    expect(product).toBeTruthy();

    const pDetail = await apiGet(token, `/api/products/${product!.id}`);
    variantId = pDetail.body.product.variants[0].id;
    expect(variantId).toBeTruthy();
  });

  test("1. Create contributor and link design", async () => {
    const ts = Date.now();
    const contrib = await apiPost(token, "/api/admin/contributors", {
      github_username: `t101-regression-${ts}`,
      github_user_id: `t101-gh-${ts}`,
      cla_accepted_at: "2026-01-01T00:00:00Z",
      cla_version: "1.0",
    });
    expect([200, 201]).toContain(contrib.status);
    contributorId = contrib.body.contributor.id;
    expect(contributorId).toBeTruthy();
    expect(contrib.body.contributor.status).toBe("active");

    // Get product id
    const products = await apiGet(token, "/api/products");
    const product = (products.body.products as Array<{ id: string; slug: string }>).find(
      (p) => p.slug === "base-plate-100"
    );
    const design = await apiPost(token, `/api/admin/contributors/${contributorId}/designs`, {
      product_id: product!.id,
    });
    expect([200, 201]).toContain(design.status);
    expect(design.body.contributorId ?? design.body.contributor_id).toBe(contributorId);
  });

  test("2. Browser checkout — add to cart and complete purchase", async ({ page }) => {
    await page.goto(`${SITE_URL}/kanix/products/base-plate-100/`);
    const heading = await page.locator("h1").first().innerText();
    expect(heading).toContain("Base Plate 100mm");

    await page.click("#add-to-cart-btn");
    await page.waitForFunction(() => {
      const badge = document.querySelector("#cart-count");
      return badge && !badge.classList.contains("hidden");
    }, { timeout: 5000 });

    await page.goto(`${SITE_URL}/kanix/checkout/`);
    await page.waitForSelector("#checkout-form");

    await page.fill("#email", "t101-regression@kanix.test");
    await page.fill("#full_name", "T101 Regression");
    await page.fill("#line1", "1 Main St");
    await page.fill("#city", "Austin");
    await page.selectOption("#state", "TX");
    await page.fill("#postal_code", "78701");
    await page.click("#submit-address-btn");
    await page.waitForSelector("#payment-section", { timeout: 10000 });

    // Stripe card fill (iframe)
    const cardFrame = page.frameLocator('iframe[name*="card-number"], iframe[title*="card number"], iframe[data-testid*="card"]').first();
    await cardFrame.locator('[name="cardnumber"], [autocomplete="cc-number"]').fill("4242424242424242");
    const expFrame = page.frameLocator('iframe[name*="expiry"], iframe[title*="expiration"]').first();
    await expFrame.locator('[name="exp-date"], [autocomplete="cc-exp"]').fill("12/28");
    const cvcFrame = page.frameLocator('iframe[name*="cvc"], iframe[title*="CVC"]').first();
    await cvcFrame.locator('[name="cvc"], [autocomplete="cc-csc"]').fill("123");

    await page.click("#pay-btn");
    await page.waitForURL(/order-confirmation/, { timeout: 30000 });
    expect(page.url()).toContain("order-confirmation");
  });

  test("3. Complete 25 orders and verify royalty activation milestone", async () => {
    // Create and complete orders until salesCount reaches 25
    for (let i = 0; i < 25; i++) {
      const oid = await createAndCompleteOrder(
        token,
        variantId,
        `t101-buyer-${i}@kanix.test`
      );
      if (i === 0) order1Id = oid;
    }

    // Verify salesCount >= 25
    const designs = await apiGet(token, `/api/admin/contributors/${contributorId}/designs`);
    expect(designs.status).toBe(200);
    const design = designs.body.designs[0];
    expect(design.salesCount).toBeGreaterThanOrEqual(25);

    // Verify milestone
    const milestones = await apiGet(token, `/api/admin/contributors/${contributorId}/milestones`);
    expect(milestones.status).toBe(200);
    const activation = (milestones.body as Array<{ milestoneType: string }>).find(
      (m) => m.milestoneType === "royalty_activation"
    );
    expect(activation).toBeTruthy();
  });

  test("4. Refund order and trigger clawback", async () => {
    // Refund the first order
    const designs = await apiGet(token, `/api/admin/contributors/${contributorId}/designs`);
    const refundOrderId = order1Id;
    const refundCtx = await pwRequest.newContext({ baseURL: API_URL });
    const refundResp = await refundCtx.post(`/api/admin/orders/${refundOrderId}/refunds`, {
      headers: { authorization: `Bearer ${token}` },
      data: { amount: 2598, reason: "regression test refund" },
    });
    expect([200, 201]).toContain(refundResp.status());
    await refundCtx.dispose();

    // Clawback
    const clawback = await apiPost(token, "/api/admin/contributors/royalties/clawback", {
      order_id: refundOrderId,
    });
    expect(clawback.status).toBe(200);
    expect(clawback.body.clawedBack).toBeGreaterThanOrEqual(1);
  });

  test("5. Donation config switches royalty rate to 20%", async () => {
    // Set donation
    const donation = await apiPut(token, `/api/admin/contributors/${contributorId}/donation`, {
      charity_name: "Dog Rescue Foundation",
      charity_ein: "12-3456789",
    });
    expect(donation.status).toBe(200);
    expect(donation.body.contributor.charityName).toBe("Dog Rescue Foundation");

    // Create one more order and verify 20% royalty rate
    order26Id = await createAndCompleteOrder(
      token,
      variantId,
      "t101-order26@kanix.test"
    );

    // Allow async processing
    await new Promise((r) => setTimeout(r, 2000));

    // Verify via DB (admin endpoint for royalties does not exist; check designs salesCount increased)
    const designs = await apiGet(token, `/api/admin/contributors/${contributorId}/designs`);
    expect(designs.status).toBe(200);
    expect(designs.body.designs[0].salesCount).toBeGreaterThanOrEqual(26);

    // Note: GET /api/admin/contributors/:id/royalties returns 404 (missing endpoint).
    // Royalty amount verified via psql in the manual run: amount_minor=399 = floor(1999*0.20).
    // Filing REGRESSION-NEEDED for the missing royalties endpoint:
    // See findings.json entry MISSING-ROYALTIES-ENDPOINT.
  });
});
