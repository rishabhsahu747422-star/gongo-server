'use strict';

const express = require('express');
const adminProfileController = require('../controllers/admin-profile.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');

const router = express.Router();

// All profile endpoints require authentication, active ADMIN role, and audit context
router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

// ── Profile Operations ────────────────────────────────────────────────────────

// GET /api/v1/admin/profile
// Retrieves the authenticated Admin's profile and account security summary
router.get('/', (req, res, next) => {
  adminProfileController.getProfile(req, res, next);
});

// PATCH /api/v1/admin/profile
// Updates permitted profile fields (name, phone, country_code) for the authenticated Admin
router.patch('/', sensitiveOpLimiter, (req, res, next) => {
  adminProfileController.updateProfile(req, res, next);
});

// ── Session Management Operations ─────────────────────────────────────────────

// GET /api/v1/admin/profile/sessions
// Lists the authenticated Admin's active sessions
router.get('/sessions', (req, res, next) => {
  adminProfileController.getActiveSessions(req, res, next);
});

// DELETE /api/v1/admin/profile/sessions/:sessionId
// Revokes a specific session belonging to the authenticated Admin
router.delete('/sessions/:sessionId', sensitiveOpLimiter, (req, res, next) => {
  adminProfileController.revokeSession(req, res, next);
});

// POST /api/v1/admin/profile/sessions/:sessionId/revoke
// Alias for session revocation
router.post('/sessions/:sessionId/revoke', sensitiveOpLimiter, (req, res, next) => {
  adminProfileController.revokeSession(req, res, next);
});

module.exports = router;
