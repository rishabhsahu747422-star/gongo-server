'use strict';

const { NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

/**
 * 404 Not Found Middleware.
 * Catches unmatched routes and passes a NotFoundError to the global error handler.
 */
function notFound(req, res, next) {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`, ERROR_CODES.NOT_FOUND));
}

module.exports = { notFound };
