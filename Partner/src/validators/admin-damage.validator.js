'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { isValidUuid } = require('./index');

const ALLOWED_DAMAGE_STATUSES = Object.freeze([
  'REPORTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'SETTLED',
]);

class AdminDamageValidator {
  /**
   * Validates query parameters for listing damage reports.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateDamageListQuery(req, res, next) {
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
          if (!ALLOWED_DAMAGE_STATUSES.includes(normStatus)) {
            errors.push({
              field: 'status',
              message: `status must be one of: [${ALLOWED_DAMAGE_STATUSES.join(', ')}]`,
            });
          } else {
            options.status = normStatus;
          }
        }
      }

      // bookingId
      if (query.bookingId) {
        if (!isValidUuid(query.bookingId)) {
          errors.push({ field: 'bookingId', message: 'bookingId must be a valid UUID' });
        } else {
          options.bookingId = query.bookingId.trim();
        }
      }

      // vehicleId
      if (query.vehicleId) {
        if (!isValidUuid(query.vehicleId)) {
          errors.push({ field: 'vehicleId', message: 'vehicleId must be a valid UUID' });
        } else {
          options.vehicleId = query.vehicleId.trim();
        }
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for damage report list query', errors);
      }

      req.validatedQuery = options;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates :damageId UUID path parameter.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateDamageIdParam(req, res, next) {
    try {
      const { damageId } = req.params;
      if (!isValidUuid(damageId)) {
        throw new ValidationError('Invalid damage report ID format. Must be a valid UUID.', [
          { field: 'damageId', message: 'damageId must be a valid UUID' },
        ], ERROR_CODES.INVALID_UUID);
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates approve damage request body.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateApproveDamage(req, res, next) {
    try {
      const body = req.body || {};
      const errors = [];

      if (body.approvedAmount === undefined || body.approvedAmount === null || body.approvedAmount === '') {
        errors.push({ field: 'approvedAmount', message: 'approvedAmount is required' });
      } else {
        const num = Number(body.approvedAmount);
        if (Number.isNaN(num) || !Number.isFinite(num) || num <= 0) {
          errors.push({ field: 'approvedAmount', message: 'approvedAmount must be a positive number > 0' });
        } else {
          req.validatedBody = {
            approvedAmount: Number(num.toFixed(2)),
          };
        }
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for damage approval', errors);
      }

      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates reject damage request body.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateRejectDamage(req, res, next) {
    try {
      const body = req.body || {};
      const errors = [];

      if (body.reason !== undefined && body.reason !== null) {
        if (typeof body.reason !== 'string') {
          errors.push({ field: 'reason', message: 'reason must be a string' });
        } else if (body.reason.trim().length < 3) {
          errors.push({ field: 'reason', message: 'reason must be at least 3 characters long' });
        }
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for damage rejection', errors);
      }

      req.validatedBody = {
        reason: body.reason ? body.reason.trim() : null,
      };

      next();
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AdminDamageValidator();
