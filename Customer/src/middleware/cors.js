'use strict';

const cors = require('cors');
const env = require('../config/env');
const logger = require('../config/logger');
const { ForbiddenError } = require('../errors');

/**
 * Builds a strict CORS whitelist from the CORS_ORIGIN env variable.
 *
 * Design decisions:
 * - Whitelist is parsed once at startup (not per-request) — misconfigured origins
 *   fail at server start, not at the first incoming request.
 * - No wildcard '*' is ever used. A wildcard would allow any origin to make
 *   credentialed cross-origin requests, bypassing the entire CORS policy.
 * - Unlisted origins receive a CORS error, not a silent ignore, so clients
 *   get a clear failure rather than a confusing empty response.
 */
const allowedOrigins = env.CORS_ORIGIN
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

logger.info('CORS whitelist configured', { origins: allowedOrigins });

const corsOptions = {
  origin(requestOrigin, callback) {
    // Allow requests with no origin (native mobile apps, server-to-server, curl, Postman)
    if (!requestOrigin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(requestOrigin)) {
      return callback(null, true);
    }

    // In development mode, allow localhost and private LAN development origins
    if (env.NODE_ENV === 'development') {
      try {
        const parsed = new URL(requestOrigin);
        const host = parsed.hostname;
        if (
          host === 'localhost' ||
          host === '127.0.0.1' ||
          host.startsWith('10.') ||
          host.startsWith('192.168.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        ) {
          return callback(null, true);
        }
      } catch {
        // Fall through to rejection if origin is not a valid URL
      }
    }

    // Origin is not in the whitelist — reject
    // 403 (not a generic 500) so the rejection is an expected, non-alerting client error
    return callback(new ForbiddenError(`Origin '${requestOrigin}' is not allowed by CORS policy`, 'CORS_ORIGIN_FORBIDDEN'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-ID',
    'Idempotency-Key',
    'idempotency-key',
    'X-Client-Platform',
    'X-Client-Version',
  ],
  exposedHeaders: ['X-Request-ID'],
  credentials: true,
  // Cache preflight response for 24 hours
  maxAge: 86400,
};

const corsMiddleware = cors(corsOptions);

module.exports = { corsMiddleware };
