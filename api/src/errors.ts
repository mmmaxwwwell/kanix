/**
 * Typed error hierarchy for Kanix Commerce Platform.
 *
 * Every application error extends AppError with:
 * - errorCode: machine-readable code (e.g. ERR_ORDER_NOT_FOUND)
 * - httpStatus: HTTP status code for API responses
 * - userFacing: whether the message is safe to show to end users
 */

export class AppError extends Error {
  readonly errorCode: string;
  readonly httpStatus: number;
  readonly userFacing: boolean;

  constructor(message: string, errorCode: string, httpStatus: number, userFacing: boolean = false) {
    super(message);
    this.name = this.constructor.name;
    this.errorCode = errorCode;
    this.httpStatus = httpStatus;
    this.userFacing = userFacing;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, errorCode: string = "ERR_VALIDATION_FAILED") {
    super(message, errorCode, 400, true);
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string, errorCode: string = "ERR_AUTHENTICATION_FAILED") {
    super(message, errorCode, 401, true);
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string, errorCode: string = "ERR_AUTHORIZATION_FAILED") {
    super(message, errorCode, 403, true);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, errorCode: string = "ERR_NOT_FOUND") {
    super(message, errorCode, 404, true);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, errorCode: string = "ERR_CONFLICT") {
    super(message, errorCode, 409, true);
  }
}

export class RateLimitError extends AppError {
  constructor(message: string, errorCode: string = "ERR_RATE_LIMIT_EXCEEDED") {
    super(message, errorCode, 429, true);
  }
}

export class InternalError extends AppError {
  constructor(message: string, errorCode: string = "ERR_INTERNAL") {
    super(message, errorCode, 500, false);
  }
}

export class ExternalServiceError extends AppError {
  constructor(message: string, errorCode: string = "ERR_EXTERNAL_SERVICE") {
    super(message, errorCode, 502, false);
  }
}
