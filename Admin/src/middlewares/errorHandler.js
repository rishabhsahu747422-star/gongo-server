'use strict';

const { AppError } = require('../errors');
const { HTTP_STATUS } = require('../constants/http');
const { ERROR_CODES } = require('../constants/errors');
const { formatErrorPayload } = require('../utils/response');
const logger = require('../config/logger');

const PG_ERROR_MAP = {
  '23505': { statusCode: HTTP_STATUS.CONFLICT, message: 'A record with the provided information already exists', code: ERROR_CODES.CONFLICT },
  '23503': { statusCode: HTTP_STATUS.CONFLICT, message: 'The referenced entity does not exist or has active associations', code: ERROR_CODES.CONFLICT },
  '23502': { statusCode: HTTP_STATUS.BAD_REQUEST, message: 'Required input value is missing', code: ERROR_CODES.VALIDATION_ERROR },
  '22P02': { statusCode: HTTP_STATUS.BAD_REQUEST, message: 'Invalid data format provided', code: ERROR_CODES.VALIDATION_ERROR },
  '42P01': { statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR, message: 'An internal server error occurred', code: ERROR_CODES.INTERNAL_ERROR },
};

/**
 * Global centralized error handling middleware.
 * Must declare 4 arguments (err, req, res, next) for Express to recognize it.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const requestId = (res.locals && res.locals.requestId) || (req && req.id) || null;

  let statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR;
  let code = ERROR_CODES.INTERNAL_ERROR;
  let message = 'An unexpected internal error occurred';
  let details = null;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;

    if (statusCode >= 500) {
      logger.error('Operational server error', {
        requestId,
        code,
        message,
        stack: err.stack,
      });
    } else {
      logger.warn('Client operational error', {
        requestId,
        code,
        message,
        method: req.method,
        // Path only: query strings may carry OAuth codes/state or other credentials
        url: String(req.originalUrl || '').split('?')[0],
      });
    }
  } else if (
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P02', '57P03'].includes(err.code)
    || (err.message && (err.message.includes('Connection terminated') || err.message.includes('Connection refused') || err.message.includes('database is unreachable')))
  ) {
    statusCode = HTTP_STATUS.SERVICE_UNAVAILABLE;
    code = ERROR_CODES.SERVICE_UNAVAILABLE;
    message = 'Database service is temporarily unavailable';

    logger.error('Database connectivity error during request processing', {
      requestId,
      code: err.code,
      message: err.message,
    });
  } else if (err.code && PG_ERROR_MAP[err.code]) {
    const mapped = PG_ERROR_MAP[err.code];
    statusCode = mapped.statusCode;
    code = mapped.code;
    message = mapped.message;

    logger.warn('Database constraint error', {
      requestId,
      pgCode: err.code,
      mappedCode: code,
    });
  } else if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    statusCode = HTTP_STATUS.BAD_REQUEST;
    code = ERROR_CODES.INVALID_JSON;
    message = 'Malformed JSON in request body';

    logger.warn('JSON parsing failure', { requestId });
  } else if (err.type === 'entity.too.large') {
    statusCode = HTTP_STATUS.PAYLOAD_TOO_LARGE;
    code = ERROR_CODES.PAYLOAD_TOO_LARGE;
    message = 'Request payload exceeds the maximum allowed size limit';

    logger.warn('Payload too large', { requestId });
  } else if (err.message && err.message.includes('not allowed by CORS')) {
    statusCode = HTTP_STATUS.FORBIDDEN;
    code = ERROR_CODES.FORBIDDEN;
    message = err.message;

    logger.warn('CORS access rejected', { requestId, origin: req.headers.origin });
  } else {
    // Unhandled exception
    logger.error('Unhandled server exception', {
      requestId,
      name: err.name,
      message: err.message,
      stack: err.stack,
    });
  }

  const payload = formatErrorPayload(code, message, requestId, details);
  return res.status(statusCode).json(payload);
}

module.exports = { errorHandler };
