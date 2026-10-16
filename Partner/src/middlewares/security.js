'use strict';

const helmet = require('helmet');

/**
 * Applies Helmet security headers with strict production defaults.
 *
 * Headers set:
 *   - Content-Security-Policy (default-src 'self')
 *   - Strict-Transport-Security (HSTS, max-age: 1 year, includeSubDomains)
 *   - X-Content-Type-Options: nosniff
 *   - X-Frame-Options: DENY
 *   - Referrer-Policy: no-referrer
 *   - Cross-Origin-Resource-Policy: same-origin
 *   - Cross-Origin-Opener-Policy: same-origin
 *
 * @param {import('express').Application} app
 */
function applySecurityMiddleware(app) {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false, // Compatibility with mobile webviews
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      dnsPrefetchControl: { allow: false },
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
      ieNoOpen: true,
      noSniff: true,
      originAgentCluster: true,
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
      referrerPolicy: { policy: 'no-referrer' },
      xssFilter: true,
    }),
  );
}

module.exports = { applySecurityMiddleware };
