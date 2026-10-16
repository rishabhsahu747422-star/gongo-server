'use strict';

require('dotenv').config();

const express = require('express');
const env = require('./config/env');
const { applySecurityMiddleware } = require('./middlewares/security');
const { corsMiddleware } = require('./middlewares/cors');
const { requestIdMiddleware } = require('./middlewares/requestId');
const { jsonParser, urlencodedParser } = require('./middlewares/bodyParser');
const { requestLogger } = require('./middlewares/requestLogger');
const { httpMetricsMiddleware } = require('./middlewares/metrics');
const { notFound } = require('./middlewares/notFound');
const { errorHandler } = require('./middlewares/errorHandler');
const healthRoutes = require('./routes/health.routes');
const otpRoutes = require('./routes/otp.routes');
const apiRoutes = require('./routes');

/**
 * Creates and configures the Express application.
 *
 * Middleware pipeline order:
 *   1. Disable x-powered-by
 *   2. Trust proxy configuration
 *   3. Security headers (Helmet)
 *   4. Strict CORS validation
 *   5. Request ID generation / safe validation
 *   6. Body parsers with 10kb payload limit
 *   7. HTTP security logging (Winston + Morgan)
 *   8. Unversioned Health check endpoints (/health/live, /health/ready, /health)
 *   9. Versioned API routes (/api/v1/...)
 *   10. 404 handler
 *   11. Centralized error handling
 *
 * @returns {import('express').Application}
 */
function createApp() {
  const app = express();

  // Disable information disclosure headers
  app.disable('x-powered-by');

  // Configurable trusted proxy
  if (env.TRUST_PROXY === 'false') {
    app.set('trust proxy', false);
  } else if (!Number.isNaN(Number(env.TRUST_PROXY))) {
    app.set('trust proxy', Number(env.TRUST_PROXY));
  } else {
    app.set('trust proxy', env.TRUST_PROXY);
  }

  // 1. Security Headers
  applySecurityMiddleware(app);

  // 2. CORS
  app.use(corsMiddleware);

  // 3. Request ID
  app.use(requestIdMiddleware);

  // 4. Body Parsers (10kb limit)
  app.use(jsonParser);
  app.use(urlencodedParser);

  // 5. HTTP Metrics & Logging
  app.use(httpMetricsMiddleware);
  app.use(requestLogger);

  // 6. Root Health Probes (ALB / K8s / Service monitor)
  app.use('/health', healthRoutes);

  // 6b. OTP Authentication Routes (Direct /api/auth/otp and /api/v1/auth/otp)
  app.use('/api/auth/otp', otpRoutes);
  app.use('/api/v1/auth/otp', otpRoutes);
  app.use('/api/auth', require('./routes/auth.routes'));

  // 7. Versioned API Routes (/api/v1)
  app.use(env.API_PREFIX, apiRoutes);

  // 8. 404 Route Not Found
  app.use(notFound);

  // 9. Centralized Error Handler (4 args required)
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
