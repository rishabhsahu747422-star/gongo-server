'use strict';

const morgan = require('morgan');
const logger = require('../config/logger');

/**
 * Custom Morgan token: request ID.
 * Reads from req.id set by requestId middleware.
 */
morgan.token('request-id', (req) => req.id || '-');

/**
 * HTTP request logging middleware using Morgan.
 *
 * Log format: <method> <url> <status> <response-time>ms - <req-id>
 * Output is routed through Winston (logger.stream) so all logs
 * go to the same transport (JSON in production, colorized in dev).
 *
 * The health endpoint is skipped to prevent log noise from liveness probes.
 */
const requestLogger = morgan(
  ':method :url :status :response-time ms - :request-id',
  {
    stream: logger.stream,
    // Skip health check endpoint to reduce noise
    skip: (req) => req.url === '/api/v1/health',
  },
);

module.exports = { requestLogger };
