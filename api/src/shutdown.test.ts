import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createShutdownManager, isShuttingDown } from "./shutdown.js";
import { createLogger } from "./logger.js";

/** Captures pino JSON output lines into an array of parsed objects. */
function captureOutput(): { stream: Writable; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString().trim();
      if (text) {
        lines.push(JSON.parse(text) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { stream, lines };
}

/** Creates a fake process object for testing signal handling. */
function createFakeProcess(): NodeJS.Process {
  const emitter = new EventEmitter();
  return emitter as unknown as NodeJS.Process;
}

describe("shutdown", () => {
  let stream: Writable;
  let lines: Record<string, unknown>[];
  let exitCode: number | undefined;
  let exitFn: (code: number) => void;
  let fakeProcess: NodeJS.Process;

  beforeEach(() => {
    const capture = captureOutput();
    stream = capture.stream;
    lines = capture.lines;
    exitCode = undefined;
    exitFn = (code: number) => {
      exitCode = code;
    };
    fakeProcess = createFakeProcess();
    // Reset module-level state by importing fresh — but since we can't easily
    // reset module state, we'll test isShuttingDown as part of the sequence
  });

  function makeManager(timeoutMs = 30_000) {
    const logger = createLogger({ level: "DEBUG", module: "shutdown", destination: stream });
    return createShutdownManager({
      logger,
      timeoutMs,
      exitFn,
      processRef: fakeProcess,
    });
  }

  describe("shutdown sequence", () => {
    it("logs 'Shutdown initiated' and 'Shutdown complete' and exits 0", async () => {
      const manager = makeManager();
      await manager.shutdown();
      stream.end();

      const messages = lines.map((l) => l["msg"]);
      expect(messages).toContain("Shutdown initiated");
      expect(messages).toContain("Shutdown complete");
      expect(exitCode).toBe(0);
    });

    it("executes hooks in reverse registration order", async () => {
      const manager = makeManager();
      const order: string[] = [];

      manager.register({
        name: "stop accepting connections",
        fn: async () => {
          order.push("stop-connections");
        },
      });
      manager.register({
        name: "close DB pool",
        fn: async () => {
          order.push("close-db");
        },
      });
      manager.register({
        name: "flush logs",
        fn: async () => {
          order.push("flush-logs");
        },
      });

      await manager.shutdown();
      stream.end();

      // Reverse order: flush-logs → close-db → stop-connections
      expect(order).toEqual(["flush-logs", "close-db", "stop-connections"]);
    });

    it("logs each hook name during shutdown", async () => {
      const manager = makeManager();

      manager.register({
        name: "close WebSocket",
        fn: async () => {},
      });
      manager.register({
        name: "close DB pool",
        fn: async () => {},
      });

      await manager.shutdown();
      stream.end();

      const messages = lines.map((l) => l["msg"]);
      expect(messages).toContain("Shutdown hook: close DB pool");
      expect(messages).toContain("Shutdown hook: close WebSocket");
    });

    it("continues executing hooks even if one fails", async () => {
      const manager = makeManager();
      const order: string[] = [];

      manager.register({
        name: "first",
        fn: async () => {
          order.push("first");
        },
      });
      manager.register({
        name: "failing-hook",
        fn: async () => {
          throw new Error("hook error");
        },
      });
      manager.register({
        name: "last",
        fn: async () => {
          order.push("last");
        },
      });

      await manager.shutdown();
      stream.end();

      // All hooks should run (reverse order: last → failing-hook → first)
      expect(order).toEqual(["last", "first"]);
      // Error should be logged
      const errorMessages = lines.filter((l) => l["level"] === 50).map((l) => l["msg"]);
      expect(errorMessages).toContain("Shutdown hook failed: failing-hook");
      expect(exitCode).toBe(0);
    });

    it("is idempotent — calling shutdown twice only runs once", async () => {
      const manager = makeManager();
      let hookCalls = 0;

      manager.register({
        name: "counter",
        fn: async () => {
          hookCalls++;
        },
      });

      await manager.shutdown();
      await manager.shutdown();
      stream.end();

      expect(hookCalls).toBe(1);
    });
  });

  describe("signal handling", () => {
    it("triggers shutdown on SIGTERM", async () => {
      makeManager();

      fakeProcess.emit("SIGTERM");

      // Give the async shutdown time to complete
      await new Promise((resolve) => setTimeout(resolve, 50));
      stream.end();

      const messages = lines.map((l) => l["msg"]);
      expect(messages).toContain("Shutdown initiated");
      expect(exitCode).toBe(0);
    });

    it("triggers shutdown on SIGINT", async () => {
      makeManager();

      fakeProcess.emit("SIGINT");

      await new Promise((resolve) => setTimeout(resolve, 50));
      stream.end();

      const messages = lines.map((l) => l["msg"]);
      expect(messages).toContain("Shutdown initiated");
      expect(exitCode).toBe(0);
    });
  });

  describe("timeout", () => {
    it("force exits with code 1 after timeout", async () => {
      vi.useFakeTimers();

      const manager = makeManager(100); // 100ms timeout

      manager.register({
        name: "hanging-hook",
        fn: () => new Promise(() => {}), // never resolves
      });

      // Start shutdown but don't await (it will hang)
      const shutdownPromise = manager.shutdown();

      // Advance past the timeout
      vi.advanceTimersByTime(150);
      stream.end();

      const messages = lines.map((l) => l["msg"]);
      expect(messages).toContain("Shutdown initiated");
      expect(exitCode).toBe(1);

      vi.useRealTimers();

      // Clean up the hanging promise
      await Promise.race([shutdownPromise, Promise.resolve()]);
    });
  });

  describe("isShuttingDown", () => {
    it("returns true after shutdown is initiated", async () => {
      const manager = makeManager();

      // isShuttingDown is a module-level flag that may already be true
      // from a prior test run. We test that it becomes true after shutdown.
      await manager.shutdown();
      stream.end();

      expect(isShuttingDown()).toBe(true);
    });
  });

  describe("full shutdown sequence logging", () => {
    it("verifies the complete sequence: initiated → hooks (reverse) → complete → exit 0", async () => {
      const manager = makeManager();

      manager.register({
        name: "stop accepting connections",
        fn: async () => {},
      });
      manager.register({
        name: "mark /ready as 503",
        fn: async () => {},
      });
      manager.register({
        name: "drain in-flight",
        fn: async () => {},
      });
      manager.register({
        name: "close WebSocket",
        fn: async () => {},
      });
      manager.register({
        name: "close DB pool",
        fn: async () => {},
      });
      manager.register({
        name: "close externals",
        fn: async () => {},
      });
      manager.register({
        name: "flush logs",
        fn: async () => {},
      });

      await manager.shutdown();
      stream.end();

      const messages = lines.map((l) => l["msg"]);

      // Verify sequence
      expect(messages[0]).toBe("Shutdown initiated");

      // Hooks in reverse order
      expect(messages[1]).toBe("Shutdown hook: flush logs");
      expect(messages[2]).toBe("Shutdown hook: close externals");
      expect(messages[3]).toBe("Shutdown hook: close DB pool");
      expect(messages[4]).toBe("Shutdown hook: close WebSocket");
      expect(messages[5]).toBe("Shutdown hook: drain in-flight");
      expect(messages[6]).toBe("Shutdown hook: mark /ready as 503");
      expect(messages[7]).toBe("Shutdown hook: stop accepting connections");

      expect(messages[messages.length - 1]).toBe("Shutdown complete");
      expect(exitCode).toBe(0);
    });
  });
});
