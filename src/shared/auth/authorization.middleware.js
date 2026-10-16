'use strict';

const { UnauthorizedError, ForbiddenError } = require('../errors/AppError');
const { ERROR_CODES } = require('../constants/error-codes.enum');
const { normalizeRole, ROLES } = require('./roles.enum');
const { roleHasPermission } = require('./role-permissions');

/**
 * Ensures that the request contains a verified, trusted authenticated user.
 */
function requireAuthenticatedUser(req, res, next) {
  if (!req.user || !req.user.id) {
    return next(new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED));
  }
  return next();
}

/**
 * Reusable Role Authorization Middleware Factory.
 * Enforces that `req.user.role` matches at least one of the allowed roles.
 *
 * @param {...string} allowedRoles - Canonical or lowercase role strings
 * @returns {import('express').RequestHandler}
 */
function requireRole(...allowedRoles) {
  const targetRoles = (Array.isArray(allowedRoles[0]) ? allowedRoles[0] : allowedRoles)
    .map(normalizeRole)
    .filter(Boolean);

  return (req, res, next) => {
    if (!req.user || !req.user.id) {
      return next(new UnauthorizedError('Authentication required before authorization check', ERROR_CODES.AUTH_REQUIRED));
    }

    const userRole = normalizeRole(req.user.role);
    if (!userRole) {
      return next(new ForbiddenError('User has no valid role assigned', ERROR_CODES.FORBIDDEN));
    }

    // Super Admin has system-wide role bypass
    if (userRole === ROLES.SUPER_ADMIN) {
      return next();
    }

    if (!targetRoles.includes(userRole)) {
      return next(
        new ForbiddenError(
          `Access forbidden: required role ${targetRoles.join(' or ')} (current: ${userRole})`,
          ERROR_CODES.FORBIDDEN,
        ),
      );
    }

    return next();
  };
}

/**
 * Reusable Permission Authorization Middleware Factory.
 * Enforces that the user's role or explicit permissions grant the requested permission.
 *
 * @param {string} permission - Canonical permission string
 * @returns {import('express').RequestHandler}
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !req.user.id) {
      return next(new UnauthorizedError('Authentication required before permission check', ERROR_CODES.AUTH_REQUIRED));
    }

    const userRole = normalizeRole(req.user.role);
    if (userRole === ROLES.SUPER_ADMIN) {
      return next();
    }

    // Check user-specific explicit permissions first (e.g. admin permissions from DB)
    if (Array.isArray(req.user.permissions) && req.user.permissions.includes(permission)) {
      return next();
    }

    // Check canonical role-to-permission mapping
    if (userRole && roleHasPermission(userRole, permission)) {
      return next();
    }

    return next(
      new ForbiddenError(
        `Access forbidden: missing required permission [${permission}]`,
        ERROR_CODES.INSUFFICIENT_PERMISSIONS,
      ),
    );
  };
}

/**
 * Reusable Any-Permission Authorization Middleware Factory.
 * Enforces that the user has at least one of the specified permissions.
 *
 * @param {...string} permissions
 * @returns {import('express').RequestHandler}
 */
function requireAnyPermission(...permissions) {
  const targetPermissions = Array.isArray(permissions[0]) ? permissions[0] : permissions;

  return (req, res, next) => {
    if (!req.user || !req.user.id) {
      return next(new UnauthorizedError('Authentication required before permission check', ERROR_CODES.AUTH_REQUIRED));
    }

    const userRole = normalizeRole(req.user.role);
    if (userRole === ROLES.SUPER_ADMIN) {
      return next();
    }

    const hasAny = targetPermissions.some((perm) => {
      if (Array.isArray(req.user.permissions) && req.user.permissions.includes(perm)) {
        return true;
      }
      return userRole && roleHasPermission(userRole, perm);
    });

    if (hasAny) {
      return next();
    }

    return next(
      new ForbiddenError(
        `Access forbidden: requires at least one of [${targetPermissions.join(', ')}]`,
        ERROR_CODES.INSUFFICIENT_PERMISSIONS,
      ),
    );
  };
}

module.exports = {
  requireAuthenticatedUser,
  requireRole,
  requirePermission,
  requireAnyPermission,
};
