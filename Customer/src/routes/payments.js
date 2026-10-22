'use strict';

const express = require('express');
const paymentController = require('../controllers/payment.controller');
const { validateWebhook } = require('../validators/payment.validator');

const router = express.Router();

const authenticate = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

/**
 * @route   POST /api/v1/payments/cashfree/create-order
 * @desc    Direct Cashfree order creation endpoint for authenticated customer.
 * @access  Customer
 */
router.post(
  '/cashfree/create-order',
  authenticate,
  requireRole('customer'),
  (req, res, next) => paymentController.createCashfreeOrder(req, res, next),
);

/**
 * @route   GET /api/v1/payments/cashfree/:orderId/status
 * @desc    Direct Cashfree payment status query endpoint for authenticated customer.
 * @access  Customer
 */
router.get(
  '/cashfree/:orderId/status',
  authenticate,
  requireRole('customer'),
  (req, res, next) => paymentController.getCashfreeOrderStatus(req, res, next),
);

/**
 * @route   GET /api/v1/payments/cashfree/return
 * @desc    Cashfree browser return URL endpoint.
 *          Verifies authoritative payment status and redirects/presents result to customer app.
 * @access  Public (Cashfree browser redirect)
 */
router.get(
  ['/cashfree/return', '/return'],
  (req, res, next) => paymentController.handlePaymentReturn(req, res, next),
);

/**
 * @route   POST /api/v1/payments/webhook/cashfree
 * @desc    Cashfree payment gateway webhook callback.
 *          Authenticates via HMAC signature (NOT customer bearer token).
 * @access  Public (Cashfree Server)
 */
router.post(
  ['/webhook/cashfree', '/webhook', '/cashfree/webhook'],
  validateWebhook,
  (req, res, next) => paymentController.handleCashfreeWebhook(req, res, next),
);

/**
 * @route   POST /api/v1/payments/test/simulate-webhook
 * @desc    Simulate verified Cashfree webhook in Sandbox test mode.
 * @access  Sandbox / Development only
 */
router.post(
  '/test/simulate-webhook',
  authenticate,
  requireRole('customer'),
  (req, res, next) => paymentController.simulateTestWebhook(req, res, next),
);

/**
 * @route   POST /api/v1/payments/dev-bypass
 * @desc    Bypass payment in development mode and mark booking as CONFIRMED / PAID.
 * @access  Customer
 */
router.post(
  '/dev-bypass',
  authenticate,
  requireRole('customer'),
  (req, res, next) => paymentController.devBypassPayment(req, res, next),
);

module.exports = router;

