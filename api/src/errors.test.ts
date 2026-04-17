import { describe, expect, it } from "vitest";
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ExternalServiceError,
  InternalError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "./errors.js";

describe("AppError base class", () => {
  it("stores errorCode, httpStatus, userFacing, and message", () => {
    const err = new AppError("something broke", "ERR_CUSTOM", 418, true);
    expect(err.message).toBe("something broke");
    expect(err.errorCode).toBe("ERR_CUSTOM");
    expect(err.httpStatus).toBe(418);
    expect(err.userFacing).toBe(true);
    expect(err.name).toBe("AppError");
    expect(err).toBeInstanceOf(Error);
  });

  it("defaults userFacing to false", () => {
    const err = new AppError("internal", "ERR_X", 500);
    expect(err.userFacing).toBe(false);
  });
});

describe("Error subclasses", () => {
  const cases: Array<{
    name: string;
    create: () => AppError;
    expectedStatus: number;
    expectedCode: string;
    expectedUserFacing: boolean;
    expectedName: string;
  }> = [
    {
      name: "ValidationError",
      create: () => new ValidationError("bad input"),
      expectedStatus: 400,
      expectedCode: "ERR_VALIDATION_FAILED",
      expectedUserFacing: true,
      expectedName: "ValidationError",
    },
    {
      name: "AuthenticationError",
      create: () => new AuthenticationError("not authenticated"),
      expectedStatus: 401,
      expectedCode: "ERR_AUTHENTICATION_FAILED",
      expectedUserFacing: true,
      expectedName: "AuthenticationError",
    },
    {
      name: "AuthorizationError",
      create: () => new AuthorizationError("forbidden"),
      expectedStatus: 403,
      expectedCode: "ERR_AUTHORIZATION_FAILED",
      expectedUserFacing: true,
      expectedName: "AuthorizationError",
    },
    {
      name: "NotFoundError",
      create: () => new NotFoundError("not found"),
      expectedStatus: 404,
      expectedCode: "ERR_NOT_FOUND",
      expectedUserFacing: true,
      expectedName: "NotFoundError",
    },
    {
      name: "ConflictError",
      create: () => new ConflictError("conflict"),
      expectedStatus: 409,
      expectedCode: "ERR_CONFLICT",
      expectedUserFacing: true,
      expectedName: "ConflictError",
    },
    {
      name: "RateLimitError",
      create: () => new RateLimitError("too many requests"),
      expectedStatus: 429,
      expectedCode: "ERR_RATE_LIMIT_EXCEEDED",
      expectedUserFacing: true,
      expectedName: "RateLimitError",
    },
    {
      name: "InternalError",
      create: () => new InternalError("server error"),
      expectedStatus: 500,
      expectedCode: "ERR_INTERNAL",
      expectedUserFacing: false,
      expectedName: "InternalError",
    },
    {
      name: "ExternalServiceError",
      create: () => new ExternalServiceError("upstream failed"),
      expectedStatus: 502,
      expectedCode: "ERR_EXTERNAL_SERVICE",
      expectedUserFacing: false,
      expectedName: "ExternalServiceError",
    },
  ];

  for (const tc of cases) {
    describe(tc.name, () => {
      it(`has httpStatus ${tc.expectedStatus}`, () => {
        const err = tc.create();
        expect(err.httpStatus).toBe(tc.expectedStatus);
      });

      it(`has default errorCode ${tc.expectedCode}`, () => {
        const err = tc.create();
        expect(err.errorCode).toBe(tc.expectedCode);
      });

      it(`has userFacing=${tc.expectedUserFacing}`, () => {
        const err = tc.create();
        expect(err.userFacing).toBe(tc.expectedUserFacing);
      });

      it(`has name=${tc.expectedName}`, () => {
        const err = tc.create();
        expect(err.name).toBe(tc.expectedName);
      });

      it("is instanceof AppError and Error", () => {
        const err = tc.create();
        expect(err).toBeInstanceOf(AppError);
        expect(err).toBeInstanceOf(Error);
      });
    });
  }
});

describe("Custom error codes", () => {
  it("ValidationError accepts custom errorCode", () => {
    const err = new ValidationError("bad email", "ERR_INVALID_EMAIL");
    expect(err.errorCode).toBe("ERR_INVALID_EMAIL");
    expect(err.httpStatus).toBe(400);
  });

  it("NotFoundError accepts custom errorCode", () => {
    const err = new NotFoundError("order not found", "ERR_ORDER_NOT_FOUND");
    expect(err.errorCode).toBe("ERR_ORDER_NOT_FOUND");
    expect(err.httpStatus).toBe(404);
  });

  it("ConflictError accepts custom errorCode", () => {
    const err = new ConflictError("duplicate", "ERR_DUPLICATE_SKU");
    expect(err.errorCode).toBe("ERR_DUPLICATE_SKU");
    expect(err.httpStatus).toBe(409);
  });

  it("AuthenticationError accepts custom errorCode", () => {
    const err = new AuthenticationError("expired", "ERR_TOKEN_EXPIRED");
    expect(err.errorCode).toBe("ERR_TOKEN_EXPIRED");
    expect(err.httpStatus).toBe(401);
  });

  it("AuthorizationError accepts custom errorCode", () => {
    const err = new AuthorizationError("no access", "ERR_INSUFFICIENT_ROLE");
    expect(err.errorCode).toBe("ERR_INSUFFICIENT_ROLE");
    expect(err.httpStatus).toBe(403);
  });

  it("ExternalServiceError accepts custom errorCode", () => {
    const err = new ExternalServiceError("stripe down", "ERR_STRIPE_FAILURE");
    expect(err.errorCode).toBe("ERR_STRIPE_FAILURE");
    expect(err.httpStatus).toBe(502);
  });

  it("RateLimitError accepts custom errorCode", () => {
    const err = new RateLimitError("slow down", "ERR_API_RATE_LIMIT");
    expect(err.errorCode).toBe("ERR_API_RATE_LIMIT");
    expect(err.httpStatus).toBe(429);
  });

  it("InternalError accepts custom errorCode", () => {
    const err = new InternalError("db crash", "ERR_DB_CONNECTION");
    expect(err.errorCode).toBe("ERR_DB_CONNECTION");
    expect(err.httpStatus).toBe(500);
  });
});
