'use strict';

const express = require('express');
const earningsController = require('../controllers/earnings.controller');
const earningsValidator = require('../validators/earnings.validator');
const { createRateLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

const earningsReadLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:earnings:read',
});

/**
 * @route   GET /api/v1/partner/earnings
 * @desc    Retrieves paginated, filtered earnings records.
 * @access  Private (Partner)
 */
router.get(
  '/',
  earningsReadLimiter,
  (req, res, next) => earningsValidator.validateEarningsListQuery(req, res, next),
  (req, res, next) => earningsController.getEarnings(req, res, next),
);

/**
 * @route   GET /api/v1/partner/earnings/summary
 * @desc    Retrieves aggregated earnings summary metrics.
 * @access  Private (Partner)
 */
router.get(
  '/summary',
  earningsReadLimiter,
  (req, res, next) => earningsController.getSummary(req, res, next),
);

/**
 * @route   GET /api/v1/partner/earnings/:earningId
 * @desc    Retrieves single earnings record (strict BOLA double-ownership enforced).
 * @access  Private (Partner)
 */
router.get(
  '/:earningId',
  earningsReadLimiter,
  (req, res, next) => earningsValidator.validateEarningIdParam(req, res, next),
  (req, res, next) => earningsController.getEarningById(req, res, next),
);

module.exports = router;
