'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { isValidUuid } = require('./index');

const ALLOWED_PLATFORMS = Object.freeze(['android', 'ios', 'web']);

class NotificationValidator {
  /**
   * Validates query parameters for listing partner notifications.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateNotificationListQuery(req, res, next) {
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

      // isRead
      if (query.isRead !== undefined && query.isRead !== null && query.isRead !== '') {
        if (query.isRead === 'true' || query.isRead === true) {
          options.isRead = true;
        } else if (query.isRead === 'false' || query.isRead === false) {
          options.isRead = false;
        } else {
          errors.push({ field: 'isRead', message: 'isRead must be a boolean (true or false)' });
        }
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for notifications list query', errors);
      }

      req.validatedQuery = options;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates :notificationId UUID path parameter.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateNotificationIdParam(req, res, next) {
    try {
      const { notificationId } = req.params;
      if (!isValidUuid(notificationId)) {
        throw new ValidationError('Invalid notification ID format. Must be a valid UUID.', [
          { field: 'notificationId', message: 'notificationId must be a valid UUID' },
        ], ERROR_CODES.INVALID_UUID);
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates device token registration payload.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateDeviceTokenPayload(req, res, next) {
    try {
      const body = req.body || {};
      const errors = [];

      if (!body.token || typeof body.token !== 'string' || body.token.trim() === '') {
        errors.push({ field: 'token', message: 'token is required and cannot be empty' });
      } else if (body.token.trim().length > 500) {
        errors.push({ field: 'token', message: 'token cannot exceed 500 characters' });
      }

      let platform = 'android';
      if (body.platform !== undefined && body.platform !== null) {
        if (typeof body.platform !== 'string') {
          errors.push({ field: 'platform', message: 'platform must be a string' });
        } else {
          const normPlatform = body.platform.trim().toLowerCase();
          if (!ALLOWED_PLATFORMS.includes(normPlatform)) {
            errors.push({
              field: 'platform',
              message: `platform must be one of: [${ALLOWED_PLATFORMS.join(', ')}]`,
            });
          } else {
            platform = normPlatform;
          }
        }
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for device token registration', errors);
      }

      req.validatedBody = {
        token: body.token.trim(),
        platform,
      };

      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates device token removal payload.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateRemoveTokenPayload(req, res, next) {
    try {
      const body = req.body || {};
      const errors = [];

      if (!body.token || typeof body.token !== 'string' || body.token.trim() === '') {
        errors.push({ field: 'token', message: 'token is required and cannot be empty' });
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for device token removal', errors);
      }

      req.validatedBody = {
        token: body.token.trim(),
      };

      next();
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new NotificationValidator();
