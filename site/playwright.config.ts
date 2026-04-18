import { defineConfig, devices } from "@playwright/test";

const ASTRO_URL = process.env.ASTRO_URL ?? "http://127.0.0.1:4321";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          process.env.PW_JSON_OUTPUT ??
          "../test-logs/e2e/playwright-results.json",
      },
    ],
  ],
  use: {
    baseURL: ASTRO_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
