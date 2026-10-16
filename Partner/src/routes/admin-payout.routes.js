'use strict';

const express = require('express');
const adminFinancialController = require('../controllers/admin-financial.controller');
const adminFinancialValidator = require('../validators/admin-financial.validator');

const { createRateLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

const adminPayoutReadLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:admin:payouts:read',
});

const adminPayoutMutationLimiter = createRateLimiter({
  max: 30,
  windowMs: 60 * 1000,
  prefix: 'rl:admin:payouts:mutation',
});

/**
 * @route   GET /api/v1/admin/payouts
 * @desc    List all partner payout requests.
 * @access  Private (Admin)
 */
router.get(
  '/',
  adminPayoutReadLimiter,
  (req, res, next) => adminFinancialValidator.validateFinancialListQuery(req, res, next),
  (req, res, next) => adminFinancialController.listPayouts(req, res, next),
);

/**
 * @route   GET /api/v1/admin/payouts/:payoutId
 * @desc    Get single payout details.
 * @access  Private (Admin)
 */
router.get(
  '/:payoutId',
  adminPayoutReadLimiter,
  (req, res, next) => adminFinancialValidator.validatePayoutIdParam(req, res, next),
  (req, res, next) => adminFinancialController.getPayoutById(req, res, next),
);

/**
 * @route   PATCH /api/v1/admin/payouts/:payoutId/process
 * @desc    Mark payout as PROCESSING.
 * @access  Private (Admin)
 */
router.patch(
  '/:payoutId/process',
  adminPayoutMutationLimiter,
  (req, res, next) => adminFinancialValidator.validatePayoutIdParam(req, res, next),
  (req, res, next) => adminFinancialValidator.validateProcessPayout(req, res, next),
  (req, res, next) => adminFinancialController.processPayout(req, res, next),
);

/**
 * @route   PATCH /api/v1/admin/payouts/:payoutId/complete
 * @desc    Mark payout as COMPLETED.
 * @access  Private (Admin)
 */
router.patch(
  '/:payoutId/complete',
  adminPayoutMutationLimiter,
  (req, res, next) => adminFinancialValidator.validatePayoutIdParam(req, res, next),
  (req, res, next) => adminFinancialController.completePayout(req, res, next),
);

/**
 * @route   PATCH /api/v1/admin/payouts/:payoutId/fail
 * @desc    Mark payout as FAILED (restores wallet balance atomically).
 * @access  Private (Admin)
 */
router.patch(
  '/:payoutId/fail',
  adminPayoutMutationLimiter,
  (req, res, next) => adminFinancialValidator.validatePayoutIdParam(req, res, next),
  (req, res, next) => adminFinancialValidator.validateFailPayout(req, res, next),
  (req, res, next) => adminFinancialController.failPayout(req, res, next),
);

module.exports = router;
