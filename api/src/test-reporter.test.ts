import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { File as VitestFile } from "vitest";
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

    // Synthesize a minimal File shape that triggers the summary write path.
    // onFinished with empty files AND no prior results is treated as a
    // spurious vitest callback and returns early (see comment in
    // test-reporter.ts). Passing a File with a single passed test exercises
    // the real write path without depending on the spurious-call behavior.
    // The reporter only reads `filepath` and walks `tasks`, so the full
    // vitest File type isn't needed — cast via unknown.
    const fakeFile = {
      filepath: "/tmp/synthetic.test.ts",
      tasks: [
        {
          type: "test",
          name: "synthetic",
          result: { state: "pass", duration: 1 },
        },
      ],
    } as unknown as VitestFile;
    reporter.onInit();
    reporter.onFinished([fakeFile]);

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
    expect(summary.pass).toBe(1);
    expect(summary.fail).toBe(0);
    expect(summary.skip).toBe(0);
    expect(summary.total).toBe(1);
  });

  afterEach(() => {
    if (existsSync(SUMMARY_PATH)) {
      rmSync(SUMMARY_PATH);
    }
  });
});
