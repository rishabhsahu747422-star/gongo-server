'use strict';

const morgan = require('morgan');
const logger = require('../config/logger');

// Custom morgan token for request ID
morgan.token('req-id', (req) => req.id || '-');

// Custom morgan token for safe user actor ID
morgan.token('actor-id', (req) => (req.user && req.user.partnerId ? req.user.partnerId : (req.user && req.user.id) || '-'));

/**
 * Morgan HTTP request logging format string.
 * Emits strictly safe metadata: method, path, status, latency, requestId, actorId.
 */
const logFormat = ':method :url :status :response-time ms - reqId=:req-id actorId=:actor-id';

const requestLogger = morgan(logFormat, {
  stream: {
    write: (message) => {
      logger.info(message.trim());
    },
  },
  skip: (req) => req.url.startsWith('/health/live'), // Skip noise on liveness probes
});

module.exports = { requestLogger };
