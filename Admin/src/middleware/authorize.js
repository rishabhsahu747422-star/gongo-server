'use strict';

const { ForbiddenError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

/**
 * Normalizes role string to lowercase standard.
 * @param {string} role
 * @returns {string}
 */
function normalizeRole(role) {
  if (!role) return '';
  return String(role).toLowerCase().trim();
}

/**
 * Centralized Admin Authorization Middleware Factory.
 * Enforces role-based access control (RBAC).
 *
 * Usage:
 *   authorize('admin')                     -> Only full administrators
 *   authorize('admin', 'support_executive') -> Admin and support executives
 *
 * @param {...string} allowedRoles Roles permitted to access the route
 * @returns {import('express').RequestHandler}
 */
function authorize(...allowedRoles) {
  // If array passed as first argument, flatten
  const targetRoles = (Array.isArray(allowedRoles[0]) ? allowedRoles[0] : allowedRoles)
    .map(normalizeRole);

  // If no roles specified, default to 'admin'
  const allowed = targetRoles.length > 0 ? targetRoles : ['admin'];

  return function authorizeMiddleware(req, res, next) {
    if (!req.user) {
      return next(
        new ForbiddenError('Access forbidden: authentication required', ERROR_CODES.FORBIDDEN),
      );
    }

    const userRole = normalizeRole(req.user.role);

    // Support executive check: NO unrestricted financial or admin config access
    if (userRole === 'support_executive' && !allowed.includes('support_executive')) {
      return next(
        new ForbiddenError(
          'Access forbidden: support executives do not have permission for this sensitive operation',
          ERROR_CODES.FORBIDDEN,
        ),
      );
    }

    if (!allowed.includes(userRole) && userRole !== 'super_admin') {
      return next(
        new ForbiddenError(
          `Access forbidden: required role ${allowed.join(' or ')} (current: ${userRole})`,
          ERROR_CODES.FORBIDDEN,
        ),
      );
    }

    return next();
  };
}

module.exports = {
  authorize,
  requireRole: authorize,
};
