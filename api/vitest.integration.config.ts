import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: true,
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: Number(process.env.VITEST_MAX_FORKS ?? 2),
      },
    },
    reporters: ["default", "./src/test-reporter.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "json", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-reporter.ts"],
    },
  },
});
