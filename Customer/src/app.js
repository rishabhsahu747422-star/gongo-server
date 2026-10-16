'use strict';

// Load environment variables FIRST — before any other module that reads process.env.
// This must be the first require() in the entire application.
require('dotenv').config();

const express = require('express');
const env = require('./config/env');
const { applySecurityMiddleware } = require('./middleware/security');
const { corsMiddleware } = require('./middleware/cors');
const { requestId } = require('./middleware/requestId');
const { requestLogger } = require('./middleware/requestLogger');
const { jsonParser, urlencodedParser } = require('./middleware/bodyParser');
const { notFound } = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');
const apiRouter = require('./routes');
const healthRouter = require('./routes/health');
const platformFeeRouter = require('./routes/platform-fee');

/**
 * Creates and configures the Express application.
 *
 * Middleware order matters:
 *   1. Security headers  — must be first to protect all subsequent responses
 *   2. CORS             — before body parsing (handles OPTIONS preflight)
 *   3. Request ID       — before logging (logger uses req.id)
 *   4. Body parsers     — before route handlers
 *   5. Request logger   — after parsers (logs parsed content-type)
 *   6. Routes           — business logic
 *   7. 404 handler      — after routes (catches unmatched URLs)
 *   8. Error handler    — always last (Express identifies by 4-arg signature)
 *
 * This function is exported for testing (supertest can import `app`
 * without starting the HTTP server).
 *
 * @returns {import('express').Application}
 */
function createApp() {
  const app = express();

  // Disable the 'X-Powered-By: Express' header (information disclosure)
  app.disable('x-powered-by');

  // ── Configurable Trusted Proxy Strategy ───────────────────────
  // Environment-driven trust proxy configuration (never blindly set to true).
  // When false: Express ignores X-Forwarded-* headers (prevents IP spoofing).
  // When 'loopback', a hop count (e.g. 1), or CIDR: trusts only specified upstream proxies.
  if (env.TRUST_PROXY === 'false') {
    app.set('trust proxy', false);
  } else if (!Number.isNaN(Number(env.TRUST_PROXY))) {
    app.set('trust proxy', Number(env.TRUST_PROXY));
  } else {
    app.set('trust proxy', env.TRUST_PROXY);
  }

  // ── 1. Security headers (Helmet) ──────────────────────────────
  applySecurityMiddleware(app);

  // ── 2. CORS ───────────────────────────────────────────────────
  app.use(corsMiddleware);

  // ── 3. Request ID ─────────────────────────────────────────────
  app.use(requestId);

  // ── 4. Body parsers ───────────────────────────────────────────
  app.use(jsonParser);
  app.use(urlencodedParser);

  // ── 5. HTTP request logging ───────────────────────────────────
  app.use(requestLogger);

  // ── 6. Root health routes (for ALB, K8s, and orchestrator probes) ──
  app.use('/health', healthRouter);

  // ── 7. API routes ─────────────────────────────────────────────
  app.use(`/api/${env.API_VERSION}`, apiRouter);
  app.use('/customer/platform-fee', platformFeeRouter);

  // ── 8. 404 handler ────────────────────────────────────────────
  app.use(notFound);

  // ── 8. Global error handler (must be last, must have 4 args) ──
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
