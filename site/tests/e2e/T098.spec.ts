// regression for T098
import { test, expect } from "@playwright/test";

const KIT_CLASS_IDS = {
  PLATES: "cc23bf78-9b37-433a-9737-a0873796846f",
  MODULES: "4d73343d-5a0c-4ed8-b960-e36f036ea99c",
  BELTS: "5e0b4624-06bb-4c7f-b045-f0655a4c00d4",
};

test.describe("T098 — Kit purchase web flow", () => {
  test("kits page loads with kit definitions and class requirements", async ({
    page,
  }) => {
    await page.goto("/kanix/kits/");
    await expect(page.locator("h1")).toContainText("Kit Builder");
    const kitBuilders = page.locator(".kit-builder");
    await expect(kitBuilders.first()).toBeVisible();
    const count = await kitBuilders.count();
    expect(count).toBeGreaterThan(0);
    const classSections = page.locator(".kit-class-section");
    const classCount = await classSections.count();
    expect(classCount).toBeGreaterThanOrEqual(3);
  });

  test("add-to-cart button is disabled until all classes are selected", async ({
    page,
  }) => {
    await page.goto("/kanix/kits/");
    const addBtn = page.locator(".kit-add-to-cart-btn").first();
    await expect(addBtn).toBeDisabled();
    const btnText = await addBtn.innerText();
    expect(btnText).toMatch(/select/i);

    // Select only PLATES — button should remain disabled
    const platesVariant = page
      .locator(
        `.kit-class-section[data-class-id="${KIT_CLASS_IDS.PLATES}"] .kit-variant-btn:not([disabled])`
      )
      .first();
    await platesVariant.click();
    await expect(addBtn).toBeDisabled();
    const partialText = await addBtn.innerText();
    expect(partialText).toMatch(/select \d+ more/i);
  });

  test("happy path: select all classes, add kit to cart, checkout, payment section appears", async ({
    page,
  }) => {
    await page.goto("/kanix/kits/");

    // Select a variant from each required class
    for (const classId of Object.values(KIT_CLASS_IDS)) {
      const btn = page
        .locator(
          `.kit-class-section[data-class-id="${classId}"] .kit-variant-btn:not([disabled])`
        )
        .first();
      await btn.click();
    }

    // Button should now be enabled
    const addBtn = page.locator(".kit-add-to-cart-btn").first();
    await expect(addBtn).toBeEnabled();
    await expect(addBtn).toContainText("Add Kit to Cart");

    // Add to cart
    await addBtn.click();
    const message = page.locator(".kit-message").first();
    await expect(message).toContainText("Kit added to cart!");

    // Cart badge should show 1
    const cartCount = page.locator("#cart-count");
    await expect(cartCount).toBeVisible();
    await expect(cartCount).toContainText("1");

    // Navigate to checkout
    await page.goto("/kanix/checkout/");
    await expect(page.locator("#checkout-form")).toBeVisible();
    await expect(page.locator("#checkout-empty")).not.toBeVisible();

    // Fill shipping form
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
      setVal("#email", "kit-test@example.com");
      setVal("#full_name", "Kit Buyer");
      setVal("#line1", "100 Kit Lane");
      setVal("#city", "Austin");
      setVal("#state", "TX");
      setVal("#postal_code", "78704");
    });

    // Submit shipping form
    await page.locator("#submit-address-btn").click();

    // Payment section should appear within 5s
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
