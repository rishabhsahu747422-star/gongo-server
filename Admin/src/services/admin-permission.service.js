'use strict';

const adminPermissionRepository = require('../repositories/admin-permission.repository');
const userRepository = require('../repositories/user.repository');
const auditService = require('./audit.service');
const { PERMISSIONS, VALID_PERMISSIONS } = require('../constants/permissions');
const { ROLES } = require('../constants/roles');
const { ForbiddenError, NotFoundError, ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const logger = require('../config/logger');

class AdminPermissionService {
  /**
   * Retrieves all permissions assigned to an admin user.
   *
   * @param {string} targetUserId Target admin user ID
   * @param {object} actor Authenticated actor performing the lookup
   * @returns {Promise<string[]>}
   */
  async getPermissions(targetUserId, actor) {
    this._assertActorAuthenticated(actor);

    // Validate target exists and is ADMIN
    const targetUser = await this._resolveAdminTarget(targetUserId);

    return adminPermissionRepository.findPermissionsByUserId(targetUser.id);
  }

  /**
   * Checks if a user has a specific permission.
   * Resolves from canonical admin_permissions table.
   *
   * @param {string} userId
   * @param {string} permission
   * @returns {Promise<boolean>}
   */
  async hasPermission(userId, permission) {
    const perms = await adminPermissionRepository.findPermissionsByUserId(userId);
    if (perms.includes(PERMISSIONS.SUPER_ADMIN)) {
      return true;
    }
    return perms.includes(permission);
  }

  /**
   * Checks if a user has ANY of the specified permissions.
   *
   * @param {string} userId
   * @param {string[]} permissions
   * @returns {Promise<boolean>}
   */
  async hasAnyPermission(userId, permissions) {
    const perms = await adminPermissionRepository.findPermissionsByUserId(userId);
    if (perms.includes(PERMISSIONS.SUPER_ADMIN)) {
      return true;
    }
    return permissions.some((p) => perms.includes(p));
  }

  /**
   * Checks if a user has ALL of the specified permissions.
   *
   * @param {string} userId
   * @param {string[]} permissions
   * @returns {Promise<boolean>}
   */
  async hasAllPermissions(userId, permissions) {
    const perms = await adminPermissionRepository.findPermissionsByUserId(userId);
    if (perms.includes(PERMISSIONS.SUPER_ADMIN)) {
      return true;
    }
    return permissions.every((p) => perms.includes(p));
  }

  /**
   * Grants a permission to a target admin user.
   *
   * Enforces:
   * - Actor must be authenticated and ADMIN
   * - Actor must have admin.permissions.manage or SUPER_ADMIN
   * - Target must exist and be ADMIN
   * - Self-escalation is prevented (cannot grant oneself a permission one doesn't already have)
   * - Permission must be in the canonical catalog
   * - Concurrent duplicate grants are handled safely via ON CONFLICT
   *
   * @param {object} params
   * @param {string} params.targetUserId Target admin user
   * @param {string} params.permission Permission to grant
   * @param {object} params.actor Authenticated actor
   * @param {string} [params.requestId]
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @returns {Promise<{ granted: boolean, permission: string, targetUserId: string }>}
   */
  async grantPermission({ targetUserId, permission, actor, requestId, ipAddress, userAgent }) {
    this._assertActorAuthenticated(actor);
    this._validatePermission(permission);

    // Resolve target from canonical users table
    const targetUser = await this._resolveAdminTarget(targetUserId);

    // Actor must have management permission
    await this._assertManagementPermission(actor);

    // Only a SUPER_ADMIN may confer SUPER_ADMIN; otherwise two permission managers
    // could escalate each other to unrestricted access.
    if (permission === PERMISSIONS.SUPER_ADMIN && !(actor.permissions || []).includes(PERMISSIONS.SUPER_ADMIN)) {
      this._auditSafe({
        actorId: actor.id,
        action: 'PERMISSION_ESCALATION_DENIED',
        targetResource: 'ADMIN_PERMISSION',
        targetResourceId: targetUser.id,
        requestId,
        ipAddress,
        userAgent,
        metadata: { permission, reason: 'super_admin_grant_requires_super_admin' },
      });
      throw new ForbiddenError('Only a SUPER_ADMIN can grant SUPER_ADMIN', ERROR_CODES.FORBIDDEN);
    }

    // Self-escalation prevention: actor cannot grant themselves a permission they don't have
    if (actor.id === targetUser.id) {
      const actorPerms = actor.permissions || [];
      if (!actorPerms.includes(PERMISSIONS.SUPER_ADMIN) && !actorPerms.includes(permission)) {
        logger.warn('Self-escalation attempt blocked', {
          actorId: actor.id,
          permission,
        });

        this._auditSafe({
          actorId: actor.id,
          action: 'PERMISSION_SELF_ESCALATION_DENIED',
          targetResource: 'ADMIN_PERMISSION',
          targetResourceId: targetUser.id,
          requestId,
          ipAddress,
          userAgent,
          metadata: { permission, reason: 'self_escalation' },
        });

        throw new ForbiddenError(
          'Self-escalation is forbidden: cannot grant yourself a permission you do not possess',
          ERROR_CODES.FORBIDDEN,
        );
      }
    }

    // Perform the grant (ON CONFLICT DO NOTHING for idempotency)
    const result = await adminPermissionRepository.assignPermission(
      targetUser.id,
      permission,
      actor.id,
    );

    const granted = result !== null;

    // Audit the permission grant
    this._auditSafe({
      actorId: actor.id,
      action: 'PERMISSION_GRANTED',
      targetResource: 'ADMIN_PERMISSION',
      targetResourceId: targetUser.id,
      requestId,
      ipAddress,
      userAgent,
      metadata: {
        permission,
        targetUserId: targetUser.id,
        granted,
        idempotent: !granted,
      },
    });

    return { granted, permission, targetUserId: targetUser.id };
  }

  /**
   * Revokes a permission from a target admin user.
   *
   * Enforces same authorization checks as grantPermission.
   * Prevents accidental self-lockout of admin.permissions.manage.
   *
   * @param {object} params
   * @param {string} params.targetUserId Target admin user
   * @param {string} params.permission Permission to revoke
   * @param {object} params.actor Authenticated actor
   * @param {string} [params.requestId]
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @returns {Promise<{ revoked: boolean, permission: string, targetUserId: string }>}
   */
  async revokePermission({ targetUserId, permission, actor, requestId, ipAddress, userAgent }) {
    this._assertActorAuthenticated(actor);
    this._validatePermission(permission);

    // Resolve target from canonical users table
    const targetUser = await this._resolveAdminTarget(targetUserId);

    // Actor must have management permission
    await this._assertManagementPermission(actor);

    // Self-lockout prevention: cannot revoke own admin.permissions.manage
    if (actor.id === targetUser.id && permission === PERMISSIONS.ADMIN_PERMISSIONS_MANAGE) {
      logger.warn('Self-lockout attempt blocked', {
        actorId: actor.id,
        permission,
      });

      this._auditSafe({
        actorId: actor.id,
        action: 'PERMISSION_SELF_LOCKOUT_DENIED',
        targetResource: 'ADMIN_PERMISSION',
        targetResourceId: targetUser.id,
        requestId,
        ipAddress,
        userAgent,
        metadata: { permission, reason: 'self_lockout_prevention' },
      });

      throw new ForbiddenError(
        'Cannot revoke your own permission management access',
        ERROR_CODES.FORBIDDEN,
      );
    }

    // Self-lockout prevention: cannot revoke own SUPER_ADMIN
    if (actor.id === targetUser.id && permission === PERMISSIONS.SUPER_ADMIN) {
      throw new ForbiddenError(
        'Cannot revoke your own SUPER_ADMIN permission',
        ERROR_CODES.FORBIDDEN,
      );
    }

    const revoked = await adminPermissionRepository.revokePermission(targetUser.id, permission);

    // Audit the permission revocation
    this._auditSafe({
      actorId: actor.id,
      action: 'PERMISSION_REVOKED',
      targetResource: 'ADMIN_PERMISSION',
      targetResourceId: targetUser.id,
      requestId,
      ipAddress,
      userAgent,
      metadata: {
        permission,
        targetUserId: targetUser.id,
        revoked,
        notFound: !revoked,
      },
    });

    return { revoked, permission, targetUserId: targetUser.id };
  }

  /**
   * Lists all available permissions in the canonical catalog.
   *
   * @returns {object[]} Array of { key, permission } entries
   */
  listAvailablePermissions() {
    return Object.entries(PERMISSIONS).map(([key, value]) => ({
      key,
      permission: value,
    }));
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Asserts that the actor is authenticated and active.
   * @private
   */
  _assertActorAuthenticated(actor) {
    if (!actor || !actor.id) {
      throw new ForbiddenError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
    }
    if (actor.is_active === false) {
      throw new ForbiddenError('User account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }
    if (actor.role !== ROLES.ADMIN) {
      throw new ForbiddenError('Access forbidden: administrative role required', ERROR_CODES.FORBIDDEN);
    }
  }

  /**
   * Resolves a target user from the canonical users table and asserts ADMIN role.
   * Prevents Customer/Partner IDs from being treated as admin targets.
   * @private
   */
  async _resolveAdminTarget(targetUserId) {
    if (!targetUserId || typeof targetUserId !== 'string') {
      throw new ValidationError('Target user ID is required');
    }

    const targetUser = await userRepository.findById(targetUserId);

    if (!targetUser) {
      throw new NotFoundError('Target admin user not found');
    }

    if (targetUser.role !== ROLES.ADMIN) {
      // Return 404 to prevent IDOR existence probing of non-admin users
      throw new NotFoundError('Target admin user not found');
    }

    if (!targetUser.is_active) {
      throw new ForbiddenError('Target admin user account is deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    return targetUser;
  }

  /**
   * Asserts that the actor has permission management authorization.
   * Requires either SUPER_ADMIN or admin.permissions.manage.
   * @private
   */
  async _assertManagementPermission(actor) {
    const actorPerms = actor.permissions || [];

    if (actorPerms.includes(PERMISSIONS.SUPER_ADMIN)) {
      return;
    }

    if (actorPerms.includes(PERMISSIONS.ADMIN_PERMISSIONS_MANAGE)) {
      return;
    }

    // Fallback: query the database for freshest state
    const hasManagePerm = await this.hasAnyPermission(actor.id, [
      PERMISSIONS.SUPER_ADMIN,
      PERMISSIONS.ADMIN_PERMISSIONS_MANAGE,
    ]);

    if (!hasManagePerm) {
      throw new ForbiddenError(
        'Access forbidden: admin.permissions.manage or SUPER_ADMIN required',
        ERROR_CODES.INSUFFICIENT_PERMISSIONS,
      );
    }
  }

  /**
   * Validates that a permission string exists in the canonical catalog.
   * @private
   */
  _validatePermission(permission) {
    if (!permission || typeof permission !== 'string') {
      throw new ValidationError('Permission is required and must be a string');
    }

    const trimmed = permission.trim();
    if (trimmed.length === 0 || trimmed.length > 50) {
      throw new ValidationError('Permission must be between 1 and 50 characters');
    }

    if (!VALID_PERMISSIONS.has(trimmed)) {
      throw new ValidationError(`Unknown permission: ${trimmed}`);
    }
  }

  /**
   * Safe audit helper that catches and logs audit failures without throwing.
   * @private
   */
  _auditSafe(event) {
    try {
      auditService.logAdminAction(event);
    } catch (auditErr) {
      logger.error('Failed to log permission audit event', { error: auditErr.message });
    }
  }
}

module.exports = new AdminPermissionService();
