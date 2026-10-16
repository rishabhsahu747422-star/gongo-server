'use strict';

const adminProfileService = require('../services/admin-profile.service');
const { hashSessionToken } = require('../utils/crypto');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');
const { UnauthorizedError, ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class AdminProfileController {
  /**
   * Helper to resolve the active session's SHA-256 token hash from request context.
   * @private
   */
  _resolveSessionTokenHash(req) {
    if (req.session && req.session.session_token) {
      return req.session.session_token;
    }
    if (req.rawSessionToken) {
      try {
        return hashSessionToken(req.rawSessionToken);
      } catch (_) {
        return null;
      }
    }
    const headerToken = req.headers['x-admin-session'] || req.headers['x-session-token'];
    if (headerToken && typeof headerToken === 'string') {
      try {
        return hashSessionToken(headerToken.trim());
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /**
   * GET /api/v1/admin/profile
   * Returns the authenticated Admin's profile and account security summary.
   */
  async getProfile(req, res, next) {
    try {
      if (!req.user || !req.user.id) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      const currentSessionTokenHash = this._resolveSessionTokenHash(req);
      const profile = await adminProfileService.getProfile(req.user.id, currentSessionTokenHash);

      return sendSuccess(res, profile);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/profile
   * Updates permitted profile fields (name, phone, country_code) for the authenticated Admin.
   */
  async updateProfile(req, res, next) {
    try {
      if (!req.user || !req.user.id) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      const ipAddress = getClientIp(req);
      const userAgent = req.headers['user-agent'] || null;
      const requestId = req.id || (res.locals && res.locals.requestId) || null;
      const currentSessionTokenHash = this._resolveSessionTokenHash(req);

      const profile = await adminProfileService.updateProfile(req.user.id, req.body, {
        actor: req.user,
        currentSessionTokenHash,
        requestId,
        ipAddress,
        userAgent,
      });

      return sendSuccess(res, profile);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/profile/sessions
   * Lists the authenticated Admin's active sessions with current session identification.
   */
  async getActiveSessions(req, res, next) {
    try {
      if (!req.user || !req.user.id) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      const currentSessionTokenHash = this._resolveSessionTokenHash(req);
      const sessions = await adminProfileService.getActiveSessions(
        req.user.id,
        currentSessionTokenHash,
      );

      return sendSuccess(res, { sessions });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * DELETE /api/v1/admin/profile/sessions/:sessionId
   * (or POST /api/v1/admin/profile/sessions/:sessionId/revoke)
   * Revokes a specific session belonging to the authenticated Admin.
   */
  async revokeSession(req, res, next) {
    try {
      if (!req.user || !req.user.id) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      const { sessionId } = req.params;
      if (!sessionId || typeof sessionId !== 'string') {
        throw new ValidationError('Session ID parameter is required');
      }

      const ipAddress = getClientIp(req);
      const userAgent = req.headers['user-agent'] || null;
      const requestId = req.id || (res.locals && res.locals.requestId) || null;
      const currentSessionTokenHash = this._resolveSessionTokenHash(req);

      const result = await adminProfileService.revokeSession(req.user.id, sessionId.trim(), {
        actor: req.user,
        currentSessionTokenHash,
        requestId,
        ipAddress,
        userAgent,
      });

      return sendSuccess(res, result);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminProfileController();
