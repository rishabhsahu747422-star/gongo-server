'use strict';

const cors = require('cors');
const env = require('../config/env');
const { ForbiddenError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

const allowedOrigins = env.CORS_ALLOWED_ORIGINS;

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser tools (curl, health probes, Postman) with no origin header
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // In local development, dynamically allow any port on localhost / 127.0.0.1 (e.g. Vite auto-assigning 5174, 5175)
    if (env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }

    const err = new ForbiddenError(`Origin '${origin}' not allowed by CORS`, ERROR_CODES.FORBIDDEN);
    return callback(err);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-ID',
    'Idempotency-Key',
  ],
  exposedHeaders: ['X-Request-ID'],
  credentials: true,
  maxAge: 86400, // 24 hours
};

const corsMiddleware = cors(corsOptions);

module.exports = {
  corsMiddleware,
  corsOptions,
};
