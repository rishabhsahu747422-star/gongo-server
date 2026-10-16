'use strict';

const cors = require('cors');
const env = require('../config/env');
const { ForbiddenError } = require('../errors');

/**
 * Strict CORS middleware.
 *
 * Enforces origin validation based on CORS_ALLOWED_ORIGINS environment configuration.
 * - In production: rejects wildcards, allows only exact matches from configured domains.
 * - Mobile apps / native requests without origin header are permitted.
 * - Disallowed origins return standard 403 Forbidden error.
 */
const corsOptions = {
  origin(origin, callback) {
    // Requests without origin header (mobile native apps, Postman, curl, server-to-server)
    if (!origin) {
      return callback(null, true);
    }

    const allowedOrigins = env.CORS_ALLOWED_ORIGINS;

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    if (env.NODE_ENV !== 'production') {
      if (/^http:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}):\d+$/.test(origin)) {
        return callback(null, true);
      }
    }

    // Origin not allowed
    return callback(new ForbiddenError(`Origin ${origin} is not allowed by CORS`, 'FORBIDDEN'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'Idempotency-Key',
    'X-Idempotency-Key',
  ],
  exposedHeaders: ['X-Request-Id'],
  credentials: true,
  maxAge: 86400, // 24 hours
};

const corsMiddleware = cors(corsOptions);

module.exports = { corsMiddleware, corsOptions };
