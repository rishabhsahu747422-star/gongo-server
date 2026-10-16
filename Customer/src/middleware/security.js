'use strict';

const helmet = require('helmet');

/**
 * Applies Helmet security middleware to the Express app.
 *
 * Helmet sets secure HTTP headers to protect against common web vulnerabilities:
 *   - X-Content-Type-Options: nosniff         (MIME sniffing prevention)
 *   - X-Frame-Options: SAMEORIGIN             (Clickjacking prevention)
 *   - X-XSS-Protection: 0                     (Disabled — modern browsers use CSP)
 *   - Strict-Transport-Security               (HTTPS enforcement in production)
 *   - Referrer-Policy: no-referrer            (Referrer leakage prevention)
 *   - X-Download-Options: noopen              (IE download prompt)
 *   - X-Permitted-Cross-Domain-Policies: none (Flash/Acrobat cross-domain)
 *
 * Content-Security-Policy is NOT set here — this is a pure JSON API with no
 * browser-rendered HTML. CSP would have no effect on API responses.
 *
 * @param {import('express').Application} app
 */
function applySecurityMiddleware(app) {
  app.use(
    helmet({
      contentSecurityPolicy: false, // API-only — no HTML rendering
      crossOriginEmbedderPolicy: false, // Not applicable for JSON API
    }),
  );
}

module.exports = { applySecurityMiddleware };
