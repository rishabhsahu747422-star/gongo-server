'use strict';

const express = require('express');
const adminFinancialController = require('../controllers/admin-financial.controller');
const adminFinancialValidator = require('../validators/admin-financial.validator');

const { createRateLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

const adminFinancialReadLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:admin:financials:read',
});

/**
 * @route   GET /api/v1/admin/financials/settlements
 * @desc    List platform-wide booking settlements & earnings.
 * @access  Private (Admin)
 */
router.get(
  '/settlements',
  adminFinancialReadLimiter,
  (req, res, next) => adminFinancialValidator.validateFinancialListQuery(req, res, next),
  (req, res, next) => adminFinancialController.listSettlements(req, res, next),
);

/**
 * @route   GET /api/v1/admin/financials/commissions
 * @desc    List internal company commission records (Confidential).
 * @access  Private (Admin)
 */
router.get(
  '/commissions',
  adminFinancialReadLimiter,
  (req, res, next) => adminFinancialValidator.validateFinancialListQuery(req, res, next),
  (req, res, next) => adminFinancialController.listCommissions(req, res, next),
);

/**
 * @route   GET /api/v1/admin/financials/summary
 * @desc    Platform-wide financial aggregation metrics.
 * @access  Private (Admin)
 */
router.get(
  '/summary',
  adminFinancialReadLimiter,
  (req, res, next) => adminFinancialController.getFinancialSummary(req, res, next),
);

/**
 * @route   GET /api/v1/admin/financials/reconciliation
 * @desc    Run platform-wide financial reconciliation audit.
 * @access  Private (Admin)
 */
router.get(
  '/reconciliation',
  adminFinancialReadLimiter,
  (req, res, next) => adminFinancialController.getReconciliationReport(req, res, next),
);

module.exports = router;
