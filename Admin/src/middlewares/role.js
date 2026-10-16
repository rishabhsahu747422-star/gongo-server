'use strict';

const { ForbiddenError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { ROLES } = require('../constants/roles');

/**
 * Middleware factory enforcing specific role membership.
 *
 * @param {string|string[]} roles Single allowed role or array of allowed roles
 * @returns {import('express').RequestHandler}
 */
function requireRole(roles = ROLES.ADMIN) {
  const allowed = (Array.isArray(roles) ? roles : [roles])
    .map((r) => String(r).toLowerCase().trim());

  return function roleMiddleware(req, res, next) {
    if (!req.user || !req.user.role) {
      return next(new ForbiddenError('Access forbidden: user role missing', ERROR_CODES.FORBIDDEN));
    }

    const userRole = String(req.user.role).toLowerCase().trim();
    if (userRole === 'super_admin' || allowed.includes(userRole)) {
      return next();
    }

    return next(new ForbiddenError('Access forbidden: insufficient role permissions', ERROR_CODES.FORBIDDEN));
  };
}

module.exports = { requireRole };
