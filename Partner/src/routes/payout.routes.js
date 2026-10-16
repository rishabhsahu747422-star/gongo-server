'use strict';

const express = require('express');
const payoutController = require('../controllers/payout.controller');
const payoutValidator = require('../validators/payout.validator');
const { createRateLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

const payoutWriteLimiter = createRateLimiter({
  max: 10,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:payouts:write',
});

const payoutReadLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:payouts:read',
});

/**
 * @route   POST /api/v1/partner/payouts
 * @desc    Request a payout withdrawal to primary/specified verified bank account.
 * @access  Private (Partner)
 */
router.post(
  '/',
  payoutWriteLimiter,
  (req, res, next) => payoutValidator.validateRequestPayout(req, res, next),
  (req, res, next) => payoutController.requestPayout(req, res, next),
);

/**
 * @route   GET /api/v1/partner/payouts
 * @desc    List paginated payouts for authenticated partner.
 * @access  Private (Partner)
 */
router.get(
  '/',
  payoutReadLimiter,
  (req, res, next) => payoutValidator.validatePayoutListQuery(req, res, next),
  (req, res, next) => payoutController.getPayouts(req, res, next),
);

/**
 * @route   GET /api/v1/partner/payouts/:payoutId
 * @desc    Get single payout details.
 * @access  Private (Partner)
 */
router.get(
  '/:payoutId',
  payoutReadLimiter,
  (req, res, next) => payoutValidator.validatePayoutIdParam(req, res, next),
  (req, res, next) => payoutController.getPayoutById(req, res, next),
);

module.exports = router;
