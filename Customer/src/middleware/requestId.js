'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Request ID middleware.
 *
 * Attaches a unique UUID v4 to every incoming request for log correlation.
 *
 * - `req.id` — available to all downstream middleware and route handlers.
 * - `res.locals.requestId` — used by sendSuccess() to embed in every response.
 * - `X-Request-ID` response header — returned to the client so they can
 *   reference it in bug reports and support tickets.
 *
 * If the client sends an `X-Request-ID` header, it is IGNORED and a fresh
 * server-generated ID is used. Trusting client-supplied IDs would allow
 * clients to forge log entries.
 */
const { runWithContext } = require('../utils/context');

function requestId(req, res, next) {
  const id = uuidv4();
  req.id = id;
  res.locals.requestId = id;
  res.setHeader('X-Request-ID', id);
  runWithContext({ requestId: id, route: `${req.method} ${req.originalUrl || req.url}` }, () => {
    next();
  });
}

module.exports = { requestId };
