'use strict';

const express = require('express');
const paymentController = require('../controllers/payment.controller');
const paymentValidator = require('../validators/payment.validator');
const { createRateLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

const webhookRateLimiter = createRateLimiter({
  max: 100,
  windowMs: 60 * 1000,
  prefix: 'rl:payments:webhook',
});

/**
 * @route   POST /api/v1/payments/webhook/cashfree
 * @desc    Cashfree payment gateway webhook callback.
 *          Authenticated via HMAC-SHA256 signature and timestamp replay window.
 * @access  Public (Cashfree Gateway Server)
 */
router.post(
  '/webhook/cashfree',
  webhookRateLimiter,
  (req, res, next) => paymentValidator.validateWebhookHeaders(req, res, next),
  (req, res, next) => paymentController.handleCashfreeWebhook(req, res, next),
);

/**
 * @route   POST /api/v1/payments/webhook/cashfree/payout
 * @desc    Cashfree payout webhook callback.
 *          Authenticated via HMAC-SHA256 signature and timestamp replay window.
 * @access  Public (Cashfree Gateway Server)
 */
router.post(
  '/webhook/cashfree/payout',
  webhookRateLimiter,
  (req, res, next) => paymentValidator.validateWebhookHeaders(req, res, next),
  (req, res, next) => paymentController.handleCashfreePayoutWebhook(req, res, next),
);

module.exports = router;
