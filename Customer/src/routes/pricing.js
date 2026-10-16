'use strict';

const express = require('express');
const pricingController = require('../controllers/pricing.controller');
const authenticate = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { validatePricingQuote } = require('../validators/pricing.validator');

const router = express.Router();

/**
 * All pricing routes require authentication and customer role.
 */
router.use(authenticate);
router.use(requireRole('customer'));

/**
 * @route   POST /api/v1/pricing/quote
 * @desc    Get commercial pricing quote breakdown with optional coupon
 * @access  Customer
 */
router.post(
  '/quote',
  validatePricingQuote,
  (req, res, next) => pricingController.getQuote(req, res, next),
);

module.exports = router;
