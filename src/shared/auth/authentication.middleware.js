'use strict';

const { UnauthorizedError } = require('../errors/AppError');
const { ERROR_CODES } = require('../constants/error-codes.enum');
const { normalizeRole, ROLES } = require('./roles.enum');

/**
 * Extracts authentication token from headers.
 * Supports:
 * - Authorization: Bearer <token>
 * - x-admin-session: <session_token>
 * - x-session-token: <session_token>
 *
 * @param {import('express').Request} req
 * @returns {{ token: string, type: 'bearer'|'session' }}
 */
function extractToken(req) {
  const sessionHeader = req.headers['x-admin-session'] || req.headers['x-session-token'];
  if (sessionHeader && typeof sessionHeader === 'string' && sessionHeader.trim() !== '') {
    return { token: sessionHeader.trim(), type: 'session' };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    throw new UnauthorizedError('Authentication token is required', ERROR_CODES.AUTH_REQUIRED);
  }

  const trimmed = authHeader.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    throw new UnauthorizedError('Malformed authorization header. Expected format: Bearer <token>', ERROR_CODES.INVALID_TOKEN);
  }

  const token = parts[1];
  if (!token || token.trim() === '') {
    throw new UnauthorizedError('Authentication token cannot be empty', ERROR_CODES.INVALID_TOKEN);
  }

  return { token: token.trim(), type: 'bearer' };
}

/**
 * Normalizes an authenticated user context into canonical structure.
 *
 * @param {object} rawUser
 * @param {string} [fallbackRole=ROLES.CUSTOMER]
 * @returns {object} Normalized trusted req.user
 */
function normalizeUserContext(rawUser, fallbackRole = ROLES.CUSTOMER) {
  if (!rawUser) return null;
  const canonicalRole = normalizeRole(rawUser.role) || fallbackRole;

  return {
    id: rawUser.id || rawUser.userId,
    userId: rawUser.userId || rawUser.id,
    partnerId: rawUser.partnerId || (canonicalRole === ROLES.PARTNER ? rawUser.id : null),
    role: canonicalRole,
    authId: rawUser.authId || rawUser.auth_id || null,
    phone: rawUser.phone || null,
    email: rawUser.email || null,
    name: rawUser.name || null,
    isActive: rawUser.isActive !== undefined ? rawUser.isActive : (rawUser.is_active !== false),
    permissions: Array.isArray(rawUser.permissions) ? rawUser.permissions : [],
  };
}

module.exports = {
  extractToken,
  normalizeUserContext,
};
