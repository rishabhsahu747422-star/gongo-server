'use strict';

const express = require('express');
const customerRoutes = require('./customer.routes');
const partnerRoutes = require('./partner.routes');
const adminRoutes = require('./admin.routes');
const { checkReadiness } = require('../lifecycle');

const { customerApp } = customerRoutes;
const { partnerApp } = partnerRoutes;
const { adminApp } = adminRoutes;

const router = express.Router();

// Helper to forward transparently without path truncation
const forwardTo = (app) => (req, res, next) => {
  req.url = req.originalUrl;
  app(req, res, next);
};

// ── 1. Canonical Sub-Application Namespaces (/api/v1/customer, /api/v1/partner, /api/v1/admin) ──
router.use('/api/v1/customer', customerRoutes);
router.use('/api/v1/partner', partnerRoutes);
router.use('/api/v1/admin', adminRoutes);

// ── 2. Top-Level Health Probes ───────────────────────────────────────────────
router.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'gongo-unified-backend',
    timestamp: new Date().toISOString(),
    services: {
      customer: 'mounted',
      partner: 'mounted',
      admin: 'mounted',
    },
  });
});

router.get('/health/live', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'gongo-api' });
});

// Readiness: 503 unless every sub-app's database and Redis respond.
router.get('/health/ready', async (_req, res) => {
  const { ready, checks } = await checkReadiness();
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    service: 'gongo-unified-backend',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// ── 3. Gateway Compatibility Aliases for Legacy Clients ───────────────────────

// A. Legacy URL prefixes (/customer/api/v1, /customer, /partner/api/v1, /partner, /admin/api/v1, /admin)
router.use(['/customer/api/v1', '/customer'], customerRoutes);
router.use(['/partner/api/v1', '/partner'], partnerRoutes);
router.use(['/admin/api/v1', '/admin'], adminRoutes);

// B. Standalone Admin Gateway Aliases (/api/admin, /api/v1/public)
router.use('/api/admin', forwardTo(adminApp));
router.use('/api/v1/public', forwardTo(adminApp));

// C. Standalone Partner Gateway Aliases (/api/v1/storage, /api/auth/otp, /api/v1/auth/otp)
router.use('/api/v1/storage', forwardTo(partnerApp));
router.use(['/api/auth/otp', '/api/v1/auth/otp'], forwardTo(partnerApp));

// C. Authentication Dispatcher (/api/v1/auth, /api/auth)
// Routed by the first path segment (not a substring of the whole URL, which also matched
// query strings and e.g. "/methods" for "/me"). Customer owns /customer/*, /send-otp,
// /verify-otp and /refresh; the legacy shared /me and /logout stay with Partner.
const PARTNER_AUTH_SEGMENTS = new Set([
  'partner', 'check-phone', 'register', 'session', 'otp', 'me', 'logout', 'consents', 'dev-login',
]);
router.use(['/api/v1/auth', '/api/auth'], (req, res, next) => {
  const firstSegment = req.path.split('/').filter(Boolean)[0] || '';
  if (PARTNER_AUTH_SEGMENTS.has(firstSegment)) {
    forwardTo(partnerApp)(req, res, next);
  } else {
    forwardTo(customerApp)(req, res, next);
  }
});

// D. Customer Gateway Aliases (/api/v1/customers, /api/v1/bookings, /api/v1/vehicles, etc.)
router.use('/api/v1/customers', forwardTo(customerApp));
router.use('/api/v1/bookings', forwardTo(customerApp));
router.use('/api/v1/vehicles', forwardTo(customerApp));
router.use('/api/v1/pricing', forwardTo(customerApp));
router.use('/api/v1/coupons', forwardTo(customerApp));
router.use('/api/v1/payments', forwardTo(customerApp));
router.use(['/api/v1/platform-fee', '/customer/platform-fee'], forwardTo(customerApp));
router.use('/api/v1/banners', forwardTo(customerApp));
router.use('/api/v1/offers', forwardTo(customerApp));

module.exports = router;
