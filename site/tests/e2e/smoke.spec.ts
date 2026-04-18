import { test, expect } from "@playwright/test";

test.describe("Astro site smoke tests", () => {
  test("homepage loads and has title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Kanix/i);
  });

  test("homepage contains navigation", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("nav");
    await expect(nav).toBeVisible();
  });

  test("product catalog page loads", async ({ page }) => {
    const response = await page.goto("/products");
    expect(response?.status()).toBeLessThan(400);
  });
});
