'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { isValidUuid } = require('./index');
const { TRANSACTION_DIRECTION } = require('../constants/wallet');

const ALLOWED_DIRECTIONS = Object.freeze([
  TRANSACTION_DIRECTION.CREDIT,
  TRANSACTION_DIRECTION.DEBIT,
]);

class WalletValidator {
  /**
   * Validates query parameters for listing wallet ledger transactions.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateTransactionListQuery(req, res, next) {
    try {
      const query = req.query || {};
      const errors = [];
      const options = {
        page: 1,
        limit: 20,
        offset: 0,
      };

      // 1. page
      if (query.page !== undefined && query.page !== null && query.page !== '') {
        const pageNum = Number(query.page);
        if (!Number.isInteger(pageNum) || pageNum < 1) {
          errors.push({ field: 'page', message: 'page must be a positive integer >= 1' });
        } else {
          options.page = pageNum;
        }
      }

      // 2. limit
      if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
        const limitNum = Number(query.limit);
        if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
          errors.push({ field: 'limit', message: 'limit must be an integer between 1 and 100' });
        } else {
          options.limit = limitNum;
        }
      }

      options.offset = (options.page - 1) * options.limit;

      // 3. direction (CREDIT | DEBIT)
      if (query.direction !== undefined && query.direction !== null && query.direction !== '') {
        if (typeof query.direction !== 'string') {
          errors.push({ field: 'direction', message: 'direction must be a string' });
        } else {
          const normDirection = query.direction.trim().toUpperCase();
          if (!ALLOWED_DIRECTIONS.includes(normDirection)) {
            errors.push({
              field: 'direction',
              message: `direction must be one of: [${ALLOWED_DIRECTIONS.join(', ')}]`,
            });
          } else {
            options.direction = normDirection;
          }
        }
      }

      // 4. type
      if (query.type !== undefined && query.type !== null && query.type !== '') {
        if (typeof query.type !== 'string') {
          errors.push({ field: 'type', message: 'type must be a string' });
        } else {
          options.type = query.type.trim().toUpperCase();
        }
      }

      // 5. Date Range (startDate & endDate)
      let parsedStart = null;
      let parsedEnd = null;

      if (query.startDate) {
        parsedStart = new Date(query.startDate);
        if (Number.isNaN(parsedStart.getTime())) {
          errors.push({ field: 'startDate', message: 'startDate must be a valid ISO 8601 date' });
        } else {
          options.startDate = parsedStart.toISOString();
        }
      }

      if (query.endDate) {
        parsedEnd = new Date(query.endDate);
        if (Number.isNaN(parsedEnd.getTime())) {
          errors.push({ field: 'endDate', message: 'endDate must be a valid ISO 8601 date' });
        } else {
          options.endDate = parsedEnd.toISOString();
        }
      }

      if (parsedStart && parsedEnd && parsedEnd < parsedStart) {
        errors.push({ field: 'endDate', message: 'endDate must be greater than or equal to startDate' });
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for transaction list query', errors);
      }

      req.validatedQuery = options;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates :transactionId UUID path parameter.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateTransactionIdParam(req, res, next) {
    try {
      const { transactionId } = req.params;
      if (!isValidUuid(transactionId)) {
        throw new ValidationError('Invalid transaction ID format. Must be a valid UUID.', [
          { field: 'transactionId', message: 'transactionId must be a valid UUID' },
        ], ERROR_CODES.INVALID_UUID);
      }
      next();
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new WalletValidator();
