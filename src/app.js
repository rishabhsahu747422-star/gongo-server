'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const env = require('./config/env');
const { requestId } = require('./shared/middleware/request-id');
const { requestLogger } = require('./shared/middleware/request-logger');
const { notFoundHandler } = require('./shared/errors/not-found');
const { errorHandler } = require('./shared/errors/error-handler');
const routes = require('./routes');

/**
 * Union of the unified and sub-app CORS allowlists, so one deployment config
 * covers every mounted app. Wildcards are dropped: a credentialed '*' would
 * let any site make authenticated requests.
 *
 * @returns {string[]}
 */
function buildAllowedOrigins() {
  return [
    env.CORS_ORIGINS,
    process.env.CORS_ORIGIN,
    process.env.CORS_ALLOWED_ORIGINS,
  ]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o && o !== '*');
}

/**
 * @param {string} value
 * @returns {boolean|number|string}
 */
function parseTrustProxy(value) {
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Creates and configures the Express application.
 * Does not start network listener.
 *
 * @returns {import('express').Application}
 */
function createApp() {
  const app = express();

  // 1. Disable information disclosure
  app.disable('x-powered-by');

  // 2. Security Headers (Helmet)
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // Trust proxy is explicit, never blindly true (forwarded headers are client-controlled otherwise).
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));

  // 3. CORS
  const allowedOrigins = buildAllowedOrigins();
  const isProduction = env.NODE_ENV === 'production';
  app.use(cors({
    origin: (origin, callback) => {
      // Requests without an Origin header (native mobile apps, server-to-server) are not CORS requests.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Outside production, keep the permissive behavior local web dev relies on.
      // Production: no CORS headers are sent, so the browser blocks the response.
      return callback(null, !isProduction);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'x-admin-session', 'x-session-token', 'Idempotency-Key', 'Accept'],
  }));

  // 4. Correlation Request ID
  app.use(requestId);

  // 5. Request Logging
  app.use(requestLogger);

  // 6. Body Parsers (10MB limit for multipart/json)
  // Sub-app parsers are skipped once the body is parsed here, so capture the raw body
  // for payment webhook signature verification at this layer.
  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf ? buf.toString('utf8') : '';
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // 7. Mount Master Routes (/customer, /partner, /admin, /health)
  app.use(routes);

  // 8. 404 Route Not Found
  app.use(notFoundHandler);

  // 9. Centralized Error Handler (4 arguments)
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
