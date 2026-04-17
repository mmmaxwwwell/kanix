import type { Reporter, File, TaskResultPack } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface TestResult {
  name: string;
  file: string;
  status: "passed" | "failed" | "skipped";
  duration: number;
  error?: string;
}

interface TestReport {
  timestamp: string;
  duration: number;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  results: TestResult[];
}

export default class JsonReporter implements Reporter {
  private results: TestResult[] = [];
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
    if (!files) return;

    for (const file of files) {
      this.collectTasks(file.tasks, file.filepath);
    }

    const duration = Date.now() - this.startTime;
    const passed = this.results.filter((r) => r.status === "passed").length;
    const failed = this.results.filter((r) => r.status === "failed").length;
    const skipped = this.results.filter((r) => r.status === "skipped").length;

    const report: TestReport = {
      timestamp: new Date().toISOString(),
      duration,
      passed,
      failed,
      skipped,
      total: this.results.length,
      results: this.results,
    };

    const outputPath = resolve(process.cwd(), "test-logs", "test-results.json");
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  }

  private collectTasks(tasks: File["tasks"], filepath: string, prefix = ""): void {
    for (const task of tasks) {
      if (task.type === "suite" && "tasks" in task) {
        const suiteName = prefix ? `${prefix} > ${task.name}` : task.name;
        this.collectTasks(task.tasks, filepath, suiteName);
      } else if (task.type === "test") {
        const name = prefix ? `${prefix} > ${task.name}` : task.name;
        const result = task.result;
        let status: TestResult["status"] = "skipped";
        if (result?.state === "pass") status = "passed";
        else if (result?.state === "fail") status = "failed";

        const entry: TestResult = {
          name,
          file: filepath,
          status,
          duration: result?.duration ?? 0,
        };

        if (status === "failed" && result?.errors?.length) {
          entry.error = result.errors.map((e) => e.message).join("\n");
        }

        this.results.push(entry);
      }
    }
  }
}
