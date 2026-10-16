'use strict';

const { NotFoundError } = require('./AppError');

/**
 * 404 Route Not Found middleware.
 */
function notFoundHandler(req, res, next) {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`));
}

module.exports = { notFoundHandler };
