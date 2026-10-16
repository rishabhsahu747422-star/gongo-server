'use strict';

/**
 * Lightweight safe request logger.
 * Never logs credentials, passwords, tokens, or sensitive payloads.
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.log(`[HTTP] ${req.method} ${req.originalUrl || req.url} ${res.statusCode} - ${duration}ms (reqId: ${req.id || '-'})`);
    }
  });
  next();
}

module.exports = { requestLogger };
