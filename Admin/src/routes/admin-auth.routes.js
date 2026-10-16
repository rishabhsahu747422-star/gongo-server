'use strict';

const express = require('express');
const adminAuthController = require('../controllers/admin-auth.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { ROLES } = require('../constants/roles');
const { auditMiddleware } = require('../middlewares/audit');
const { authLimiter, oauthLimiter, sensitiveOpLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

// ── Sign-in ──────────────────────────────────────────────────────────────────
// Email or mobile number + password (rate-limited per IP; per-account lockout in service)
router.post('/login', authLimiter, auditMiddleware, (req, res, next) => {
  adminAuthController.login(req, res, next);
});

// Verify 6-digit SMS OTP challenge (rate-limited per IP; attempt limit in service)
router.post('/verify-2fa', authLimiter, auditMiddleware, (req, res, next) => {
  adminAuthController.verify2FA(req, res, next);
});

// Resend OTP passcode (rate-limited per IP and cooldown-enforced in service)
router.post('/resend-2fa', authLimiter, auditMiddleware, (req, res, next) => {
  adminAuthController.resend2FA(req, res, next);
});

// Google sign-in (Authorization Code + PKCE, server-side token exchange)
router.get('/google/status', (req, res, next) => {
  adminAuthController.googleStatus(req, res, next);
});

router.get('/google', oauthLimiter, (req, res, next) => {
  adminAuthController.googleStart(req, res, next);
});

router.get('/google/callback', oauthLimiter, (req, res, next) => {
  adminAuthController.googleCallback(req, res, next);
});

router.post('/google/exchange', oauthLimiter, auditMiddleware, (req, res, next) => {
  adminAuthController.googleExchange(req, res, next);
});

// ── Authenticated session management ────────────────────────────────────────
// Link a Google account to the signed-in admin (requires current password)
router.post(
  '/google/link',
  sensitiveOpLimiter,
  authenticate,
  requireRole(ROLES.ADMIN),
  auditMiddleware,
  (req, res, next) => {
    adminAuthController.googleLinkStart(req, res, next);
  },
);

// Current authenticated administrator profile & session info
router.get('/me', authenticate, requireRole(ROLES.ADMIN), auditMiddleware, (req, res, next) => {
  adminAuthController.me(req, res, next);
});

// Change own password (revokes the admin's other sessions)
router.post(
  '/password/change',
  authLimiter,
  authenticate,
  requireRole(ROLES.ADMIN),
  auditMiddleware,
  (req, res, next) => {
    adminAuthController.changePassword(req, res, next);
  },
);

// Revoke current session (logout)
router.post('/logout', authenticate, requireRole(ROLES.ADMIN), auditMiddleware, (req, res, next) => {
  adminAuthController.logout(req, res, next);
});

// Revoke all sessions for current administrator (logout-all)
router.post(
  '/logout-all',
  authenticate,
  requireRole(ROLES.ADMIN),
  auditMiddleware,
  (req, res, next) => {
    adminAuthController.logoutAll(req, res, next);
  },
);

// Alias: /revoke-all -> logout-all
router.post(
  '/revoke-all',
  authenticate,
  requireRole(ROLES.ADMIN),
  auditMiddleware,
  (req, res, next) => {
    adminAuthController.logoutAll(req, res, next);
  },
);

// Session rotation / refresh
router.post('/refresh', authLimiter, auditMiddleware, (req, res, next) => {
  adminAuthController.refresh(req, res, next);
});

module.exports = router;
