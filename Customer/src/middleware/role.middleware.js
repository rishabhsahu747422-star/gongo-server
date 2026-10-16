'use strict';

const { ForbiddenError, UnauthorizedError } = require('../errors');

/**
 * Reusable role authorization middleware factory.
 * Enforces that `req.user.role` matches one of the allowed roles.
 * Must be mounted after `authenticate` middleware.
 *
 * @param {...string} allowedRoles - e.g. 'customer', 'admin', 'partner'
 * @returns {import('express').RequestHandler}
 */
function requireRole(...allowedRoles) {
  const normalizedAllowed = (Array.isArray(allowedRoles[0]) ? allowedRoles[0] : allowedRoles)
    .map(r => (typeof r === 'string' ? r.trim().toLowerCase() : ''))
    .filter(Boolean);

  if (normalizedAllowed.includes('customer') && !normalizedAllowed.includes('user')) {
    normalizedAllowed.push('user');
  }

  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return next(new UnauthorizedError('Authentication required before authorization', 'AUTH_REQUIRED'));
    }

    const userRole = typeof req.user.role === 'string' ? req.user.role.trim().toLowerCase() : '';
    if (!normalizedAllowed.includes(userRole)) {
      return next(
        new ForbiddenError(
          'You do not have permission to access this resource',
          'INSUFFICIENT_PERMISSIONS',
        ),
      );
    }

    next();
  };
}

module.exports = { requireRole };
