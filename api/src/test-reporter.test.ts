import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const TEST_LOGS_DIR = resolve(process.cwd(), "test-logs");
const RESULTS_PATH = resolve(TEST_LOGS_DIR, "test-results.json");

describe("JsonReporter", () => {
  beforeEach(() => {
    // Clean up previous test results so we verify fresh output
    if (existsSync(RESULTS_PATH)) {
      rmSync(RESULTS_PATH);
    }
  });

  it("should be loadable as a module", async () => {
    const mod = await import("./test-reporter.js");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });

  it("should implement required Reporter methods", async () => {
    const mod = await import("./test-reporter.js");
    const reporter = new mod.default();
    expect(typeof reporter.onInit).toBe("function");
    expect(typeof reporter.onFinished).toBe("function");
    expect(typeof reporter.onTaskUpdate).toBe("function");
  });

  it("should produce valid JSON report structure on onFinished", async () => {
    const mod = await import("./test-reporter.js");
    const reporter = new mod.default();

    reporter.onInit();
    // Call onFinished with empty files array to produce a report
    reporter.onFinished([]);

    expect(existsSync(RESULTS_PATH)).toBe(true);

    const report = JSON.parse(readFileSync(RESULTS_PATH, "utf-8"));
    expect(report).toHaveProperty("timestamp");
    expect(report).toHaveProperty("duration");
    expect(report).toHaveProperty("passed");
    expect(report).toHaveProperty("failed");
    expect(report).toHaveProperty("skipped");
    expect(report).toHaveProperty("total");
    expect(report).toHaveProperty("results");
    expect(Array.isArray(report.results)).toBe(true);
    expect(report.total).toBe(0);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);
  });

  afterEach(() => {
    // Clean up test-results.json created by unit test
    if (existsSync(RESULTS_PATH)) {
      rmSync(RESULTS_PATH);
    }
  });
});
