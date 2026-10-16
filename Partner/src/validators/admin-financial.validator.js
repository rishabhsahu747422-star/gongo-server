'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { isValidUuid } = require('./index');

const ALLOWED_SETTLEMENT_STATUSES = Object.freeze([
  'PENDING',
  'SETTLED',
  'ON_HOLD',
  'CANCELLED',
]);

const ALLOWED_PAYOUT_STATUSES = Object.freeze([
  'REQUESTED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

class AdminFinancialValidator {
  /**
   * Validates query parameters for settlements and commission listing.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateFinancialListQuery(req, res, next) {
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

      // partnerId
      if (query.partnerId) {
        if (!isValidUuid(query.partnerId)) {
          errors.push({ field: 'partnerId', message: 'partnerId must be a valid UUID' });
        } else {
          options.partnerId = query.partnerId.trim();
        }
      }

      // status
      if (query.status) {
        const normStatus = query.status.trim().toUpperCase();
        if (
          !ALLOWED_SETTLEMENT_STATUSES.includes(normStatus)
          && !ALLOWED_PAYOUT_STATUSES.includes(normStatus)
        ) {
          errors.push({ field: 'status', message: 'status is invalid' });
        } else {
          options.status = normStatus;
        }
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for financial query', errors);
      }

      req.validatedQuery = options;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates payout action payload (process, fail).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateProcessPayout(req, res, next) {
    try {
      const body = req.body || {};
      req.validatedBody = {
        providerTransferId: body.providerTransferId ? String(body.providerTransferId).trim() : null,
      };
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates failure reason for failing a payout.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateFailPayout(req, res, next) {
    try {
      const body = req.body || {};
      const errors = [];

      if (!body.failureReason || typeof body.failureReason !== 'string' || body.failureReason.trim().length < 3) {
        errors.push({
          field: 'failureReason',
          message: 'failureReason is required and must be at least 3 characters long',
        });
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for payout failure action', errors);
      }

      req.validatedBody = {
        failureReason: body.failureReason.trim(),
      };
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

module.exports = new AdminFinancialValidator();
