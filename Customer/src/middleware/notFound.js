'use strict';

const { NotFoundError } = require('../errors');

/**
 * 404 Not Found handler.
 *
 * This middleware must be mounted AFTER all route handlers.
 * Any request that reaches here did not match a defined route.
 *
 * Creates a NotFoundError and passes it to the global error handler
 * via next() — it does NOT send the response directly.
 * This keeps all response formatting in one place (errorHandler).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function notFound(req, res, next) {
  next(new NotFoundError(`Route '${req.method} ${req.originalUrl}' not found`));
}

module.exports = { notFound };
