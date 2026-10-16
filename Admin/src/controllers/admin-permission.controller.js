'use strict';

const adminPermissionService = require('../services/admin-permission.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');
const { ValidationError, UnauthorizedError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { validateResourceId } = require('../security/access-control');

class AdminPermissionController {
  /**
   * GET /api/v1/admin/permissions
   * Lists the canonical permission catalog.
   */
  async listAvailablePermissions(req, res, next) {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      const permissions = adminPermissionService.listAvailablePermissions();

      return sendSuccess(res, { permissions });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/permissions/:userId
   * Gets all permissions assigned to a specific admin user.
   */
  async getUserPermissions(req, res, next) {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      const targetUserId = validateResourceId(req.params.userId, 'userId', { requireUUID: true });

      const permissions = await adminPermissionService.getPermissions(targetUserId, req.user);

      return sendSuccess(res, { userId: targetUserId, permissions });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/permissions/grant
   * Grants a permission to a target admin user.
   *
   * Body: { targetUserId: UUID, permission: string }
   */
  async grantPermission(req, res, next) {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      // Reject client-supplied identity/role tampering
      this._rejectForbiddenFields(req.body);

      const { targetUserId, permission } = req.body || {};

      if (!targetUserId) {
        throw new ValidationError('targetUserId is required');
      }

      if (!permission) {
        throw new ValidationError('permission is required');
      }

      // Validate target user ID format
      validateResourceId(targetUserId, 'targetUserId', { requireUUID: true });

      const ipAddress = getClientIp(req);
      const userAgent = req.headers['user-agent'] || null;
      const requestId = req.id || (res.locals && res.locals.requestId) || null;

      const result = await adminPermissionService.grantPermission({
        targetUserId,
        permission,
        actor: req.user,
        requestId,
        ipAddress,
        userAgent,
      });

      return sendSuccess(res, result);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/permissions/revoke
   * Revokes a permission from a target admin user.
   *
   * Body: { targetUserId: UUID, permission: string }
   */
  async revokePermission(req, res, next) {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      // Reject client-supplied identity/role tampering
      this._rejectForbiddenFields(req.body);

      const { targetUserId, permission } = req.body || {};

      if (!targetUserId) {
        throw new ValidationError('targetUserId is required');
      }

      if (!permission) {
        throw new ValidationError('permission is required');
      }

      // Validate target user ID format
      validateResourceId(targetUserId, 'targetUserId', { requireUUID: true });

      const ipAddress = getClientIp(req);
      const userAgent = req.headers['user-agent'] || null;
      const requestId = req.id || (res.locals && res.locals.requestId) || null;

      const result = await adminPermissionService.revokePermission({
        targetUserId,
        permission,
        actor: req.user,
        requestId,
        ipAddress,
        userAgent,
      });

      return sendSuccess(res, result);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Rejects client-supplied identity/role/permission claim fields in request body.
   * Prevents mass assignment of security-sensitive attributes.
   * @private
   */
  _rejectForbiddenFields(body) {
    if (!body || typeof body !== 'object') {
      return;
    }

    const forbiddenFields = [
      'userId', 'role', 'adminId', 'user', 'permissions', 'auth_id',
      'is_admin', 'is_super_admin', '__proto__', 'constructor', 'prototype',
    ];

    const hasForbiddenField = forbiddenFields.some(
      (field) => Object.prototype.hasOwnProperty.call(body, field),
    );
    if (hasForbiddenField) {
      throw new ValidationError(
        'Client-supplied identity/role fields are strictly forbidden',
        null,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
  }
}

module.exports = new AdminPermissionController();
