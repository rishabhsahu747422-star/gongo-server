'use strict';

const express = require('express');
const healthController = require('../controllers/health.controller');
const adminRoutes = require('./admin.routes');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');
const { ROLES } = require('../constants/roles');

const publicRoutes = require('./public.routes');

const env = require('../config/env');

const router = express.Router();

// API root probe (GET /api/v1)
router.get('/', (req, res, next) => healthController.apiHealth(req, res, next));

// API Health Check: GET /api/v1/health
router.get('/health', (req, res, next) => healthController.apiHealth(req, res, next));

// Public Marketplace & Landing Gateway: /api/v1/public and convenience aliases
router.use('/public', publicRoutes);
router.use('/vehicles', publicRoutes);
router.use('/franchise-applications', publicRoutes);

// Admin API Gateway: /api/v1/admin
router.use('/admin', adminRoutes);

// ── Security & Foundation Verification Routes (Strictly non-production only) ──
if (process.env.NODE_ENV !== 'production' && env.NODE_ENV !== 'production' && !env.isProduction) {
  // Authenticated identity probe
  router.get('/test/auth', authenticate, (req, res) => {
    sendSuccess(res, { user: req.user });
  });

  // Admin-only role authorization probe
  router.get('/test/admin-only', authenticate, requireRole(ROLES.ADMIN), (req, res) => {
    sendSuccess(res, { message: 'Authorized as ADMIN', user: req.user });
  });

  // Permission group authorization probe
  router.get(
    '/test/permission',
    authenticate,
    requireRole(ROLES.ADMIN),
    requirePermission(['SUPER_ADMIN', 'FINANCE_ADMIN']),
    (req, res) => {
      sendSuccess(res, { message: 'Authorized with permission' });
    },
  );

  // Audit hook verification probe
  router.post('/test/audit', authenticate, requireRole(ROLES.ADMIN), auditMiddleware, (req, res) => {
    const auditRecord = req.audit({
      action: req.body.action || 'TEST_ACTION',
      targetResource: req.body.targetResource || 'TEST_RESOURCE',
      targetResourceId: req.body.targetResourceId || '123',
      beforeState: req.body.beforeState,
      afterState: req.body.afterState,
      metadata: req.body.metadata,
    });

    sendSuccess(res, { audit: auditRecord });
  });

  // Strict rate-limited probe
  const testLimiter = createRateLimiter({
    max: 3,
    windowMs: 10000,
    prefix: 'test-rl-admin',
  });
  router.get('/test/rate-limited', testLimiter, (req, res) => {
    sendSuccess(res, { message: 'Rate limit OK' });
  });
}

module.exports = router;
