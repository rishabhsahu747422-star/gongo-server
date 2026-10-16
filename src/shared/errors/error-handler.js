'use strict';

const { AppError } = require('./AppError');
const { HTTP_STATUS } = require('../constants/api.constants');
const { ERROR_CODES } = require('../constants/error-codes.enum');

/**
 * Centralized Express Error Handler Middleware.
 * Never leaks stack traces or SQL internals in production.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;
  const isOperational = err.isOperational !== undefined ? err.isOperational : false;
  const code = err.code || (statusCode >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.BAD_REQUEST);

  const response = {
    success: false,
    error: {
      code,
      message: isOperational || process.env.NODE_ENV !== 'production'
        ? err.message
        : 'An internal error occurred. Please try again later.',
    },
    requestId: req.id || req.headers['x-request-id'] || null,
  };

  if (err.details) {
    response.error.details = err.details;
  }

  res.status(statusCode).json(response);
}

module.exports = { errorHandler };
