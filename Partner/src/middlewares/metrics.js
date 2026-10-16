'use strict';

const metrics = require('../utils/metrics');

/**
 * Middleware tracking HTTP request metrics: method, route, status code, and latency.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function httpMetricsMiddleware(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    // Derive normalized route without sensitive URL parameters
    const route = (req.baseUrl || '') + (req.route ? req.route.path : req.path);

    metrics.recordHttpRequest({
      method: req.method,
      route,
      statusCode: res.statusCode,
      durationMs,
    });
  });

  next();
}

module.exports = { httpMetricsMiddleware };
