'use strict';

const express = require('express');
const adminReviewController = require('../controllers/admin-review.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');

const router = express.Router();

router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

// GET /api/v1/admin/reviews
router.get('/', (req, res, next) => adminReviewController.listReviews(req, res, next));

// GET /api/v1/admin/reviews/reports (and alias for review reports)
router.get('/reports', (req, res, next) => adminReviewController.listReviewReports(req, res, next));

// GET /api/v1/admin/reviews/:id
router.get('/:id', (req, res, next) => adminReviewController.getReviewById(req, res, next));

// PATCH /api/v1/admin/reviews/:id/status
router.patch('/:id/status', sensitiveOpLimiter, (req, res, next) => adminReviewController.updateReviewStatus(req, res, next));

// PATCH /api/v1/admin/reviews/reports/:id/resolve
router.patch('/reports/:id/resolve', sensitiveOpLimiter, (req, res, next) => adminReviewController.resolveReviewReport(req, res, next));

module.exports = router;
