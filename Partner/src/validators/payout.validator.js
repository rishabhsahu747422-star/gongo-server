'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { isValidUuid } = require('./index');

const ALLOWED_PAYOUT_STATUSES = Object.freeze([
  'REQUESTED',
  'PENDING',
  'PROCESSING',
  'APPROVED',
  'COMPLETED',
  'PAID',
  'FAILED',
  'REJECTED',
  'CANCELLED',
]);

const MIN_PAYOUT_AMOUNT = 100.00;
const MAX_PAYOUT_AMOUNT = 500000.00;

class PayoutValidator {
  /**
   * Validates payout request payload.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateRequestPayout(req, res, next) {
    try {
      const body = req.body || {};
      const errors = [];

      // Protected fields
      const protectedFields = [
        'id', 'partner_id', 'partnerId',
        'status', 'provider_transfer_id', 'providerTransferId',
        'failure_reason', 'failureReason',
        'requested_at', 'requestedAt', 'processed_at', 'processedAt',
        'created_at', 'createdAt', 'updated_at', 'updatedAt',
      ];
      protectedFields.forEach((field) => {
        if (body[field] !== undefined) {
          errors.push({
            field,
            message: `Field '${field}' is server-managed and cannot be supplied`,
          });
        }
      });

      // amount
      if (body.amount === undefined || body.amount === null || body.amount === '') {
        errors.push({ field: 'amount', message: 'amount is required' });
      } else {
        const numAmount = Number(body.amount);
        if (Number.isNaN(numAmount) || !Number.isFinite(numAmount)) {
          errors.push({ field: 'amount', message: 'amount must be a valid number' });
        } else if (numAmount < MIN_PAYOUT_AMOUNT) {
          errors.push({
            field: 'amount',
            message: `Minimum payout withdrawal amount is ₹${MIN_PAYOUT_AMOUNT}`,
          });
        } else if (numAmount > MAX_PAYOUT_AMOUNT) {
          errors.push({
            field: 'amount',
            message: `Maximum payout withdrawal amount is ₹${MAX_PAYOUT_AMOUNT}`,
          });
        }
      }

      // bankAccountId (optional)
      if (body.bankAccountId !== undefined && body.bankAccountId !== null && body.bankAccountId !== '') {
        if (!isValidUuid(body.bankAccountId)) {
          errors.push({
            field: 'bankAccountId',
            message: 'bankAccountId must be a valid UUID',
          });
        }
      }

      // idempotencyKey from body or x-idempotency-key header
      const idempotencyKey = body.idempotencyKey
        || req.headers['x-idempotency-key']
        || null;

      if (idempotencyKey !== null && typeof idempotencyKey !== 'string') {
        errors.push({
          field: 'idempotencyKey',
          message: 'idempotencyKey must be a string',
        });
      } else if (idempotencyKey && idempotencyKey.length > 100) {
        errors.push({
          field: 'idempotencyKey',
          message: 'idempotencyKey cannot exceed 100 characters',
        });
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for payout request', errors);
      }

      req.validatedBody = {
        amount: Number(Number(body.amount).toFixed(2)),
        bankAccountId: body.bankAccountId || null,
        idempotencyKey: idempotencyKey ? idempotencyKey.trim() : null,
      };

      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates query parameters for listing payout requests.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validatePayoutListQuery(req, res, next) {
    try {
      const query = req.query || {};
      const errors = [];
      const options = {
        page: 1,
        limit: 20,
        offset: 0,
      };

      // page
      if (query.page !== undefined && query.page !== null && query.page !== '') {
        const pageNum = Number(query.page);
        if (!Number.isInteger(pageNum) || pageNum < 1) {
          errors.push({ field: 'page', message: 'page must be a positive integer >= 1' });
        } else {
          options.page = pageNum;
        }
      }

      // limit
      if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
        const limitNum = Number(query.limit);
        if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
          errors.push({ field: 'limit', message: 'limit must be an integer between 1 and 100' });
        } else {
          options.limit = limitNum;
        }
      }

      options.offset = (options.page - 1) * options.limit;

      // status
      if (query.status !== undefined && query.status !== null && query.status !== '') {
        if (typeof query.status !== 'string') {
          errors.push({ field: 'status', message: 'status must be a string' });
        } else {
          const normStatus = query.status.trim().toUpperCase();
          if (!ALLOWED_PAYOUT_STATUSES.includes(normStatus)) {
            errors.push({
              field: 'status',
              message: `status must be one of: [${ALLOWED_PAYOUT_STATUSES.join(', ')}]`,
            });
          } else {
            options.status = normStatus;
          }
        }
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for payout list query', errors);
      }

      req.validatedQuery = options;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates :payoutId UUID path parameter.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validatePayoutIdParam(req, res, next) {
    try {
      const { payoutId } = req.params;
      if (!isValidUuid(payoutId)) {
        throw new ValidationError('Invalid payout ID format. Must be a valid UUID.', [
          { field: 'payoutId', message: 'payoutId must be a valid UUID' },
        ], ERROR_CODES.INVALID_UUID);
      }
      next();
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new PayoutValidator();
