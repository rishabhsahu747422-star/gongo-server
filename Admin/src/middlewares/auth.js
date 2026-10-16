'use strict';

const adminAuthService = require('../services/admin-auth.service');
const { UnauthorizedError, ForbiddenError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const logger = require('../config/logger');

const ALLOWED_ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'SUPPORT_EXECUTIVE']);
const MAX_TOKEN_LENGTH = 512;

/**
 * Validates that user status is active and role is an authorized administrator.
 *
 * @param {object} user
 */
function validateAdminAccount(user) {
  if (!user) {
    throw new UnauthorizedError('User account not found', ERROR_CODES.AUTH_REQUIRED);
  }

  if (user.deleted_at) {
    throw new ForbiddenError('User account has been deleted', ERROR_CODES.ACCOUNT_DEACTIVATED);
  }

  const isActive = user.is_active !== undefined
    ? Boolean(user.is_active)
    : (user.status === 'active');
  if (!isActive) {
    throw new ForbiddenError('User account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
  }

  const normalizedRole = String(user.role || '').toUpperCase();
  if (!ALLOWED_ADMIN_ROLES.has(normalizedRole)) {
    throw new ForbiddenError('Admin access required', ERROR_CODES.FORBIDDEN);
  }
}

/**
 * Extracts the admin session token from the Authorization: Bearer header
 * (or the x-admin-session / x-session-token header used by non-browser clients).
 *
 * @param {import('express').Request} req
 * @returns {{ token: string, isExplicitSessionHeader: boolean }}
 */
function extractToken(req) {
  const sessionHeader = req.headers['x-admin-session'] || req.headers['x-session-token'];
  if (sessionHeader && typeof sessionHeader === 'string' && sessionHeader.trim() !== '') {
    return { token: sessionHeader.trim(), isExplicitSessionHeader: true };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2) {
    throw new UnauthorizedError(
      'Malformed authorization header. Expected Bearer token format.',
      ERROR_CODES.INVALID_TOKEN,
    );
  }

  if (parts[0].toLowerCase() !== 'bearer') {
    throw new UnauthorizedError(
      'Invalid authentication scheme. Expected Bearer token.',
      ERROR_CODES.INVALID_TOKEN,
    );
  }

  const token = parts[1];
  if (!token || token.trim() === '') {
    throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new UnauthorizedError('Invalid session token', ERROR_CODES.INVALID_TOKEN);
  }

  return { token: token.trim(), isExplicitSessionHeader: false };
}

/**
 * Admin authentication middleware.
 *
 * The only accepted credential is a server-side admin session token issued by
 * POST /admin/auth/login or the Google sign-in ticket exchange. Sessions are stored
 * hashed in admin_sessions and can be revoked at any time. Third-party tokens
 * (Supabase JWTs, Google ID tokens) are never accepted directly, and identity/role
 * is always loaded from the database — never from headers, body, query, or token claims.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function authenticate(req, res, next) {
  try {
    const { token, isExplicitSessionHeader } = extractToken(req);

    logger.debug('Admin incoming auth check', {
      tokenLength: token.length,
      isSessionHeader: Boolean(isExplicitSessionHeader),
    });

    const { session, user } = await adminAuthService.validateSession(token);
    validateAdminAccount(user);

    req.auth = {
      uid: user.id,
      email: user.email,
      sessionId: session.id,
      provider: 'session',
    };
    req.user = user;
    req.session = session;
    req.rawSessionToken = token;

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  authenticate,
  // Kept for existing imports; identical to authenticate (sessions are the only credential).
  authenticateSession: authenticate,
  extractToken,
  validateAdminAccount,
};
