import type { FastifyInstance, FastifyError } from "fastify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationErrorDetail {
  field: string;
  message: string;
}

export interface ValidationErrorResponse {
  error: "validation_failed";
  details: ValidationErrorDetail[];
}

// ---------------------------------------------------------------------------
// Ajv options for Fastify constructor
// ---------------------------------------------------------------------------

/** Ajv customOptions to pass to the Fastify constructor. */
export const ajvOptions = {
  customOptions: {
    removeAdditional: true,
    allErrors: true,
  },
};

// ---------------------------------------------------------------------------
// Validation error handler plugin
// ---------------------------------------------------------------------------

/**
 * Registers a custom error handler that formats Fastify/Ajv validation errors
 * into a structured `{ error, details }` response.
 */
export function registerValidation(app: FastifyInstance): void {
  app.setErrorHandler(async (error: FastifyError, _request, reply) => {
    if (error.validation) {
      const details: ValidationErrorDetail[] = error.validation.map((v) => {
        const field = formatFieldPath(v.instancePath, v.params);
        const message = v.message ?? "Invalid value";
        return { field, message };
      });

      const response: ValidationErrorResponse = {
        error: "validation_failed",
        details,
      };

      return reply.status(400).send(response);
    }

    // Re-throw non-validation errors so the default (or future global) handler picks them up
    return reply
      .status(error.statusCode ?? 500)
      .send({ error: error.message ?? "Internal server error" });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFieldPath(instancePath: string, params?: Record<string, unknown>): string {
  // For "required" errors, instancePath is the parent and params.missingProperty has the field name
  if (params?.missingProperty) {
    const prefix = instancePath ? instancePath.slice(1) + "." : "";
    return prefix + String(params.missingProperty);
  }

  // For other errors, instancePath is like "/fieldName" — strip the leading slash
  if (instancePath) {
    return instancePath.slice(1).replace(/\//g, ".");
  }

  return "body";
}
