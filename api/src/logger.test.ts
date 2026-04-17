import { describe, it, expect } from "vitest";
import { createLogger, generateCorrelationId, withCorrelationId } from "./logger.js";
import { Writable } from "node:stream";

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

describe("logger", () => {
  describe("createLogger", () => {
    it("outputs structured JSON with timestamp, level, and message", () => {
      const { stream, lines } = captureOutput();
      const logger = createLogger({ level: "DEBUG", module: "test", destination: stream });

      logger.info("hello world");
      stream.end();

      expect(lines.length).toBe(1);
      const entry = lines[0];
      expect(entry).toHaveProperty("time");
      expect(entry).toHaveProperty("level");
      expect(entry).toHaveProperty("msg", "hello world");
      expect(entry).toHaveProperty("module", "test");
    });

    it("respects the configured log level", () => {
      const { stream, lines } = captureOutput();
      const logger = createLogger({ level: "ERROR", module: "test", destination: stream });

      logger.debug("should not appear");
      logger.info("should not appear");
      logger.warn("should not appear");
      logger.error("should appear");
      stream.end();

      expect(lines.length).toBe(1);
      expect(lines[0]).toHaveProperty("msg", "should appear");
    });
  });

  describe("JSON output format", () => {
    it("produces JSON with all required fields: timestamp, level, message, module, correlationId", () => {
      const { stream, lines } = captureOutput();
      const logger = createLogger({ level: "DEBUG", module: "myModule", destination: stream });

      const child = withCorrelationId(logger, "test-correlation-123");
      child.info("request received");
      stream.end();

      expect(lines.length).toBe(1);
      const entry = lines[0];
      expect(entry).toHaveProperty("time");
      expect(typeof entry["time"]).toBe("string");
      expect(entry).toHaveProperty("level");
      expect(entry).toHaveProperty("msg", "request received");
      expect(entry).toHaveProperty("module", "myModule");
      expect(entry).toHaveProperty("correlationId", "test-correlation-123");
    });
  });

  describe("generateCorrelationId", () => {
    it("returns a valid UUID", () => {
      const id = generateCorrelationId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("returns unique values", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("withCorrelationId", () => {
    it("creates a child logger with correlationId", () => {
      const { stream, lines } = captureOutput();
      const logger = createLogger({ level: "DEBUG", module: "api", destination: stream });

      const child = withCorrelationId(logger, "req-abc-123");
      child.info("handling request");
      stream.end();

      expect(lines.length).toBe(1);
      expect(lines[0]).toHaveProperty("correlationId", "req-abc-123");
      expect(lines[0]).toHaveProperty("msg", "handling request");
    });

    it("generates a correlationId when none is provided", () => {
      const { stream, lines } = captureOutput();
      const logger = createLogger({ level: "DEBUG", destination: stream });

      const child = withCorrelationId(logger);
      child.info("auto-id");
      stream.end();

      expect(lines.length).toBe(1);
      expect(lines[0]).toHaveProperty("correlationId");
      expect(typeof lines[0]["correlationId"]).toBe("string");
      expect(lines[0]["correlationId"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe("level mapping", () => {
    it.each([
      ["DEBUG", 20],
      ["INFO", 30],
      ["WARN", 40],
      ["ERROR", 50],
      ["FATAL", 60],
    ] as const)("maps %s to pino numeric level %d", (configLevel, expectedNumeric) => {
      const { stream, lines } = captureOutput();
      const logger = createLogger({ level: "DEBUG", destination: stream });

      const levelName = configLevel.toLowerCase();
      (logger as unknown as Record<string, (msg: string) => void>)[levelName]("test message");
      stream.end();

      expect(lines.length).toBe(1);
      expect(lines[0]).toHaveProperty("level", expectedNumeric);
    });
  });
});
