'use strict';

const express = require('express');
const otpService = require('../services/otp.service');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

const env = require('../config/env');

const router = express.Router();

// Strict rate limiters for OTP endpoints
const sendOtpLimiter = createRateLimiter({
  max: env.NODE_ENV === 'test' ? 100 : 10,
  windowMs: 15 * 60 * 1000,
  prefix: 'rl:auth:otp:send',
});

const verifyOtpLimiter = createRateLimiter({
  max: env.NODE_ENV === 'test' ? 100 : 20,
  windowMs: 15 * 60 * 1000,
  prefix: 'rl:auth:otp:verify',
});

/**
 * @route   POST /api/auth/otp/send or /api/v1/auth/otp/send
 * @desc    Generate and dispatch 6-digit verification code via Renflair SMS Gateway
 * @access  Public (Rate limited)
 */
router.post('/send', sendOtpLimiter, async (req, res, next) => {
  try {
    const { phone } = req.body || {};
    const result = await otpService.sendOtp({ phone });
    return sendSuccess(res, result, HTTP_STATUS.OK);
  } catch (err) {
    return next(err);
  }
});

/**
 * @route   POST /api/auth/otp/verify or /api/v1/auth/otp/verify
 * @desc    Verify 6-digit OTP code, prevent reuse and establish authenticated partner session
 * @access  Public (Rate limited)
 */
router.post('/verify', verifyOtpLimiter, async (req, res, next) => {
  try {
    const { phone, otp } = req.body || {};
    const result = await otpService.verifyOtp({ phone, otp });
    return sendSuccess(res, result, HTTP_STATUS.OK);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
