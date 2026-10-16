'use strict';

const express = require('express');
const bankAccountController = require('../controllers/bank-account.controller');
const bankAccountValidator = require('../validators/bank-account.validator');
const { createRateLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

const bankAccountWriteLimiter = createRateLimiter({
  max: 15,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:bank-account:write',
});

const bankAccountReadLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:bank-account:read',
});

/**
 * @route   POST /api/v1/partner/bank-account
 * @desc    Link/add a new bank account.
 * @access  Private (Partner)
 */
router.post(
  '/',
  bankAccountWriteLimiter,
  (req, res, next) => bankAccountValidator.validateCreateBankAccount(req, res, next),
  (req, res, next) => bankAccountController.addBankAccount(req, res, next),
);

/**
 * @route   GET /api/v1/partner/bank-account
 * @desc    List all partner bank accounts.
 * @access  Private (Partner)
 */
router.get(
  '/',
  bankAccountReadLimiter,
  (req, res, next) => bankAccountController.getBankAccounts(req, res, next),
);

/**
 * @route   GET /api/v1/partner/bank-account/:bankAccountId
 * @desc    Get single bank account by ID.
 * @access  Private (Partner)
 */
router.get(
  '/:bankAccountId',
  bankAccountReadLimiter,
  (req, res, next) => bankAccountValidator.validateBankAccountIdParam(req, res, next),
  (req, res, next) => bankAccountController.getBankAccountById(req, res, next),
);

/**
 * @route   DELETE /api/v1/partner/bank-account/:bankAccountId
 * @desc    Delete a partner bank account.
 * @access  Private (Partner)
 */
router.delete(
  '/:bankAccountId',
  bankAccountWriteLimiter,
  (req, res, next) => bankAccountValidator.validateBankAccountIdParam(req, res, next),
  (req, res, next) => bankAccountController.deleteBankAccount(req, res, next),
);

module.exports = router;
