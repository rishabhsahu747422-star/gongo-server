'use strict';

const express = require('express');
const authController = require('../controllers/auth.controller');
const env = require('../config/env');
const logger = require('../config/logger');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { rejectMassAssignment } = require('../middlewares/massAssignment');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const {
  validateCheckPhone,
  validateRegister,
  validatePartnerSendOtp,
  validatePartnerVerifyOtp,
  validatePartnerDevLogin,
} = require('../validators/auth.validator');
const { ROLES } = require('../constants/roles');

const otpRoutes = require('./otp.routes');

const router = express.Router();

// Mount OTP routes (/api/v1/auth/otp/send & /api/v1/auth/otp/verify)
router.use('/otp', otpRoutes);

// Rate limiters for authentication endpoints
const checkPhoneLimiter = createRateLimiter({
  max: 20,
  windowMs: 15 * 60 * 1000,
  prefix: 'rl:auth:check-phone',
});

const sessionLimiter = createRateLimiter({
  max: 30,
  windowMs: 15 * 60 * 1000,
  prefix: 'rl:auth:session',
});

const registerLimiter = createRateLimiter({
  max: 10,
  windowMs: 15 * 60 * 1000,
  prefix: 'rl:auth:register',
});

const partnerSendOtpLimiter = createRateLimiter({
  max: env.NODE_ENV === 'test' ? 100 : 10,
  windowMs: 15 * 60 * 1000,
  prefix: 'rl:auth:partner:send-otp',
});

const partnerVerifyOtpLimiter = createRateLimiter({
  max: env.NODE_ENV === 'test' ? 100 : 20,
  windowMs: 15 * 60 * 1000,
  prefix: 'rl:auth:partner:verify-otp',
});

/**
 * @route   POST /api/v1/auth/partner/send-otp
 * @desc    Send 6-digit OTP to mobile number via Renflair SMS Gateway
 * @access  Public
 */
router.post(
  '/partner/send-otp',
  partnerSendOtpLimiter,
  validatePartnerSendOtp,
  (req, res, next) => authController.partnerSendOtp(req, res, next),
);

/**
 * @route   POST /api/v1/auth/partner/verify-otp
 * @desc    Verify 6-digit OTP, validate partner existence, and return session
 * @access  Public
 */
router.post(
  '/partner/verify-otp',
  partnerVerifyOtpLimiter,
  validatePartnerVerifyOtp,
  (req, res, next) => authController.partnerVerifyOtp(req, res, next),
);

/**
 * @route   POST /api/v1/auth/partner/dev-login
 * @desc    Development-only partner login / bypass
 * @access  Public (Strictly non-production and PARTNER_DEV_LOGIN_ENABLED)
 */
router.post(
  '/partner/dev-login',
  validatePartnerDevLogin,
  (req, res, next) => authController.partnerDevLogin(req, res, next),
);

/**
 * @route   POST /api/v1/auth/check-phone
 * @desc    Check whether mobile number belongs to an existing registered partner
 * @access  Public (Rate limited)
 */
router.post(
  '/check-phone',
  checkPhoneLimiter,
  validateCheckPhone,
  (req, res, next) => authController.checkPhone(req, res, next),
);

/**
 * @route   POST /api/v1/auth/session
 * @desc    Establish/resolve authoritative backend partner session from Supabase JWT token
 * @access  Private (Bearer Supabase JWT token)
 */
router.post(
  '/session',
  sessionLimiter,
  authenticate,
  (req, res, next) => authController.session(req, res, next),
);

/**
 * @route   POST /api/v1/auth/register
 * @desc    First-time partner onboarding and atomic record creation
 * @access  Private (Bearer Supabase JWT token)
 */
router.post(
  '/register',
  registerLimiter,
  authenticate,
  rejectMassAssignment(),
  validateRegister,
  (req, res, next) => authController.register(req, res, next),
);

/**
 * @route   GET /api/v1/auth/me
 * @desc    Get live authoritative partner profile from PostgreSQL
 * @access  Private (Bearer Supabase JWT token + role=PARTNER)
 */
router.get(
  '/me',
  authenticate,
  requireRole(ROLES.PARTNER),
  (req, res, next) => authController.getMe(req, res, next),
);

/**
 * @route   GET /api/v1/auth/consents
 * @desc    Get live partner terms and lease consent records
 * @access  Private (Bearer Supabase JWT token + role=PARTNER)
 */
router.get(
  '/consents',
  authenticate,
  requireRole(ROLES.PARTNER),
  (req, res, next) => authController.getConsents(req, res, next),
);

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Server-side logout with Supabase token revocation
 * @access  Private (Bearer Supabase JWT token)
 */
router.post(
  '/logout',
  authenticate,
  (req, res, next) => authController.logout(req, res, next),
);

/**
 * @route   POST /api/v1/auth/dev-login
 * @desc    Development-only deterministic authenticated session generation
 * @access  Strictly non-production and PARTNER_DEV_AUTH_ENABLED only
 */
const isDevAuthEnabled =
  (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') &&
  env.PARTNER_DEV_AUTH_ENABLED === true &&
  !env.isProduction;

if (isDevAuthEnabled) {
  router.post(
    '/dev-login',
    (req, res, next) => authController.devLogin(req, res, next),
  );
  logger.info('[Auth Routes] Mounted route: POST /api/v1/auth/dev-login (dev auth active)');
} else if (env.NODE_ENV === 'development') {
  logger.info('[Auth Routes] Dev Auth route not mounted: PARTNER_DEV_AUTH_ENABLED is false');
}

module.exports = router;
