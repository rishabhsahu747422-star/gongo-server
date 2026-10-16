'use strict';

const AppError = require('../errors/AppError');
const { HTTP_STATUS } = require('../constants/http');
const env = require('../config/env');
const logger = require('../config/logger');

/**
 * Maps known PostgreSQL error codes to safe, generic HTTP responses.
 * Raw pg error messages must NEVER reach the client — they may contain
 * table names, column names, constraint names, or partial data.
 *
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const PG_ERROR_MAP = {
  '23505': { statusCode: HTTP_STATUS.CONFLICT, message: 'A record with the provided data already exists', code: 'DUPLICATE_ENTRY' },
  '23503': { statusCode: HTTP_STATUS.CONFLICT, message: 'The operation references a record that does not exist', code: 'FOREIGN_KEY_VIOLATION' },
  '23502': { statusCode: HTTP_STATUS.UNPROCESSABLE_ENTITY, message: 'A required field is missing', code: 'NULL_CONSTRAINT_VIOLATION' },
  '22P02': { statusCode: HTTP_STATUS.BAD_REQUEST, message: 'Invalid data format provided', code: 'INVALID_DATA_FORMAT' },
  '42P01': { statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR, message: 'An unexpected error occurred', code: 'INTERNAL_SERVER_ERROR' },
};

/**
 * Formats the error response body.
 *
 * Production:  Generic message + requestId only. No stack, no SQL, no internals.
 * Development: Adds error code, status code, and stack for debugging.
 *
 * @param {Error} err
 * @param {string} requestId
 * @param {number} statusCode
 * @param {string} message
 * @param {string} code
 * @returns {object}
 */
function formatErrorResponse(err, requestId, statusCode, message, code) {
  const base = {
    success: false,
    message,
    code,
    requestId: requestId || null,
  };

  // Field-level validation errors (UnprocessableEntityError)
  if (err.errors && Array.isArray(err.errors) && err.errors.length > 0) {
    base.errors = err.errors;
  }

  // Structured error data (e.g. attemptsRemaining for OTP verification)
  if (err.data !== undefined) {
    base.data = err.data;
  }

  // In development only: add debug fields to help with local debugging
  if (env.NODE_ENV === 'development') {
    base._debug = {
      statusCode,
      stack: err.stack,
    };
  }

  return base;
}

/**
 * Global error handling middleware.
 *
 * MUST be registered with four arguments (err, req, res, next) for Express
 * to recognize it as an error handler. The `next` parameter is required
 * even if unused.
 *
 * Error classification:
 * 1. AppError (isOperational: true)  → Known, safe — use its message and statusCode.
 * 2. pg errors                        → Map to generic safe responses.
 * 3. Express body-parser errors       → 400 Bad Request with safe message.
 * 4. Everything else                  → 500, generic message, log as error.
 *
 * Logging:
 * - 5xx errors → logger.error (with stack)
 * - 4xx errors → logger.warn (no stack — expected client errors)
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const requestId = res.locals.requestId || null;

  let statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR;
  let message = 'An unexpected error occurred';
  let code = 'INTERNAL_SERVER_ERROR';

  // ── 1. Known operational AppError ─────────────────────────────
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    code = err.code;

    if (statusCode >= 500) {
      logger.error('Server error', {
        requestId,
        code,
        // Stack logged server-side only, never sent to client
        stack: err.stack,
      });
    } else {
      logger.warn('Client error', {
        requestId,
        code,
        message,
        method: req.method,
        url: req.originalUrl,
      });
    }
  } else if (err.code && PG_ERROR_MAP[err.code]) {
    // ── 2. PostgreSQL error ────────────────────────────────────────
    const mapped = PG_ERROR_MAP[err.code];
    statusCode = mapped.statusCode;
    message = mapped.message;
    code = mapped.code;

    logger.warn('Database constraint error', {
      requestId,
      pgCode: err.code, // pg code is safe to log (not sensitive)
      mappedCode: code,
    });
  } else if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    // ── 3. Express body-parser / JSON syntax error ─────────────────
    statusCode = HTTP_STATUS.BAD_REQUEST;
    message = 'Invalid JSON in request body';
    code = 'INVALID_JSON';

    logger.warn('JSON parse error', { requestId });
  } else if (err.type === 'entity.too.large') {
    // ── 4. Express payload too large ──────────────────────────────
    statusCode = HTTP_STATUS.BAD_REQUEST;
    message = 'Request body is too large';
    code = 'PAYLOAD_TOO_LARGE';

    logger.warn('Payload too large', { requestId });
  } else {
    // ── 5. Unhandled / programmer error ───────────────────────────
    logger.error('Unhandled error', {
      requestId,
      name: err.name,
      code: err.code || 'UNKNOWN',
      message: err.message,
      method: req.method,
      url: req.originalUrl,
      stack: err.stack,
    });
  }

  const body = formatErrorResponse(err, requestId, statusCode, message, code);
  return res.status(statusCode).json(body);
}

module.exports = { errorHandler };
