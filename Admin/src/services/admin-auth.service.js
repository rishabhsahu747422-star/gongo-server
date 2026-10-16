'use strict';

const { verifyPasswordCredentials } = require('../providers/supabase');
const userRepository = require('../repositories/user.repository');
const adminSessionRepository = require('../repositories/admin-session.repository');
const adminPermissionRepository = require('../repositories/admin-permission.repository');
const adminCredentialRepository = require('../repositories/admin-credential.repository');
const auditService = require('./audit.service');
const { hashSessionToken, sha256 } = require('../utils/crypto');
const {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  needsRehash,
  validatePasswordPolicy,
  PASSWORD_MAX_LENGTH,
} = require('../utils/password');
const { normalizeLoginIdentifier } = require('../utils/login-identifier');
const { UnauthorizedError, ForbiddenError, ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { PERMISSIONS } = require('../constants/permissions');
const env = require('../config/env');
const logger = require('../config/logger');

/**
 * users.role is stored lowercase ('admin', 'super_admin', ...) per migration 048,
 * so compare case-insensitively. Same role set as validateAdminAccount.
 */
const ADMIN_LOGIN_ROLES = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT_EXECUTIVE'];
const isAdminRole = (role) => ADMIN_LOGIN_ROLES.includes(String(role || '').toUpperCase());

/**
 * An account is active only if every status signal agrees: status 'active' (when present),
 * is_active not false, and not soft-deleted.
 *
 * @param {object} user
 * @returns {boolean}
 */
function isAccountActive(user) {
  if (!user || user.deleted_at) return false;
  if (user.is_active === false) return false;
  if (user.status !== undefined && user.status !== null) {
    return String(user.status).toLowerCase() === 'active';
  }
  return user.is_active === true;
}

const invalidCredentials = () => new UnauthorizedError('Invalid credentials', ERROR_CODES.INVALID_CREDENTIALS);

/**
 * Correlation id for an identifier in security logs without recording the identifier itself.
 *
 * @param {string} value
 * @returns {string}
 */
const identifierFingerprint = (value) => sha256(`admin-login:${value}`).slice(0, 16);

function safeAudit(event) {
  try {
    auditService.logAdminAction(event);
  } catch (err) {
    logger.error('Failed to record admin auth audit event', { action: event.action, error: err.message });
  }
}

class AdminAuthService {
  /**
   * Resolves the effective permission list for an admin. The canonical super_admin role
   * (server-side DB value) always carries the SUPER_ADMIN permission.
   *
   * @param {object} user
   * @returns {Promise<string[]>}
   */
  async resolvePermissions(user) {
    let permissions = Array.isArray(user.permissions) ? [...user.permissions] : null;
    if (!permissions) {
      try {
        permissions = await adminPermissionRepository.findPermissionsByUserId(user.id);
      } catch (err) {
        logger.warn('Admin permission lookup failed; continuing with no permissions', { userId: user.id });
        permissions = [];
      }
    }
    if (String(user.role || '').toLowerCase() === 'super_admin' && !permissions.includes(PERMISSIONS.SUPER_ADMIN)) {
      permissions.push(PERMISSIONS.SUPER_ADMIN);
    }
    return permissions;
  }

  /**
   * Safe projection of an administrator for API responses. Never includes credentials.
   *
   * @param {object} user
   * @returns {object}
   */
  toSafeProfile(user) {
    let status = user.is_active ? 'active' : 'inactive';
    if (user.status) status = String(user.status).toLowerCase();
    return {
      id: user.id,
      name: user.name || null,
      email: user.email || null,
      phone: user.phone || null,
      role: String(user.role || '').toLowerCase(),
      status,
      permissions: user.permissions || [],
    };
  }

  /**
   * Issues a new server-side session for an already-authenticated administrator.
   * Shared by password and Google sign-in so both produce the same session type.
   *
   * @param {object} params
   * @param {object} params.user Verified, active admin user
   * @param {string} params.authMethod 'password_email' | 'password_mobile' | 'google'
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ rawToken: string, session: object, user: object }>}
   */
  async createAuthenticatedSession({
    user, authMethod, ipAddress = null, userAgent = null, requestId = null,
  }) {
    if (!user || !isAccountActive(user) || !isAdminRole(user.role)) {
      throw new ForbiddenError('Admin access required', ERROR_CODES.FORBIDDEN);
    }

    const maxActive = env.ADMIN_MAX_ACTIVE_SESSIONS;
    if (maxActive > 0) {
      const activeCount = await adminSessionRepository.countActiveSessionsByUserId(user.id);
      if (activeCount >= maxActive) {
        await adminSessionRepository.revokeOldestSessions(user.id, Math.max(0, maxActive - 1));
      }
    }

    const expiresAt = new Date(Date.now() + (env.ADMIN_SESSION_TTL_SECONDS || 86400) * 1000);
    const { session, rawToken } = await adminSessionRepository.createSecureSession({
      userId: user.id,
      expiresAt,
      ipAddress,
      userAgent,
    });

    const permissions = await this.resolvePermissions(user);
    const authenticatedUser = { ...user, permissions };

    safeAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'ADMIN_LOGIN',
      targetResource: 'ADMIN_SESSION',
      targetResourceId: session.id,
      requestId,
      ipAddress,
      userAgent,
      metadata: { loginMethod: authMethod, sessionId: session.id, expiresAt: session.expires_at },
    });

    return { rawToken, session, user: authenticatedUser };
  }

  /**
   * One-time migration path for admins whose password still lives in Supabase Auth.
   * Only succeeds when Supabase confirms the password for the exact auth account bound to
   * this admin row (users.auth_id); the verified password is then hashed locally.
   *
   * @param {object} account
   * @param {string} password
   * @returns {Promise<boolean>}
   */
  async _tryLegacySupabaseMigration(account, password) {
    if (!env.ADMIN_LEGACY_SUPABASE_PASSWORD_MIGRATION || !account.auth_id || !account.email) {
      return verifyAgainstDummy(password);
    }
    const { valid, userId } = await verifyPasswordCredentials({ email: account.email, password });
    if (!valid || userId !== account.auth_id) return false;

    const passwordHash = await hashPassword(password);
    await adminCredentialRepository.createIfAbsent({ userId: account.id, passwordHash });
    logger.info('Migrated admin password from Supabase Auth to local credential store', { userId: account.id });
    return true;
  }

  /**
   * Authenticates an administrator with email or mobile number + password.
   * Every failure before the password is proven returns the same generic error.
   *
   * @param {object} params
   * @param {string} params.identifier Registered email or mobile number
   * @param {string} params.password
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{
   *   rawToken: string, session: object, user: object, passwordChangeRequired: boolean
   * }>}
   */
  async loginWithPassword({
    identifier, password, ipAddress = null, userAgent = null, requestId = null,
  }) {
    if (typeof identifier !== 'string' || !identifier.trim()) {
      throw new ValidationError('identifier is required', [{ field: 'identifier', message: 'Email or mobile number required' }]);
    }
    if (typeof password !== 'string' || password.length === 0) {
      throw new ValidationError('password is required', [{ field: 'password', message: 'Password required' }]);
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      throw invalidCredentials();
    }

    const normalized = normalizeLoginIdentifier(identifier);
    if (!normalized) {
      throw new ValidationError('identifier must be a valid email address or 10-digit mobile number', [
        { field: 'identifier', message: 'Invalid email or mobile number format' },
      ]);
    }

    const fingerprint = identifierFingerprint(normalized.value);
    const failure = (reason, actorId = 'anonymous') => {
      safeAudit({
        actorId,
        actorRole: 'ANONYMOUS',
        action: 'ADMIN_LOGIN_FAILED',
        targetResource: 'ADMIN_SESSION',
        requestId,
        ipAddress,
        userAgent,
        metadata: { reason, identifierType: normalized.type, identifierFingerprint: fingerprint },
      });
    };

    const rows = normalized.type === 'email'
      ? await adminCredentialRepository.findAdminsByEmail(normalized.value)
      : await adminCredentialRepository.findAdminsByMobile(normalized.value);

    if (rows.length !== 1) {
      if (rows.length > 1) {
        logger.warn('Admin login identifier matches multiple admin accounts; refusing', { identifierFingerprint: fingerprint });
      }
      await verifyAgainstDummy(password);
      failure(rows.length > 1 ? 'ambiguous_identifier' : 'unknown_identifier');
      throw invalidCredentials();
    }

    const account = rows[0];

    if (account.locked_until && new Date(account.locked_until).getTime() > Date.now()) {
      await verifyAgainstDummy(password);
      failure('account_locked', account.id);
      throw invalidCredentials();
    }

    let passwordOk;
    if (!account.password_hash) {
      passwordOk = await this._tryLegacySupabaseMigration(account, password);
    } else {
      passwordOk = await verifyPassword(password, account.password_hash);
      if (!passwordOk) {
        const { locked } = await adminCredentialRepository.recordFailedAttempt(
          account.id,
          env.ADMIN_LOGIN_MAX_FAILED_ATTEMPTS,
          env.ADMIN_LOGIN_LOCKOUT_SECONDS,
        );
        if (locked) failure('account_locked_after_failures', account.id);
      } else if (needsRehash(account.password_hash)) {
        const passwordHash = await hashPassword(password);
        await adminCredentialRepository.updatePassword({
          userId: account.id,
          passwordHash,
          mustChangePassword: Boolean(account.must_change_password),
        });
      }
    }

    if (!passwordOk) {
      failure('invalid_password', account.id);
      throw invalidCredentials();
    }

    // Password proven: status/role results no longer leak account existence to a stranger.
    if (!isAccountActive(account)) {
      failure('account_inactive', account.id);
      throw new ForbiddenError('Administrator account is disabled', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }
    if (!isAdminRole(account.role)) {
      failure('not_admin', account.id);
      throw invalidCredentials();
    }

    // Mandatory SMS OTP Challenge: Do NOT issue an authenticated session or clear lockout yet.
    // Instead, dispatch an OTP to the verified phone on file and return an OTP challenge.
    const adminOtpService = require('./admin-otp.service');
    return adminOtpService.createChallenge({
      account,
      ipAddress,
      userAgent,
      requestId,
    });
  }

  /**
   * Re-verifies the signed-in administrator's password (step-up for sensitive actions such
   * as linking a Google account). Wrong passwords count toward the lockout.
   *
   * @param {string} userId
   * @param {string} password
   * @returns {Promise<boolean>}
   */
  async verifyAccountPassword(userId, password) {
    if (typeof password !== 'string' || !password || password.length > PASSWORD_MAX_LENGTH) return false;
    const credential = await adminCredentialRepository.findByUserId(userId);
    if (!credential || !credential.password_hash) {
      return verifyAgainstDummy(password);
    }
    if (credential.locked_until && new Date(credential.locked_until).getTime() > Date.now()) {
      return verifyAgainstDummy(password);
    }
    const ok = await verifyPassword(password, credential.password_hash);
    if (!ok) {
      await adminCredentialRepository.recordFailedAttempt(
        userId,
        env.ADMIN_LOGIN_MAX_FAILED_ATTEMPTS,
        env.ADMIN_LOGIN_LOCKOUT_SECONDS,
      );
    }
    return ok;
  }

  /**
   * Changes the signed-in administrator's password and revokes their other sessions.
   *
   * @param {object} params
   * @param {object} params.user Authenticated admin (req.user)
   * @param {string} params.sessionId Current session id (kept active)
   * @param {string} params.currentPassword
   * @param {string} params.newPassword
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ message: string, revokedSessions: number }>}
   */
  async changePassword({
    user,
    sessionId,
    currentPassword,
    newPassword,
    ipAddress = null,
    userAgent = null,
    requestId = null,
  }) {
    if (typeof currentPassword !== 'string' || !currentPassword) {
      throw new ValidationError('currentPassword is required');
    }
    const problems = validatePasswordPolicy(newPassword);
    if (problems.length > 0) {
      throw new ValidationError('New password does not meet the password policy', problems.map((message) => ({ field: 'newPassword', message })));
    }
    if (newPassword === currentPassword) {
      throw new ValidationError('New password must differ from the current password');
    }

    const ok = await this.verifyAccountPassword(user.id, currentPassword);
    if (!ok) {
      safeAudit({
        actorId: user.id,
        actorRole: user.role,
        action: 'ADMIN_PASSWORD_CHANGE_FAILED',
        targetResource: 'ADMIN_CREDENTIAL',
        targetResourceId: user.id,
        requestId,
        ipAddress,
        userAgent,
      });
      throw new ForbiddenError('Current password is incorrect', ERROR_CODES.INVALID_CREDENTIALS);
    }

    const passwordHash = await hashPassword(newPassword);
    await adminCredentialRepository.updatePassword({
      userId: user.id,
      passwordHash,
      mustChangePassword: false,
    });
    const revokedSessions = await adminSessionRepository.revokeOtherUserSessions(
      user.id,
      sessionId,
    );

    safeAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'ADMIN_PASSWORD_CHANGED',
      targetResource: 'ADMIN_CREDENTIAL',
      targetResourceId: user.id,
      requestId,
      ipAddress,
      userAgent,
      metadata: { revokedSessions },
    });

    return { message: 'Password changed successfully', revokedSessions };
  }

  /**
   * Validates an administrative session credential.
   *
   * @param {string} rawToken Plaintext session token presented by client
   * @returns {Promise<{ session: object, user: object }>}
   */
  async validateSession(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new UnauthorizedError('Session token is required', ERROR_CODES.AUTH_REQUIRED);
    }

    const tokenHash = hashSessionToken(rawToken);
    let session = null;
    let user = null;
    let permissions = null;

    try {
      if (typeof adminSessionRepository.findSessionWithUser === 'function') {
        const combined = await adminSessionRepository.findSessionWithUser(tokenHash);
        if (combined) {
          session = combined.session;
          user = combined.user;
          permissions = combined.permissions;
        }
      } else {
        session = await adminSessionRepository.findByToken(tokenHash);
      }
    } catch (err) {
      logger.error('Admin session lookup failed', { error: err.message });
      session = null;
    }

    if (!session) {
      throw new UnauthorizedError('Invalid session token', ERROR_CODES.INVALID_TOKEN);
    }

    if (!session.is_active) {
      throw new UnauthorizedError('Session has been revoked', ERROR_CODES.TOKEN_REVOKED);
    }

    const now = Date.now();
    if (new Date(session.expires_at).getTime() <= now) {
      throw new UnauthorizedError('Session has expired', ERROR_CODES.TOKEN_EXPIRED);
    }

    if (!user) {
      user = await userRepository.findById(session.user_id);
    }

    if (!user) {
      throw new UnauthorizedError('User account not found', ERROR_CODES.AUTH_REQUIRED);
    }

    if (!user.is_active) {
      throw new ForbiddenError('User account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    if (!isAdminRole(user.role)) {
      throw new ForbiddenError('Access forbidden: administrative role required', ERROR_CODES.FORBIDDEN);
    }

    // Throttled last_active_at update (does not alter expires_at fixed window)
    const throttleMs = (env.ADMIN_SESSION_ACTIVITY_THROTTLE_SECONDS || 60) * 1000;
    const lastActiveTime = new Date(session.last_active_at).getTime();

    if (now - lastActiveTime > throttleMs) {
      adminSessionRepository.touchSession(tokenHash).catch((err) => {
        logger.warn('Failed to update session activity', { error: err.message });
      });
    }

    if (permissions && Array.isArray(permissions)) {
      user.permissions = permissions;
      if (String(user.role || '').toLowerCase() === 'super_admin' && !user.permissions.includes(PERMISSIONS.SUPER_ADMIN)) {
        user.permissions.push(PERMISSIONS.SUPER_ADMIN);
      }
    } else {
      user.permissions = await this.resolvePermissions(user);
    }

    return { session, user };
  }

  /**
   * Logs out the current administrative session.
   *
   * @param {object} params
   * @param {string} [params.tokenHash]
   * @param {string} [params.rawToken]
   * @param {string} params.userId
   * @param {string} [params.actorRole]
   * @param {string} [params.sessionId]
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ message: string }>}
   */
  async logout({
    tokenHash = null,
    rawToken = null,
    userId,
    actorRole = 'admin',
    sessionId = null,
    ipAddress = null,
    userAgent = null,
    requestId = null,
  }) {
    const targetHash = tokenHash || (rawToken ? hashSessionToken(rawToken) : null);
    if (!targetHash) {
      throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
    }

    await adminSessionRepository.revokeSession(targetHash);

    safeAudit({
      actorId: userId,
      actorRole,
      action: 'ADMIN_LOGOUT',
      targetResource: 'ADMIN_SESSION',
      targetResourceId: sessionId,
      requestId,
      ipAddress,
      userAgent,
    });

    return { message: 'Successfully logged out' };
  }

  /**
   * Revokes all active sessions for the authenticated administrator (Logout-all).
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} [params.actorRole]
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ message: string, revokedCount: number }>}
   */
  async logoutAll({ userId, actorRole = 'admin', ipAddress = null, userAgent = null, requestId = null }) {
    if (!userId) {
      throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
    }

    const revokedCount = await adminSessionRepository.revokeAllUserSessions(userId);

    safeAudit({
      actorId: userId,
      actorRole,
      action: 'ADMIN_LOGOUT_ALL',
      targetResource: 'ADMIN_SESSION',
      targetResourceId: null,
      requestId,
      ipAddress,
      userAgent,
      metadata: { revokedCount },
    });

    return {
      message: 'Successfully logged out of all active sessions',
      revokedCount,
    };
  }

  /**
   * Rotates an active session: revokes current session and issues a fresh session credential.
   *
   * @param {object} params
   * @param {string} params.rawToken Existing valid session token
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ rawToken: string, session: object, user: object }>}
   */
  async refreshSession({ rawToken, ipAddress = null, userAgent = null, requestId = null }) {
    const { session: oldSession, user } = await this.validateSession(rawToken);

    // Revoke old session token atomically; if already revoked by a concurrent request, abort
    const revoked = await adminSessionRepository.revokeSession(oldSession.session_token);
    if (!revoked) {
      throw new UnauthorizedError(
        'Session has already been revoked or rotated',
        ERROR_CODES.TOKEN_REVOKED,
      );
    }

    const expiresAt = new Date(Date.now() + (env.ADMIN_SESSION_TTL_SECONDS || 86400) * 1000);
    const created = await adminSessionRepository.createSecureSession({
      userId: user.id,
      expiresAt,
      ipAddress,
      userAgent,
    });
    const { session: newSession, rawToken: newRawToken } = created;

    safeAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'ADMIN_SESSION_REFRESH',
      targetResource: 'ADMIN_SESSION',
      targetResourceId: newSession.id,
      requestId,
      ipAddress,
      userAgent,
      metadata: {
        previousSessionId: oldSession.id,
        newSessionId: newSession.id,
      },
    });

    return { rawToken: newRawToken, session: newSession, user };
  }

  /**
   * Cleanup contract for expired sessions.
   *
   * @param {number} [retentionDays=30]
   * @returns {Promise<number>}
   */
  async cleanupExpiredSessions(retentionDays = 30) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    return adminSessionRepository.cleanupExpiredSessions(cutoff);
  }
}

const instance = new AdminAuthService();
instance.isAccountActive = isAccountActive;
instance.isAdminRole = isAdminRole;

module.exports = instance;
