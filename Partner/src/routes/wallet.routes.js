'use strict';

const express = require('express');
const walletController = require('../controllers/wallet.controller');
const walletValidator = require('../validators/wallet.validator');
const { createRateLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

const walletReadLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:wallet:read',
});

/**
 * @route   GET /api/v1/partner/wallet
 * @desc    Retrieves partner wallet balances, totals, and currency.
 * @access  Private (Partner)
 */
router.get(
  '/',
  walletReadLimiter,
  (req, res, next) => walletController.getWallet(req, res, next),
);

/**
 * @route   GET /api/v1/partner/wallet/transactions
 * @desc    Retrieves paginated, filtered list of immutable wallet ledger transactions.
 * @access  Private (Partner)
 */
router.get(
  '/transactions',
  walletReadLimiter,
  (req, res, next) => walletValidator.validateTransactionListQuery(req, res, next),
  (req, res, next) => walletController.getTransactions(req, res, next),
);

/**
 * @route   GET /api/v1/partner/wallet/transactions/:transactionId
 * @desc    Retrieves single transaction audit record (Strict BOLA double-ownership enforced).
 * @access  Private (Partner)
 */
router.get(
  '/transactions/:transactionId',
  walletReadLimiter,
  (req, res, next) => walletValidator.validateTransactionIdParam(req, res, next),
  (req, res, next) => walletController.getTransactionById(req, res, next),
);

const payoutController = require('../controllers/payout.controller');
const payoutValidator = require('../validators/payout.validator');

const payoutWriteLimiter = createRateLimiter({
  max: 10,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:payouts:write',
});

/**
 * @route   POST /api/v1/partner/wallet/payout-requests
 * @desc    Partner raises payout request (wallet balance is NOT deducted until admin marks paid)
 * @access  Private (Partner)
 */
router.post(
  '/payout-requests',
  payoutWriteLimiter,
  (req, res, next) => payoutValidator.validateRequestPayout(req, res, next),
  (req, res, next) => payoutController.requestPayout(req, res, next),
);

/**
 * @route   GET /api/v1/partner/wallet/payout-requests
 * @desc    Partner views list of their payout requests
 * @access  Private (Partner)
 */
router.get(
  '/payout-requests',
  walletReadLimiter,
  (req, res, next) => payoutValidator.validatePayoutListQuery(req, res, next),
  (req, res, next) => payoutController.getPayouts(req, res, next),
);

/**
 * @route   GET /api/v1/partner/wallet/payout-requests/:payoutId
 * @desc    Partner views details of single payout request
 * @access  Private (Partner)
 */
router.get(
  '/payout-requests/:payoutId',
  walletReadLimiter,
  (req, res, next) => payoutValidator.validatePayoutIdParam(req, res, next),
  (req, res, next) => payoutController.getPayoutById(req, res, next),
);

module.exports = router;

