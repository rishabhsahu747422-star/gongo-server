'use strict';

const { BadRequestError } = require('../errors');
const { DEVICE_PLATFORM } = require('../constants/notification');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORBIDDEN_DEVICE_FIELDS = new Set([
  'customer_id',
  'customerId',
  'userId',
  'user_id',
  'id',
  'is_active',
  'isActive',
  'last_seen_at',
  'lastSeenAt',
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
]);

/**
 * Validates device registration request: POST /api/v1/customers/me/devices
 */
function validateRegisterDevice(req, res, next) {
  const { body } = req;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(new BadRequestError('Request body must be a JSON object', 'VALIDATION_ERROR'));
  }

  // Mass assignment rejection
  const keys = Object.keys(body);
  const forbidden = keys.filter((k) => FORBIDDEN_DEVICE_FIELDS.has(k));
  if (forbidden.length > 0) {
    return next(new BadRequestError(
      `Field(s) not allowed: ${forbidden.join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  const { deviceToken, platform, appVersion, deviceId } = body;

  if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.trim().length === 0) {
    return next(new BadRequestError('deviceToken is required and must be a string', 'VALIDATION_ERROR'));
  }

  if (deviceToken.length < 10 || deviceToken.length > 500) {
    return next(new BadRequestError(
      'deviceToken must be between 10 and 500 characters',
      'VALIDATION_ERROR',
    ));
  }

  if (!platform || typeof platform !== 'string') {
    return next(new BadRequestError('platform is required and must be a string', 'VALIDATION_ERROR'));
  }

  const normalizedPlatform = platform.toUpperCase().trim();
  const isSupportedPlatform = (
    normalizedPlatform === DEVICE_PLATFORM.ANDROID
    || normalizedPlatform === DEVICE_PLATFORM.IOS
  );
  if (!isSupportedPlatform) {
    return next(new BadRequestError("platform must be either 'ANDROID' or 'IOS'", 'VALIDATION_ERROR'));
  }

  req.body.platform = normalizedPlatform;
  req.body.deviceToken = deviceToken.trim();

  if (appVersion !== undefined && appVersion !== null) {
    if (typeof appVersion !== 'string' || appVersion.length > 50) {
      return next(new BadRequestError('appVersion cannot exceed 50 characters', 'VALIDATION_ERROR'));
    }
  }

  if (deviceId !== undefined && deviceId !== null) {
    if (typeof deviceId !== 'string' || deviceId.length > 255) {
      return next(new BadRequestError('deviceId cannot exceed 255 characters', 'VALIDATION_ERROR'));
    }
  }

  return next();
}

/**
 * Validates notification list query params: GET /api/v1/customers/me/notifications
 */
function validateListNotifications(req, res, next) {
  const { page, limit, unreadOnly } = req.query;

  if (page !== undefined) {
    const pageNum = Number(page);
    if (!Number.isInteger(pageNum) || pageNum < 1) {
      return next(new BadRequestError('page must be an integer >= 1', 'VALIDATION_ERROR'));
    }
    req.query.page = pageNum;
  }

  if (limit !== undefined) {
    const limitNum = Number(limit);
    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 50) {
      return next(new BadRequestError('limit must be an integer between 1 and 50', 'VALIDATION_ERROR'));
    }
    req.query.limit = limitNum;
  }

  if (unreadOnly !== undefined) {
    if (unreadOnly === 'true' || unreadOnly === true) {
      req.query.unreadOnly = true;
    } else if (unreadOnly === 'false' || unreadOnly === false) {
      req.query.unreadOnly = false;
    } else {
      return next(new BadRequestError("unreadOnly must be 'true' or 'false'", 'VALIDATION_ERROR'));
    }
  }

  return next();
}

/**
 * Validates notificationId UUID parameter.
 */
function validateNotificationId(req, res, next) {
  const { notificationId } = req.params;
  if (!notificationId || !UUID_REGEX.test(notificationId)) {
    return next(new BadRequestError('Invalid notification ID format (must be UUID)', 'VALIDATION_ERROR'));
  }
  return next();
}

/**
 * Validates deviceId UUID parameter.
 */
function validateDeviceId(req, res, next) {
  const { deviceId } = req.params;
  if (!deviceId || !UUID_REGEX.test(deviceId)) {
    return next(new BadRequestError('Invalid device ID format (must be UUID)', 'VALIDATION_ERROR'));
  }
  return next();
}

module.exports = {
  validateRegisterDevice,
  validateListNotifications,
  validateNotificationId,
  validateDeviceId,
};
