/**
 * Kanix Vitest reporter — emits the canonical spec-kit structured test output.
 *
 * Schema contract: `.claude/skills/spec-kit/reference/templates/EXAMPLE-OUTPUT.md`
 * in the agent-framework repo. DO NOT diverge from the schema — the spec-kit
 * runner and fix-validate agents read these files directly.
 *
 * Output layout (rooted at `api/` since that's cwd when tests run):
 *   api/test-logs/
 *     summary.json                 ← latest run, always overwritten
 *     <type>/<timestamp>/
 *       summary.json               ← per-run historical copy
 *       failures/<sanitized>.log   ← one file per failing test
 */

import type { File, Reporter, Task, TaskResult, TaskResultPack } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const RUN_TYPE = process.env.TEST_TYPE ?? "integration";
const PROJECT_ROOT = process.cwd();
const LOG_ROOT = join(PROJECT_ROOT, "test-logs");

type Status = "passed" | "failed" | "skipped";

interface ResultEntry {
  name: string;
  file: string;
  status: Status;
  duration_ms: number;
  failure_log?: string;
  error?: { message: string; expected?: string; actual?: string; stack?: string };
  reason?: string;
}

interface Summary {
  timestamp: string;
  duration_ms: number;
  type: string;
  pass: number;
  fail: number;
  skip: number;
  total: number;
  command: string;
  failures: string[];
  results: ResultEntry[];
}

function sanitizeName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

function nowIsoCompact(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export default class SpecKitReporter implements Reporter {
  private results: ResultEntry[] = [];
  private startTime = 0;

  onInit(): void {
    this.startTime = Date.now();
    this.results = [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by Reporter interface
  onTaskUpdate(_packs: TaskResultPack[]): void {
    // Results are collected in onFinished from the files
  }

  onFinished(files?: File[]): void {
    // Vitest may invoke onFinished multiple times (e.g. a spurious empty
    // callback before the real run, or once per fork pool completion). An
    // invocation with no files and no previously-collected results is not a
    // real test run — it's noise. Writing a 0/0/0 summary here overwrites
    // the real summary and trips the vacuous-run guard with exit 1 even
    // though every test passed. Skip it.
    if ((files?.length ?? 0) === 0 && this.results.length === 0) {
      return;
    }

    const timestamp = new Date().toISOString();
    const runDir = join(LOG_ROOT, RUN_TYPE, nowIsoCompact());
    const failuresDir = join(runDir, "failures");
    mkdirSync(failuresDir, { recursive: true });

    for (const file of files ?? []) {
      this.collectTasks(file.tasks, file.filepath, failuresDir);
    }

    const pass = this.results.filter((r) => r.status === "passed").length;
    const fail = this.results.filter((r) => r.status === "failed").length;
    const skip = this.results.filter((r) => r.status === "skipped").length;

    const summary: Summary = {
      timestamp,
      duration_ms: Date.now() - this.startTime,
      type: RUN_TYPE,
      pass,
      fail,
      skip,
      total: pass + fail + skip,
      command: process.env.npm_lifecycle_script ?? process.argv.slice(1).join(" "),
      failures: this.results.filter((r) => r.status === "failed").map((r) => r.name),
      results: this.results,
    };

    const runSummaryPath = join(runDir, "summary.json");
    const latestSummaryPath = join(LOG_ROOT, "summary.json");
    mkdirSync(dirname(latestSummaryPath), { recursive: true });
    const payload = JSON.stringify(summary, null, 2) + "\n";
    writeFileSync(runSummaryPath, payload);
    writeFileSync(latestSummaryPath, payload);

    if (pass + fail === 0) {
      process.stderr.write(
        `\n[test-reporter] FATAL: vacuous run — 0 passed and 0 failed. Tests did not run.\n`,
      );
      process.exitCode = 1;
      return;
    }

    if (skip > 0) {
      const skippedNames = this.results
        .filter((r) => r.status === "skipped")
        .map((r) => `  - ${r.name}`)
        .join("\n");
      process.stderr.write(
        `\n[test-reporter] FATAL: ${skip} test(s) skipped:\n${skippedNames}\n` +
          `Skipped tests mean the environment is broken or a dependency is missing. ` +
          `Skips are not allowed — every integration test must exercise the whole app against live services. ` +
          `Start required services (process-compose up) or remove any runtime skip guards.\n`,
      );
      process.exitCode = 1;
    }
  }

  private collectTasks(
    tasks: File["tasks"],
    filepath: string,
    failuresDir: string,
    prefix = "",
  ): void {
    for (const task of tasks) {
      if (task.type === "suite" && "tasks" in task) {
        const suiteName = prefix ? `${prefix} > ${task.name}` : task.name;
        this.collectTasks(task.tasks, filepath, failuresDir, suiteName);
      } else if (task.type === "test") {
        const fullName = prefix ? `${prefix} > ${task.name}` : task.name;
        const relFile = relative(PROJECT_ROOT, filepath);
        const result: TaskResult | undefined = task.result;
        const duration_ms = Math.round(result?.duration ?? 0);
        let status: Status = "skipped";
        if (result?.state === "pass") status = "passed";
        else if (result?.state === "fail") status = "failed";
        else if ((task as Task).mode === "skip" || (task as Task).mode === "todo")
          status = "skipped";

        const entry: ResultEntry = { name: fullName, file: relFile, status, duration_ms };

        if (status === "failed") {
          const err = result?.errors?.[0];
          const logName = `${sanitizeName(fullName)}.log`;
          const logPath = join(failuresDir, logName);
          const body = [
            `Test: ${fullName}`,
            `File: ${relFile}`,
            `Duration: ${duration_ms}ms`,
            "",
            "ASSERTION FAILURE",
            `  Message:  ${err?.message ?? "(no message)"}`,
            err?.expected != null ? `  Expected: ${String(err.expected)}` : "",
            err?.actual != null ? `  Actual:   ${String(err.actual)}` : "",
            "",
            "STACK TRACE",
            err?.stack ?? "(no stack)",
          ]
            .filter(Boolean)
            .join("\n");
          writeFileSync(logPath, body + "\n");
          entry.failure_log = relative(PROJECT_ROOT, logPath);
          entry.error = {
            message: err?.message ?? "(no message)",
            expected: err?.expected != null ? String(err.expected) : undefined,
            actual: err?.actual != null ? String(err.actual) : undefined,
            stack: err?.stack,
          };
        }

        this.results.push(entry);
      }
    }
  }
}
