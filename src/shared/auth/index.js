'use strict';

const { ROLES, ROLE_VALUES, normalizeRole, isRoleValid } = require('./roles.enum');
const { PERMISSIONS, PERMISSION_VALUES, isPermissionValid } = require('./permissions.enum');
const { ROLE_PERMISSIONS, roleHasPermission, getPermissionsForRole } = require('./role-permissions');
const {
  requireAuthenticatedUser,
  requireRole,
  requirePermission,
  requireAnyPermission,
} = require('./authorization.middleware');
const { requireRoles, requirePermissions } = require('./rbac.middleware');
const { assertOwnership, verifyOwnership } = require('./resource-ownership');
const { extractToken, normalizeUserContext } = require('./authentication.middleware');

module.exports = {
  ROLES,
  ROLE_VALUES,
  normalizeRole,
  isRoleValid,
  PERMISSIONS,
  PERMISSION_VALUES,
  isPermissionValid,
  ROLE_PERMISSIONS,
  roleHasPermission,
  getPermissionsForRole,
  requireAuthenticatedUser,
  requireRole,
  requirePermission,
  requireAnyPermission,
  requireRoles,
  requirePermissions,
  assertOwnership,
  verifyOwnership,
  extractToken,
  normalizeUserContext,
};
