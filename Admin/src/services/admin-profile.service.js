'use strict';

const userRepository = require('../repositories/user.repository');
const adminSessionRepository = require('../repositories/admin-session.repository');
const adminPermissionRepository = require('../repositories/admin-permission.repository');
const auditService = require('./audit.service');
const { ROLES } = require('../constants/roles');
const {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const logger = require('../config/logger');

const FORBIDDEN_FIELDS = [
  'id',
  'auth_id',
  'role',
  'is_active',
  'permissions',
  'email_verified',
  'created_at',
  'updated_at',
  'password',
  'userId',
  'adminId',
  '__proto__',
  'constructor',
  'prototype',
];

const ALLOWED_PROFILE_FIELDS = ['name', 'phone', 'country_code'];

class AdminProfileService {
  /**
   * Retrieves the authenticated Admin's profile with safe projection.
   *
   * @param {string} userId Authenticated admin user ID
   * @param {string|null} [currentSessionTokenHash=null] SHA-256 hash of active session
   * @param {object|null} [existingUserRecord=null] Optional pre-resolved user record
   * @returns {Promise<object>}
   */
  async getProfile(userId, currentSessionTokenHash = null, existingUserRecord = null) {
    if (!userId || typeof userId !== 'string') {
      throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
    }

    const user = existingUserRecord || (await userRepository.findById(userId));
    if (!user) {
      throw new NotFoundError('Admin user not found', ERROR_CODES.NOT_FOUND);
    }

    if (!user.is_active) {
      throw new ForbiddenError('User account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    if (user.role !== ROLES.ADMIN) {
      throw new ForbiddenError('Administrative role required', ERROR_CODES.FORBIDDEN);
    }

    const permissions = await adminPermissionRepository.findPermissionsByUserId(user.id);
    const activeSessionsCount = await adminSessionRepository.countActiveSessionsByUserId(user.id);

    let currentSession = null;
    if (currentSessionTokenHash) {
      try {
        const sess = await adminSessionRepository.findByToken(currentSessionTokenHash);
        if (sess && sess.user_id === user.id && sess.is_active) {
          currentSession = {
            id: sess.id,
            created_at: sess.created_at,
            expires_at: sess.expires_at,
            last_active_at: sess.last_active_at,
            ip_address: sess.ip_address,
            user_agent: sess.user_agent,
          };
        }
      } catch (err) {
        logger.warn('Failed to resolve current session for profile', { error: err.message });
      }
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      country_code: user.country_code,
      phone: user.phone,
      role: user.role,
      is_active: user.is_active,
      created_at: user.created_at,
      updated_at: user.updated_at,
      permissions: permissions || [],
      security: {
        activeSessionsCount,
        currentSession,
      },
    };
  }

  /**
   * Updates permitted profile fields for the authenticated Admin.
   * Enforces strict mass-assignment protection and rejects sensitive attributes.
   *
   * @param {string} userId Must match actor.id
   * @param {object} payload Request body updates
   * @param {object} context Request metadata
   * @param {object} context.actor Authenticated user object
   * @param {string} [context.currentSessionTokenHash]
   * @param {string} [context.requestId]
   * @param {string} [context.ipAddress]
   * @param {string} [context.userAgent]
   * @returns {Promise<object>} Updated safe profile
   */
  async updateProfile(
    userId,
    payload,
    { actor, currentSessionTokenHash, requestId, ipAddress, userAgent } = {},
  ) {
    if (!actor || !actor.id) {
      throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
    }

    if (!actor.is_active) {
      throw new ForbiddenError('User account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    if (actor.role !== ROLES.ADMIN) {
      throw new ForbiddenError('Administrative role required', ERROR_CODES.FORBIDDEN);
    }

    // BOLA/IDOR protection: strictly self-modification only
    if (userId !== actor.id) {
      throw new ForbiddenError('Cannot modify another administrator\'s profile', ERROR_CODES.FORBIDDEN);
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    // Reject email mutation explicitly
    if (Object.prototype.hasOwnProperty.call(payload, 'email')) {
      throw new ValidationError(
        'Email cannot be updated via profile endpoint',
        null,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    // Reject client attempts to inject forbidden security-sensitive fields
    const hasForbidden = FORBIDDEN_FIELDS.some(
      (field) => Object.prototype.hasOwnProperty.call(payload, field),
    );
    if (hasForbidden) {
      throw new ValidationError(
        'Modification of security-sensitive field is forbidden',
        null,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    // Reject unknown / unexpected fields
    const payloadKeys = Object.keys(payload);
    const unexpected = payloadKeys.filter((k) => !ALLOWED_PROFILE_FIELDS.includes(k));
    if (unexpected.length > 0) {
      throw new ValidationError(
        `Unexpected fields in profile update: ${unexpected.join(', ')}`,
        null,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    // Must provide at least one allowed field
    const hasAllowed = ALLOWED_PROFILE_FIELDS.some(
      (k) => Object.prototype.hasOwnProperty.call(payload, k),
    );
    if (!hasAllowed) {
      throw new ValidationError('At least one editable profile field must be provided');
    }

    // Validate field formats and constraints
    const updates = {};

    if (Object.prototype.hasOwnProperty.call(payload, 'name')) {
      const { name } = payload;
      if (typeof name !== 'string') {
        throw new ValidationError('Name must be a string');
      }
      const trimmed = name.trim();
      if (trimmed.length < 2 || trimmed.length > 100) {
        throw new ValidationError('Name must be between 2 and 100 characters');
      }
      // Reject control characters and script injection
      if (/[\0\r\n\t]/.test(trimmed) || /<[a-z][\s\S]*>/i.test(trimmed)) {
        throw new ValidationError('Name contains invalid or dangerous characters');
      }
      updates.name = trimmed;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'phone')) {
      const { phone } = payload;
      if (phone === null || phone === '') {
        updates.phone = null;
      } else {
        if (typeof phone !== 'string') {
          throw new ValidationError('Phone must be a string or null');
        }
        const trimmedPhone = phone.trim();
        const digitsOnly = trimmedPhone.replace(/\D/g, '');
        if (digitsOnly.length < 7 || digitsOnly.length > 15) {
          throw new ValidationError('Phone number must contain between 7 and 15 digits');
        }
        if (!/^\+?[0-9\s\-()]{7,20}$/.test(trimmedPhone)) {
          throw new ValidationError('Phone number format is invalid');
        }
        updates.phone = trimmedPhone;
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'country_code')) {
      const { country_code: code } = payload;
      if (code === null || code === '') {
        updates.country_code = null;
      } else {
        if (typeof code !== 'string') {
          throw new ValidationError('Country code must be a string or null');
        }
        const trimmedCode = code.trim();
        if (!/^\+[0-9]{1,4}$/.test(trimmedCode)) {
          throw new ValidationError('Country code must follow international format (e.g. +91)');
        }
        updates.country_code = trimmedCode;
      }
    }

    // Resolve current user record for beforeState
    const existingUser = await userRepository.findById(userId);
    if (!existingUser) {
      throw new NotFoundError('Admin user not found', ERROR_CODES.NOT_FOUND);
    }
    if (!existingUser.is_active) {
      throw new ForbiddenError('User account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }
    if (existingUser.role !== ROLES.ADMIN) {
      throw new ForbiddenError('Administrative role required', ERROR_CODES.FORBIDDEN);
    }

    const beforeState = {};
    Object.keys(updates).forEach((k) => {
      beforeState[k] = existingUser[k];
    });

    // Update canonical users record
    const updatedUser = await userRepository.updateProfile(userId, updates);

    const afterState = {};
    Object.keys(updates).forEach((k) => {
      afterState[k] = updatedUser[k];
    });

    // Audit profile update
    this._auditSafe({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'PROFILE_UPDATED',
      targetResource: 'USER',
      targetResourceId: userId,
      beforeState,
      afterState,
      metadata: {
        updatedFields: Object.keys(updates),
      },
      requestId,
      ipAddress,
      userAgent,
    });

    // Return updated safe profile
    return this.getProfile(userId, currentSessionTokenHash, updatedUser);
  }

  /**
   * Retrieves active sessions for the authenticated Admin.
   * Safe projection: never leaks session tokens or hashes.
   *
   * @param {string} userId
   * @param {string|null} [currentSessionTokenHash=null]
   * @returns {Promise<object[]>}
   */
  async getActiveSessions(userId, currentSessionTokenHash = null) {
    if (!userId || typeof userId !== 'string') {
      throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
    }

    const sessions = await adminSessionRepository.findActiveSessionsByUserId(userId);

    return sessions.map((sess) => ({
      id: sess.id,
      ip_address: sess.ip_address,
      user_agent: sess.user_agent,
      created_at: sess.created_at,
      expires_at: sess.expires_at,
      last_active_at: sess.last_active_at,
      is_current: currentSessionTokenHash ? sess.session_token === currentSessionTokenHash : false,
    }));
  }

  /**
   * Revokes a specific session belonging to the authenticated Admin.
   * Strictly enforces session ownership to prevent cross-admin session termination.
   *
   * @param {string} userId Authenticated admin user ID
   * @param {string} sessionId Target session ID to revoke
   * @param {object} context
   * @returns {Promise<{ revoked: boolean, sessionId: string }>}
   */
  async revokeSession(
    userId,
    sessionId,
    { actor, currentSessionTokenHash, requestId, ipAddress, userAgent } = {},
  ) {
    if (!actor || !actor.id) {
      throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
    }

    if (userId !== actor.id) {
      throw new ForbiddenError('Cannot revoke another administrator\'s session', ERROR_CODES.FORBIDDEN);
    }

    if (!sessionId || typeof sessionId !== 'string') {
      throw new ValidationError('Session ID is required');
    }

    // Verify session exists and belongs to this user
    const session = await adminSessionRepository.findSessionByIdForUser(sessionId, userId);
    if (!session) {
      throw new NotFoundError('Session not found', ERROR_CODES.NOT_FOUND);
    }

    if (!session.is_active) {
      return { revoked: false, sessionId, message: 'Session is already revoked or expired' };
    }

    const revoked = await adminSessionRepository.revokeSessionByIdForUser(sessionId, userId);

    const isCurrentSession = currentSessionTokenHash
      ? session.session_token === currentSessionTokenHash
      : false;

    // Audit session revocation
    this._auditSafe({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'ADMIN_SESSION_REVOKED',
      targetResource: 'ADMIN_SESSION',
      targetResourceId: sessionId,
      metadata: {
        isCurrentSession,
      },
      requestId,
      ipAddress,
      userAgent,
    });

    return {
      revoked,
      sessionId,
      isCurrentSession,
    };
  }

  /**
   * Safe audit logging helper that catches and logs audit errors without throwing.
   * @private
   */
  _auditSafe(event) {
    try {
      auditService.logAdminAction(event);
    } catch (auditErr) {
      logger.error('Failed to log admin profile audit event', { error: auditErr.message });
    }
  }
}

module.exports = new AdminProfileService();
