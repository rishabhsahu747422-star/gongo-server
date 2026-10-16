'use strict';

const crypto = require('crypto');

const { runWithContext } = require('../utils/context');

// Standard UUID format regex (v1-v5)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Request ID Middleware.
 *
 * Checks for incoming X-Request-Id header.
 * - Accepts only safe, properly formatted UUIDs.
 * - Rejects malformed, oversized, or malicious values and replaces with secure v4 UUID.
 * - Attaches id to req.id, res.locals.requestId, and sets outgoing X-Request-Id header.
 * - Preserves execution context across async boundaries via AsyncLocalStorage.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requestIdMiddleware(req, res, next) {
  const incoming = req.headers['x-request-id'];
  let id;

  if (typeof incoming === 'string' && incoming.length === 36 && UUID_REGEX.test(incoming)) {
    id = incoming;
  } else {
    id = crypto.randomUUID();
  }

  req.id = id;
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);

  runWithContext({ requestId: id, route: `${req.method} ${req.originalUrl || req.url}` }, () => {
    next();
  });
}

module.exports = { requestIdMiddleware };
