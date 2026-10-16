'use strict';

const { ForbiddenError, UnauthorizedError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

/**
 * Role Authorization Middleware Factory.
 *
 * Verifies that the authenticated user possesses one of the required roles.
 *
 * Security rules:
 * - Role is read ONLY from trusted backend identity attached to req.user.
 * - Client-supplied role parameters (req.body.role, req.query.role, req.params.role)
 *   are completely ignored.
 * - Non-matching roles receive 403 Forbidden with stable machine-readable code.
 *
 * @param {...string} allowedRoles Roles permitted to access the route
 * @returns {import('express').RequestHandler}
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required before role check', ERROR_CODES.AUTH_REQUIRED));
    }

    const userRole = req.user.role ? String(req.user.role).toUpperCase() : null;

    if (!userRole) {
      return next(new ForbiddenError('User has no role assigned', ERROR_CODES.FORBIDDEN));
    }

    const normalizedAllowed = allowedRoles.map((r) => String(r).toUpperCase());
    if (!normalizedAllowed.includes(userRole)) {
      return next(new ForbiddenError('Access forbidden: insufficient role permissions', ERROR_CODES.FORBIDDEN));
    }

    next();
  };
}

module.exports = { requireRole };
