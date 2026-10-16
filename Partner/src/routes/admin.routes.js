'use strict';

const express = require('express');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { ROLES } = require('../constants/roles');
const adminDamageRoutes = require('./admin-damage.routes');
const adminFinancialRoutes = require('./admin-financial.routes');
const adminPayoutRoutes = require('./admin-payout.routes');
const adminSupportRoutes = require('./admin-support.routes');
const metrics = require('../utils/metrics');
const outboxService = require('../services/outbox.service');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

// Strict Admin role authorization guard
router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));

// Admin Damage Assessment & Settlement Workflow
router.use('/damages', adminDamageRoutes);

// Admin Financial Settlements & Commission Tracking
router.use('/financials', adminFinancialRoutes);

// Admin Partner Payout Disbursement Management
router.use('/payouts', adminPayoutRoutes);

// Admin Support Ticket Management
router.use('/support/tickets', adminSupportRoutes);

// Admin Operational Metrics & Visibility
router.get('/metrics', async (req, res, next) => {
  try {
    const summary = metrics.getSummary();
    const outboxStats = await outboxService.getStats().catch(() => ({}));
    return sendSuccess(res, {
      ...summary,
      outbox: outboxStats,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
