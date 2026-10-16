'use strict';

require('dotenv').config();

const express = require('express');
const env = require('./config/env');
const { applySecurityMiddleware } = require('./middlewares/security');
const { corsMiddleware } = require('./middlewares/cors');
const { requestIdMiddleware } = require('./middlewares/requestId');
const { jsonParser, urlencodedParser } = require('./middlewares/bodyParser');
const { requestLogger } = require('./middlewares/requestLogger');
const { notFound } = require('./middlewares/notFound');
const { errorHandler } = require('./middlewares/errorHandler');
const healthRoutes = require('./routes/health.routes');
const apiRoutes = require('./routes');

/**
 * Creates and configures the Express application.
 *
 * Middleware pipeline order:
 *   1. Disable x-powered-by
 *   2. Trust proxy configuration
 *   3. Security headers (Helmet)
 *   4. Strict CORS validation
 *   5. Request ID generation / validation
 *   6. Body parsers with 10kb limit
 *   7. HTTP request logging (Morgan/Winston)
 *   8. Root Health check endpoints (/health/live, /health/ready, /health)
 *   9. Versioned API routes (/api/v1/...)
 *   10. 404 Route Not Found
 *   11. Centralized Error Handler (4 arguments)
 *
 * @returns {import('express').Application}
 */
function createApp() {
  const app = express();

  // 1. Disable information disclosure headers
  app.disable('x-powered-by');

  // 2. Configurable trusted proxy
  if (env.TRUST_PROXY === 'false') {
    app.set('trust proxy', false);
  } else if (!Number.isNaN(Number(env.TRUST_PROXY))) {
    app.set('trust proxy', Number(env.TRUST_PROXY));
  } else {
    app.set('trust proxy', env.TRUST_PROXY);
  }

  // 3. Security Headers
  applySecurityMiddleware(app);

  // 4. CORS
  app.use(corsMiddleware);

  // 5. Request ID & Correlation Context
  app.use(requestIdMiddleware);

  // 6. Body Parsers (10kb limit)
  app.use(jsonParser);
  app.use(urlencodedParser);

  // 7. HTTP Logging
  app.use(requestLogger);

  // 8. Root Health Probes
  app.use('/health', healthRoutes);

  // 9. Versioned API Routes (/api/v1 and /api)
  app.use(env.API_PREFIX, apiRoutes);
  if (env.API_PREFIX !== '/api') {
    app.use('/api', apiRoutes);
  }
  app.use('/admin', require('./routes/admin.routes'));

  // 10. 404 Route Not Found
  app.use(notFound);

  // 11. Centralized Error Handler
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
