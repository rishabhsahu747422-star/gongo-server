'use strict';

const express = require('express');
const authController = require('../controllers/auth.controller');
const authenticate = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const {
  validateSendOtp,
  validateVerifyOtp,
  validateRefresh,
  validateCustomerSendOtp,
  validateCustomerVerifyOtp,
} = require('../validators');

const router = express.Router();

/**
 * @route   POST /api/v1/auth/customer/send-otp
 * @desc    Send 6-digit OTP to mobile number via Renflair SMS Gateway
 * @access  Public
 */
router.post(
  '/customer/send-otp',
  (req, res, next) => {
    console.log('[CUSTOMER_AUTH_INCOMING]', {
      method: req.method,
      url: req.originalUrl || req.url,
      requestId: req.id,
      timestamp: new Date().toISOString(),
      userAgent: req.headers['user-agent'] || 'none',
    });
    next();
  },
  validateCustomerSendOtp,
  (req, res, next) => authController.customerSendOtp(req, res, next),
);

/**
 * @route   POST /api/v1/auth/customer/verify-otp
 * @desc    Verify 6-digit OTP, authenticate/register customer, return session tokens
 * @access  Public
 */
router.post('/customer/verify-otp', validateCustomerVerifyOtp, (req, res, next) =>
  authController.customerVerifyOtp(req, res, next),
);

/**
 * @route   POST /api/v1/auth/send-otp
 * @desc    Send 6-digit OTP to mobile number via MSG91
 * @access  Public
 */
router.post('/send-otp', validateSendOtp, (req, res, next) => authController.sendOtp(req, res, next));

/**
 * @route   POST /api/v1/auth/verify-otp
 * @desc    Verify OTP and return Firebase Custom Token
 * @access  Public
 */
router.post('/verify-otp', validateVerifyOtp, (req, res, next) => authController.verifyOtp(req, res, next));

/**
 * @route   POST /api/v1/auth/refresh
 * @desc    Refresh session token
 * @access  Public (requires valid token payload)
 */
router.post('/refresh', validateRefresh, (req, res, next) => authController.refresh(req, res, next));

/**
 * @route   GET /api/v1/auth/me
 * @desc    Get currently authenticated customer profile
 * @access  Private (Bearer token + role=customer)
 */
router.get(
  '/me',
  authenticate,
  requireRole('customer'),
  (req, res, next) => authController.getMe(req, res, next),
);

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Revoke Firebase refresh tokens and invalidate session
 * @access  Private (Bearer token)
 */
router.post('/logout', authenticate, (req, res, next) => authController.logout(req, res, next));

module.exports = router;
