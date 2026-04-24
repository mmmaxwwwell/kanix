// regression for T096
import { test, expect } from "@playwright/test";

test.describe("T096 — Guest checkout on Astro site", () => {
  test("products page loads and shows at least one product", async ({
    page,
  }) => {
    await page.goto("/kanix/products/");
    const productLinks = page.locator('a.group[href*="/kanix/products/"]');
    const count = await productLinks.count();
    expect(count).toBeGreaterThan(0);
  });

  test("product detail page loads with add-to-cart button", async ({
    page,
  }) => {
    // Navigate to products listing and click the first product
    await page.goto("/kanix/products/");
    const firstProduct = page
      .locator('a.group[href*="/kanix/products/"]')
      .first();
    const href = await firstProduct.getAttribute("href");
    expect(href).toBeTruthy();
    await firstProduct.click();

    // Product detail page should have the add-to-cart island
    await expect(page.locator("#add-to-cart-island")).toBeVisible();
    await expect(page.locator("#add-to-cart-btn")).toBeVisible();
  });

  test("add item to cart and verify cart badge", async ({ page }) => {
    // Navigate to first product
    await page.goto("/kanix/products/");
    const firstProduct = page
      .locator('a.group[href*="/kanix/products/"]')
      .first();
    await firstProduct.click();
    await expect(page.locator("#add-to-cart-btn")).toBeVisible();

    // Select first variant if dropdown exists
    const variantSelect = page.locator("#variant-select");
    if (await variantSelect.isVisible()) {
      const firstOption = variantSelect.locator("option:not([value=''])");
      const val = await firstOption.first().getAttribute("value");
      if (val) await variantSelect.selectOption(val);
    }

    // Click add to cart
    await page.locator("#add-to-cart-btn").click();

    // Success message should appear
    await expect(page.locator("#add-to-cart-message")).toBeVisible();
    await expect(page.locator("#add-to-cart-message")).toContainText(
      /added to cart/i
    );

    // Cart count badge should be visible
    const cartCount = page.locator("#cart-count");
    await expect(cartCount).toBeVisible();
  });

  test("guest checkout: fill address, payment section appears", async ({
    page,
  }) => {
    // Step 1: Add an item to cart
    await page.goto("/kanix/products/");
    const firstProduct = page
      .locator('a.group[href*="/kanix/products/"]')
      .first();
    await firstProduct.click();
    await expect(page.locator("#add-to-cart-btn")).toBeVisible();

    const variantSelect = page.locator("#variant-select");
    if (await variantSelect.isVisible()) {
      const firstOption = variantSelect.locator("option:not([value=''])");
      const val = await firstOption.first().getAttribute("value");
      if (val) await variantSelect.selectOption(val);
    }

    await page.locator("#add-to-cart-btn").click();
    await expect(page.locator("#add-to-cart-message")).toContainText(
      /added to cart/i
    );

    // Step 2: Navigate to checkout
    await page.goto("/kanix/checkout/");
    await expect(page.locator("#checkout-form")).toBeVisible();
    await expect(page.locator("#checkout-empty")).not.toBeVisible();

    // Step 3: Fill the shipping form using native setter pattern
    await page.evaluate(() => {
      function setVal(sel: string, val: string) {
        const el = document.querySelector(sel) as
          | HTMLInputElement
          | HTMLSelectElement
          | null;
        if (!el) return;
        const proto =
          el instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLSelectElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(
          proto,
          "value"
        )?.set;
        if (nativeSetter) nativeSetter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      setVal("#email", "guest-checkout-t096@example.com");
      setVal("#full_name", "T096 Guest Buyer");
      setVal("#line1", "123 Test Street");
      setVal("#city", "Austin");
      setVal("#state", "TX");
      setVal("#postal_code", "78701");
    });

    // Step 4: Submit address form
    await page.locator("#submit-address-btn").click();

    // Step 5: Payment section should appear
    await expect(page.locator("#payment-section")).toBeVisible({
      timeout: 5000,
    });

    // No error alerts
    const alerts = page.locator('[role="alert"]');
    const alertCount = await alerts.count();
    if (alertCount > 0) {
      const texts = await alerts.allInnerTexts();
      expect(texts).toEqual([]);
    }
  });
});
