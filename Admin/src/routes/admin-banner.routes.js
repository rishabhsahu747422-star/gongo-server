'use strict';

const express = require('express');
const adminBannerController = require('../controllers/admin-banner.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter, normalQueryLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');

const router = express.Router();

router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

// GET /api/v1/admin/banners
router.get('/', normalQueryLimiter, (req, res, next) => adminBannerController.listBanners(req, res, next));

// POST /api/v1/admin/banners/upload (Must precede /:id)
router.post('/upload', sensitiveOpLimiter, (req, res, next) => adminBannerController.uploadAsset(req, res, next));

// POST /api/v1/admin/banners/bulk (Must precede /:id)
router.post('/bulk', sensitiveOpLimiter, (req, res, next) => adminBannerController.createBulk(req, res, next));

// PUT /api/v1/admin/banners/reorder (Must precede /:id)
router.put('/reorder', sensitiveOpLimiter, (req, res, next) => adminBannerController.reorderBanners(req, res, next));

// POST /api/v1/admin/banners
router.post('/', sensitiveOpLimiter, (req, res, next) => adminBannerController.createBanner(req, res, next));

// GET /api/v1/admin/banners/:id
router.get('/:id', normalQueryLimiter, (req, res, next) => adminBannerController.getBannerDetail(req, res, next));

// PATCH /api/v1/admin/banners/:id
router.patch('/:id', sensitiveOpLimiter, (req, res, next) => adminBannerController.updateBanner(req, res, next));

// PATCH /api/v1/admin/banners/:id/status
router.patch('/:id/status', sensitiveOpLimiter, (req, res, next) => adminBannerController.updateStatus(req, res, next));

// DELETE /api/v1/admin/banners/:id
router.delete('/:id', sensitiveOpLimiter, (req, res, next) => adminBannerController.deleteBanner(req, res, next));

module.exports = router;
