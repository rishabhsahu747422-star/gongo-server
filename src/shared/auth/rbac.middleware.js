'use strict';

const {
  requireAuthenticatedUser,
  requireRole,
  requirePermission,
  requireAnyPermission,
} = require('./authorization.middleware');

/**
 * Convenience RBAC middleware combining authentication check + role/permission check.
 */
function requireRoles(...roles) {
  const roleChecker = requireRole(...roles);
  return (req, res, next) => {
    requireAuthenticatedUser(req, res, (err) => {
      if (err) return next(err);
      return roleChecker(req, res, next);
    });
  };
}

function requirePermissions(...permissions) {
  const permChecker = permissions.length === 1
    ? requirePermission(permissions[0])
    : requireAnyPermission(...permissions);

  return (req, res, next) => {
    requireAuthenticatedUser(req, res, (err) => {
      if (err) return next(err);
      return permChecker(req, res, next);
    });
  };
}

module.exports = {
  requireRoles,
  requirePermissions,
};
