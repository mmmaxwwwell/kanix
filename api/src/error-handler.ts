import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { AppError } from "./errors.js";
import type { ValidationErrorDetail, ValidationErrorResponse } from "./validation.js";

// ---------------------------------------------------------------------------
// Error response types
// ---------------------------------------------------------------------------

export interface AppErrorResponse {
  error: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

/**
 * Registers a global Fastify error handler that catches all errors at the
 * request boundary:
 *
 * 1. Fastify/Ajv validation errors → 400 with structured details
 * 2. AppError subclasses → correct HTTP status + error code
 * 3. Unknown errors → 500 with generic message (no stack leak)
 *
 * All errors are logged with correlationId, errorCode, and stack trace.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    async (
      error: FastifyError | AppError | Error,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const log = request.log;

      // --- Fastify/Ajv validation errors ---
      if ("validation" in error && (error as FastifyError).validation) {
        const fastifyError = error as FastifyError;
        const details: ValidationErrorDetail[] = (fastifyError.validation ?? []).map((v) => {
          const field = formatFieldPath(v.instancePath, v.params);
          const message = v.message ?? "Invalid value";
          return { field, message };
        });

        const response: ValidationErrorResponse = {
          error: "validation_failed",
          details,
        };

        log.warn({ errorCode: "ERR_VALIDATION_FAILED", err: error }, "Validation error");

        return reply.status(400).send(response);
      }

      // --- AppError subclasses ---
      if (error instanceof AppError) {
        log.error(
          {
            errorCode: error.errorCode,
            err: error,
          },
          error.message,
        );

        const response: AppErrorResponse = {
          error: error.errorCode,
          message: error.userFacing ? error.message : "Internal server error",
        };

        return reply.status(error.httpStatus).send(response);
      }

      // --- Unknown / unexpected errors ---
      log.error(
        {
          errorCode: "ERR_INTERNAL",
          err: error,
        },
        "Unexpected error",
      );

      const response: AppErrorResponse = {
        error: "ERR_INTERNAL",
        message: "Internal server error",
      };

      return reply.status(500).send(response);
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers (moved from validation.ts)
// ---------------------------------------------------------------------------

function formatFieldPath(instancePath: string, params?: Record<string, unknown>): string {
  if (params?.missingProperty) {
    const prefix = instancePath ? instancePath.slice(1) + "." : "";
    return prefix + String(params.missingProperty);
  }

  if (instancePath) {
    return instancePath.slice(1).replace(/\//g, ".");
  }

  return "body";
}
