import pino from "pino";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Level mapping — Config uses uppercase, Pino uses lowercase
// ---------------------------------------------------------------------------

const LEVEL_MAP: Record<Config["LOG_LEVEL"], string> = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  FATAL: "fatal",
};

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

export interface CreateLoggerOptions {
  level: Config["LOG_LEVEL"];
  module?: string;
  destination?: pino.DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): pino.Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: LEVEL_MAP[options.level],
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(options.module ? { base: { module: options.module } } : {}),
  };
  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

// ---------------------------------------------------------------------------
// Correlation ID helpers
// ---------------------------------------------------------------------------

export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Creates a child logger with a correlationId bound to it.
 * Intended to be called once per incoming request via a Fastify hook.
 */
export function withCorrelationId(logger: pino.Logger, correlationId?: string): pino.Logger {
  return logger.child({ correlationId: correlationId ?? generateCorrelationId() });
}
