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
