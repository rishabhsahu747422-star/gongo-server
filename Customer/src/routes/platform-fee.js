'use strict';

const express = require('express');
const platformFeeController = require('../controllers/platform-fee.controller');
const authenticate = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { ForbiddenError } = require('../errors');

const router = express.Router();

/**
 * Customer Platform Fee API.
 * Read-only access for authenticated customer users.
 */
router.use(authenticate);
router.use(requireRole('customer', 'CUSTOMER'));

/**
 * @route   GET /api/v1/customer/platform-fee
 * @route   GET /api/v1/platform-fee
 * @desc    Get currently active platform fee configuration for checkout
 * @access  Customer
 */
router.get('/', (req, res, next) => platformFeeController.getPlatformFee(req, res, next));

/**
 * Disallow modification attempts by customers.
 */
router.all('/', (req, res, next) => {
  if (req.method !== 'GET') {
    return next(new ForbiddenError('Customer cannot modify platform fee', 'FORBIDDEN_OPERATION'));
  }
  return next();
});

module.exports = router;
