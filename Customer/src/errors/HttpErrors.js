'use strict';

const AppError = require('./AppError');
const { HTTP_STATUS } = require('../constants/http');

/**
 * 400 Bad Request
 * The client sent a request that cannot be processed (malformed JSON, missing fields, etc.)
 */
class BadRequestError extends AppError {
  constructor(message = 'Bad request', code = 'BAD_REQUEST') {
    super(message, HTTP_STATUS.BAD_REQUEST, code, true);
  }
}

/**
 * 401 Unauthorized
 * Missing, invalid, or expired authentication credentials.
 */
class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(message, HTTP_STATUS.UNAUTHORIZED, code, true);
  }
}

/**
 * 403 Forbidden
 * Authenticated user does not possess permissions/role for this resource.
 */
class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden', code = 'FORBIDDEN') {
    super(message, HTTP_STATUS.FORBIDDEN, code, true);
  }
}

/**
 * 404 Not Found
 * The requested resource does not exist.
 */
class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found', code = 'NOT_FOUND') {
    super(message, HTTP_STATUS.NOT_FOUND, code, true);
  }
}

/**
 * 409 Conflict
 * The request conflicts with the current state (duplicate entry, version mismatch, etc.)
 */
class ConflictError extends AppError {
  constructor(message = 'A conflict occurred with the current state', code = 'CONFLICT') {
    super(message, HTTP_STATUS.CONFLICT, code, true);
  }
}

/**
 * 422 Unprocessable Entity
 * Validation failed — the request was well-formed but semantically invalid.
 */
class UnprocessableEntityError extends AppError {
  constructor(message = 'Validation failed', code = 'VALIDATION_ERROR', errors = []) {
    super(message, HTTP_STATUS.UNPROCESSABLE_ENTITY, code, true);
    // `errors` carries field-level validation details (safe, user-facing)
    this.errors = errors;
  }
}

/**
 * 429 Too Many Requests
 * Rate limit exceeded.
 */
class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests, please try again later', code = 'RATE_LIMIT_EXCEEDED') {
    super(message, HTTP_STATUS.TOO_MANY_REQUESTS, code, true);
  }
}

/**
 * 500 Internal Server Error
 * Unexpected server failure. isOperational = false → triggers graceful restart signal.
 * The message sent to the client is always "An unexpected error occurred".
 */
class InternalServerError extends AppError {
  constructor(message = 'An unexpected error occurred', code = 'INTERNAL_SERVER_ERROR') {
    super(message, HTTP_STATUS.INTERNAL_SERVER_ERROR, code, false);
  }
}

/**
 * 503 Service Unavailable
 * A dependency (e.g. database) is temporarily unavailable. isOperational = true.
 */
class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', code = 'SERVICE_UNAVAILABLE') {
    super(message, HTTP_STATUS.SERVICE_UNAVAILABLE, code, true);
  }
}

module.exports = {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  TooManyRequestsError,
  InternalServerError,
  ServiceUnavailableError,
};
