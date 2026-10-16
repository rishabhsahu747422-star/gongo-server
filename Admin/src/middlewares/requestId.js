'use strict';

const { v4: uuidv4, validate: uuidValidate } = require('uuid');
const { runWithContext } = require('../utils/context');

/**
 * Middleware ensuring every request carries a unique, validated correlation ID.
 * Reads X-Request-ID from client header or generates a new RFC 4122 v4 UUID.
 * Sets the ID on request, response headers, res.locals, and AsyncLocalStorage context.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requestIdMiddleware(req, res, next) {
  const incoming = req.headers['x-request-id'];

  let requestId;
  if (
    incoming
    && typeof incoming === 'string'
    && incoming.length <= 36
    && !/[\r\n\0]/.test(incoming)
    && uuidValidate(incoming.trim())
  ) {
    requestId = incoming.trim();
  } else {
    requestId = uuidv4();
  }

  req.id = requestId;
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  const route = `${req.method} ${req.originalUrl || req.url || ''}`;
  runWithContext({ requestId, route }, () => {
    next();
  });
}

module.exports = { requestIdMiddleware };
