'use strict';

const helmet = require('helmet');

/**
 * Applies security headers using Helmet and additional HTTP safeguards.
 * - Disables X-Powered-By
 * - Enforces Strict-Transport-Security (HSTS)
 * - Enables X-Content-Type-Options: nosniff
 * - Frameguard: deny (clickjacking protection)
 * - X-XSS-Protection
 * - Content Security Policy (restricted)
 *
 * @param {import('express').Application} app
 */
function applySecurityMiddleware(app) {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      noSniff: true,
      xssFilter: true,
    }),
  );

  // Additional security headers
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // Rejection of unsafe / unallowed HTTP methods (e.g. TRACE, TRACK)
  const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
  app.use((req, res, next) => {
    if (!ALLOWED_METHODS.has(req.method)) {
      res.setHeader('Allow', Array.from(ALLOWED_METHODS).join(', '));
      return res.status(405).json({
        success: false,
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: `HTTP method '${req.method}' is not allowed`,
        },
        requestId: res.locals.requestId || req.id || null,
      });
    }
    return next();
  });
}

module.exports = { applySecurityMiddleware };
