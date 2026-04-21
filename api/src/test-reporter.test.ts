import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const TEST_LOGS_DIR = resolve(process.cwd(), "test-logs");
const SUMMARY_PATH = resolve(TEST_LOGS_DIR, "summary.json");

describe("SpecKitReporter", () => {
  beforeEach(() => {
    if (existsSync(SUMMARY_PATH)) {
      rmSync(SUMMARY_PATH);
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

  it("should produce the canonical summary.json schema on onFinished", async () => {
    const mod = await import("./test-reporter.js");
    const reporter = new mod.default();

    reporter.onInit();
    reporter.onFinished([]);

    expect(existsSync(SUMMARY_PATH)).toBe(true);

    const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf-8"));
    for (const field of [
      "timestamp",
      "duration_ms",
      "type",
      "pass",
      "fail",
      "skip",
      "total",
      "command",
      "failures",
      "results",
    ]) {
      expect(summary, `missing field: ${field}`).toHaveProperty(field);
    }
    expect(Array.isArray(summary.results)).toBe(true);
    expect(Array.isArray(summary.failures)).toBe(true);
    expect(summary.total).toBe(0);
    expect(summary.pass).toBe(0);
    expect(summary.fail).toBe(0);
    expect(summary.skip).toBe(0);
  });

  afterEach(() => {
    if (existsSync(SUMMARY_PATH)) {
      rmSync(SUMMARY_PATH);
    }
  });
});
