'use strict';

const morgan = require('morgan');
const logger = require('../config/logger');

// OAuth callbacks carry an authorization code and state in the query string; log the path only.
const SENSITIVE_QUERY_PATHS = [/\/auth\/google\/callback(?:\?|$)/];

morgan.token('safe-url', (req) => {
  const url = req.originalUrl || req.url || '';
  return SENSITIVE_QUERY_PATHS.some((re) => re.test(url)) ? `${url.split('?')[0]}?[redacted]` : url;
});

const morganFormat = ':method :safe-url :status :res[content-length] - :response-time ms';

const requestLogger = morgan(morganFormat, {
  stream: {
    write: (message) => {
      logger.http(message.trim());
    },
  },
  skip: (req) => {
    // Skip noisy health probes from root logging in test
    if (process.env.NODE_ENV === 'test') {
      return true;
    }
    return req.url === '/health/live';
  },
});

module.exports = { requestLogger };
