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

class EarningsValidator {
  /**
   * Validates query parameters for listing earnings records.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateEarningsListQuery(req, res, next) {
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

      // 3. status
      if (query.status !== undefined && query.status !== null && query.status !== '') {
        if (typeof query.status !== 'string') {
          errors.push({ field: 'status', message: 'status must be a string' });
        } else {
          const normStatus = query.status.trim().toUpperCase();
          if (!ALLOWED_SETTLEMENT_STATUSES.includes(normStatus)) {
            errors.push({
              field: 'status',
              message: `status must be one of: [${ALLOWED_SETTLEMENT_STATUSES.join(', ')}]`,
            });
          } else {
            options.status = normStatus;
          }
        }
      }

      // 4. Date range (startDate & endDate)
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
        throw new ValidationError('Validation failed for earnings list query', errors);
      }

      req.validatedQuery = options;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates :earningId UUID path parameter.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateEarningIdParam(req, res, next) {
    try {
      const { earningId } = req.params;
      if (!isValidUuid(earningId)) {
        throw new ValidationError('Invalid earning ID format. Must be a valid UUID.', [
          { field: 'earningId', message: 'earningId must be a valid UUID' },
        ], ERROR_CODES.INVALID_UUID);
      }
      next();
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new EarningsValidator();
