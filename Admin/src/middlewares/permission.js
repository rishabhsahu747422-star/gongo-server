'use strict';

const { ForbiddenError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const logger = require('../config/logger');

/**
 * Middleware factory enforcing that the admin has ANY of the specified permissions.
 * SUPER_ADMIN bypasses all permission checks.
 *
 * @param {string|string[]} permissions Required admin permission(s) — ANY match grants access
 * @returns {import('express').RequestHandler}
 */
function requirePermission(...permissions) {
  const required = permissions.flat();

  return function permissionMiddleware(req, res, next) {
    if (!req.user) {
      return next(new ForbiddenError('Access forbidden: unauthenticated request', ERROR_CODES.FORBIDDEN));
    }

    // SUPER_ADMIN has access to everything
    const userPermissions = req.user.permissions || [];
    if (userPermissions.includes('SUPER_ADMIN')) {
      return next();
    }

    const hasPermission = required.some((perm) => userPermissions.includes(perm));
    if (!hasPermission) {
      logger.warn('Permission denied', {
        userId: req.user.id,
        required,
        userPermissions,
        path: req.originalUrl,
        method: req.method,
      });

      return next(
        new ForbiddenError(
          `Access forbidden: required permission [${required.join(', ')}]`,
          ERROR_CODES.INSUFFICIENT_PERMISSIONS,
        ),
      );
    }

    return next();
  };
}

/**
 * Middleware factory enforcing that the admin has ALL of the specified permissions.
 * SUPER_ADMIN bypasses all permission checks.
 *
 * @param {string[]} permissions Required admin permissions — ALL must be present
 * @returns {import('express').RequestHandler}
 */
function requireAllPermissions(...permissions) {
  const required = permissions.flat();

  return function allPermissionsMiddleware(req, res, next) {
    if (!req.user) {
      return next(new ForbiddenError('Access forbidden: unauthenticated request', ERROR_CODES.FORBIDDEN));
    }

    const userPermissions = req.user.permissions || [];
    if (userPermissions.includes('SUPER_ADMIN')) {
      return next();
    }

    const missingPermissions = required.filter((perm) => !userPermissions.includes(perm));
    if (missingPermissions.length > 0) {
      logger.warn('Permission denied (all-of check)', {
        userId: req.user.id,
        required,
        missing: missingPermissions,
        path: req.originalUrl,
        method: req.method,
      });

      return next(
        new ForbiddenError(
          `Access forbidden: required all permissions [${required.join(', ')}]`,
          ERROR_CODES.INSUFFICIENT_PERMISSIONS,
        ),
      );
    }

    return next();
  };
}

module.exports = { requirePermission, requireAllPermissions };
