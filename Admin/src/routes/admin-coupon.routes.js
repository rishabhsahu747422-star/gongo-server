'use strict';

const express = require('express');
const adminCouponController = require('../controllers/admin-coupon.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');

const router = express.Router();

router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

// GET /api/v1/admin/coupons
router.get('/', (req, res, next) => adminCouponController.listCoupons(req, res, next));

// POST /api/v1/admin/coupons
router.post('/', sensitiveOpLimiter, (req, res, next) => adminCouponController.createCoupon(req, res, next));

// GET /api/v1/admin/coupons/:id
router.get('/:id', (req, res, next) => adminCouponController.getCouponDetail(req, res, next));

// PATCH /api/v1/admin/coupons/:id
router.patch('/:id', sensitiveOpLimiter, (req, res, next) => adminCouponController.updateCoupon(req, res, next));

// DELETE /api/v1/admin/coupons/:id
router.delete('/:id', sensitiveOpLimiter, (req, res, next) => adminCouponController.deleteCoupon(req, res, next));

// GET /api/v1/admin/coupons/:id/redemptions
router.get('/:id/redemptions', (req, res, next) => adminCouponController.getCouponRedemptions(req, res, next));

module.exports = router;
