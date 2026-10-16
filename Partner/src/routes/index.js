'use strict';

const express = require('express');
const healthController = require('../health/health.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { verifyOwnership } = require('../middlewares/ownership');
const { rejectMassAssignment } = require('../middlewares/massAssignment');
const { idempotency } = require('../middlewares/idempotency');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');
const { ROLES } = require('../constants/roles');
const authRoutes = require('./auth.routes');
const partnerRoutes = require('./partner.routes');
const storageRoutes = require('./storage.routes');
const paymentRoutes = require('./payment.routes');
const env = require('../config/env');
const adminRoutes = require('./admin.routes');

const router = express.Router();

// API root probe (GET /api/v1)
router.get('/', (req, res, next) => healthController.apiHealth(req, res, next));

// API Health Check
router.get('/health', (req, res, next) => healthController.apiHealth(req, res, next));

// Authentication & Session Routes
router.use('/auth', authRoutes);

// Partner Profile, Shop & KYC Routes
router.use('/partner', partnerRoutes);

// S3 Storage & Upload Routes
router.use('/storage', storageRoutes);

// Payment Gateway & Webhook Routes
router.use('/payments', paymentRoutes);

// Admin Settlement & Damage Workflow Routes
router.use('/admin', adminRoutes);

// ── Security & Foundation Verification Routes (Strictly non-production only) ──
if (process.env.NODE_ENV !== 'production' && env.NODE_ENV !== 'production' && !env.isProduction) {
  // Authenticated identity probe
  router.get('/test/auth', authenticate, (req, res) => {
    sendSuccess(res, { user: req.user });
  });

  // Partner-only role authorization probe
  router.get('/test/partner-only', authenticate, requireRole(ROLES.PARTNER), (req, res) => {
    sendSuccess(res, { message: 'Authorized as PARTNER', user: req.user });
  });

  // Resource ownership / BOLA verification probe
  router.get(
    '/test/resource/:id',
    authenticate,
    verifyOwnership(async (req) => {
      // Simulated resource lookup
      if (req.params.id === 'resource-partner-1') {
        return { id: 'resource-partner-1', partnerId: 'partner-123', name: 'Partner 1 Asset' };
      }
      if (req.params.id === 'resource-partner-2') {
        return { id: 'resource-partner-2', partnerId: 'partner-other', name: 'Partner 2 Asset' };
      }
      return null;
    }),
    (req, res) => {
      sendSuccess(res, { resource: req.resource });
    },
  );

  // Mass-assignment rejection probe
  router.post('/test/mass-assignment', rejectMassAssignment(), (req, res) => {
    sendSuccess(res, { received: req.body });
  });

  // Idempotent operation probe
  router.post('/test/idempotent', authenticate, idempotency({ required: true }), (req, res) => {
    sendSuccess(res, { executedAt: new Date().toISOString(), echo: req.body });
  });

  // Strict rate-limited probe
  const testLimiter = createRateLimiter({
    max: 3,
    windowMs: 10000,
    prefix: 'test-rl',
  });
  router.get('/test/rate-limited', testLimiter, (req, res) => {
    sendSuccess(res, { message: 'Rate limit OK' });
  });
}

module.exports = router;
