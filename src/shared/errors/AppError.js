'use strict';

const { HTTP_STATUS } = require('../constants/api.constants');
const { ERROR_CODES } = require('../constants/error-codes.enum');

/**
 * AppError — Centralized Base Application Error class.
 */
class AppError extends Error {
  /**
   * @param {string} message Safe human-readable message
   * @param {number} statusCode HTTP status code
   * @param {string} code Stable machine-readable code
   * @param {boolean} isOperational Whether this is an operational error
   * @param {Array|object|null} details Optional details (e.g. validation issues)
   */
  constructor(
    message,
    statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR,
    code = ERROR_CODES.INTERNAL_ERROR,
    isOperational = true,
    details = null,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = details;

    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = null, code = ERROR_CODES.VALIDATION_ERROR) {
    super(message, HTTP_STATUS.BAD_REQUEST, code, true, details);
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Bad request', code = ERROR_CODES.BAD_REQUEST, details = null) {
    super(message, HTTP_STATUS.BAD_REQUEST, code, true, details);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = ERROR_CODES.AUTH_REQUIRED) {
    super(message, HTTP_STATUS.UNAUTHORIZED, code, true);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden', code = ERROR_CODES.FORBIDDEN) {
    super(message, HTTP_STATUS.FORBIDDEN, code, true);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = ERROR_CODES.NOT_FOUND) {
    super(message, HTTP_STATUS.NOT_FOUND, code, true);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict', code = ERROR_CODES.CONFLICT) {
    super(message, HTTP_STATUS.CONFLICT, code, true);
  }
}

class InternalServerError extends AppError {
  constructor(message = 'Internal server error', code = ERROR_CODES.INTERNAL_ERROR) {
    super(message, HTTP_STATUS.INTERNAL_SERVER_ERROR, code, false);
  }
}

module.exports = {
  AppError,
  ValidationError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InternalServerError,
  InternalError: InternalServerError,
};
