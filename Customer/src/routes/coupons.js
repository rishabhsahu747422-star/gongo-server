'use strict';

const express = require('express');
const couponController = require('../controllers/coupon.controller');
const authenticate = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { validateCouponCheck } = require('../validators/coupon.validator');

const router = express.Router();

/**
 * All coupon endpoints require authentication and customer role.
 */
router.use(authenticate);
router.use(requireRole('customer'));

/**
 * @route   GET /api/v1/coupons
 * @desc    Get active coupons list
 * @access  Customer
 */
router.get(
  '/',
  (req, res, next) => couponController.listActive(req, res, next),
);

/**
 * @route   POST /api/v1/coupons/validate
 * @desc    Validate a coupon code against a rental booking window
 * @access  Customer
 */
router.post(
  '/validate',
  validateCouponCheck,
  (req, res, next) => couponController.validate(req, res, next),
);

module.exports = router;
