'use strict';

const adminAuthService = require('../services/admin-auth.service');
const adminGoogleAuthService = require('../services/admin-google-auth.service');
const googleOAuth = require('../providers/google-oauth');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');
const { extractToken } = require('../middlewares/auth');
const { ValidationError, UnauthorizedError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const env = require('../config/env');

// __Host- prefix (Secure, Path=/, no Domain) pins the cookie to the API host in production.
const OAUTH_BINDING_COOKIE = env.isProduction ? '__Host-gongo_admin_oauth' : 'gongo_admin_oauth';
const FORBIDDEN_LOGIN_FIELDS = ['userId', 'role', 'adminId', 'user', 'permissions', 'auth_id', 'is_admin'];

function requestContext(req, res) {
  return {
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'] || null,
    requestId: req.id || res.locals?.requestId || null,
  };
}

function oauthCookieOptions() {
  const secure = env.isProduction || googleOAuth.getConfig().callbackUrl.startsWith('https://');
  return { httpOnly: true, secure, sameSite: 'lax', path: '/' };
}

/**
 * Minimal cookie reader (the app has no cookie-parser; this is the only cookie it uses).
 *
 * @param {import('express').Request} req
 * @param {string} name
 * @returns {string|null}
 */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header || typeof header !== 'string') return null;
  const match = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch (_) {
    return null;
  }
}

function sessionResponse(adminSession) {
  const { rawToken, session, user } = adminSession;
  return {
    step: 'AUTHENTICATED',
    tokenType: 'Bearer',
    token: rawToken,
    sessionToken: rawToken,
    expiresAt: session.expires_at,
    passwordChangeRequired: Boolean(adminSession.passwordChangeRequired),
    user: adminAuthService.toSafeProfile(user),
  };
}

function rejectForbiddenFields(body) {
  if (body && typeof body === 'object' && FORBIDDEN_LOGIN_FIELDS.some((field) => field in body)) {
    throw new ValidationError(
      'Client-supplied identity fields are strictly forbidden during login',
      null,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
}

const adminOtpService = require('../services/admin-otp.service');

function authResponse(result) {
  if (result.step === 'OTP_PENDING') {
    return result;
  }
  return sessionResponse(result);
}

class AdminAuthController {
  /**
   * POST /api/v1/admin/auth/login
   * Email or mobile number + password. Returns OTP challenge.
   */
  async login(req, res, next) {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      rejectForbiddenFields(body);

      const result = await adminAuthService.loginWithPassword({
        identifier: body.identifier,
        password: body.password,
        ...requestContext(req, res),
      });
      res.set('Cache-Control', 'no-store');
      return sendSuccess(res, authResponse(result));
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/auth/verify-2fa
   * Verifies 6-digit OTP challenge and issues administrative session.
   */
  async verify2FA(req, res, next) {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      rejectForbiddenFields(body);

      const challengeId = body.challengeId || body.tempToken || body.sessionId;
      const result = await adminOtpService.verifyOtp({
        challengeId,
        otp: body.otp,
        ...requestContext(req, res),
      });
      res.set('Cache-Control', 'no-store');
      return sendSuccess(res, sessionResponse(result));
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/auth/resend-2fa
   * Dispatches a fresh OTP passcode adhering to resend cooldown.
   */
  async resend2FA(req, res, next) {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      rejectForbiddenFields(body);

      const challengeId = body.challengeId || body.tempToken || body.sessionId;
      const result = await adminOtpService.resendOtp({
        challengeId,
        ...requestContext(req, res),
      });
      res.set('Cache-Control', 'no-store');
      return sendSuccess(res, result);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/auth/google/status
   * Lets the portal decide whether to show the Google button. Reveals no configuration.
   */
  async googleStatus(req, res, next) {
    try {
      return sendSuccess(res, { enabled: adminGoogleAuthService.isConfigured() });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/auth/google
   * Starts Google sign-in (Authorization Code + PKCE). Browser navigates here directly.
   */
  async googleStart(req, res, next) {
    try {
      const {
        authorizationUrl, browserBinding, ttlSeconds,
      } = await adminGoogleAuthService.startLogin();
      res.cookie(OAUTH_BINDING_COOKIE, browserBinding, {
        ...oauthCookieOptions(),
        maxAge: ttlSeconds * 1000,
      });
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, authorizationUrl);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/auth/google/callback
   * Google redirects here. Always answers with a redirect to the Admin Portal carrying
   * either #ticket=<one-time ticket>, #linked=google, or #error=<code>.
   */
  async googleCallback(req, res, next) {
    try {
      const browserBinding = readCookie(req, OAUTH_BINDING_COOKIE);
      res.clearCookie(OAUTH_BINDING_COOKIE, oauthCookieOptions());

      const { redirectUrl } = await adminGoogleAuthService.handleCallback({
        query: req.query || {},
        browserBinding,
        ...requestContext(req, res),
      });
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      return res.redirect(302, redirectUrl);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/auth/google/exchange
   * Exchanges the one-time ticket from the callback redirect for an admin session.
   */
  async googleExchange(req, res, next) {
    try {
      rejectForbiddenFields(req.body);
      const result = await adminGoogleAuthService.exchangeTicket({
        ticket: req.body?.ticket,
        ...requestContext(req, res),
      });
      res.set('Cache-Control', 'no-store');
      return sendSuccess(res, authResponse(result));
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/auth/google/link
   * Authenticated + password step-up. Returns the Google URL the browser should open
   * to link a Google account to the signed-in administrator.
   */
  async googleLinkStart(req, res, next) {
    try {
      const result = await adminGoogleAuthService.startLink({
        user: req.user,
        session: req.session,
        password: req.body?.password,
        ...requestContext(req, res),
      });
      res.set('Cache-Control', 'no-store');
      return sendSuccess(res, result);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/auth/me
   * Profile and session details for the current authenticated administrator.
   */
  async me(req, res, next) {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      return sendSuccess(res, {
        user: adminAuthService.toSafeProfile(req.user),
        session: req.session
          ? {
            id: req.session.id,
            expiresAt: req.session.expires_at,
            lastActiveAt: req.session.last_active_at,
            createdAt: req.session.created_at,
            ipAddress: req.session.ip_address,
            userAgent: req.session.user_agent,
          }
          : null,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/auth/password/change
   * Changes the current administrator's password; other sessions are revoked.
   */
  async changePassword(req, res, next) {
    try {
      const result = await adminAuthService.changePassword({
        user: req.user,
        sessionId: req.session ? req.session.id : null,
        currentPassword: req.body?.currentPassword,
        newPassword: req.body?.newPassword,
        ...requestContext(req, res),
      });
      return sendSuccess(res, result);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/auth/logout
   * Revokes the current administrator session.
   */
  async logout(req, res, next) {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      // BOLA guard: if client tampered with body userId, reject or enforce req.user.id
      if (req.body && req.body.userId && req.body.userId !== req.user.id) {
        throw new ValidationError('Cross-user session revocation is strictly forbidden');
      }

      const result = await adminAuthService.logout({
        tokenHash: req.session ? req.session.session_token : null,
        rawToken: req.rawSessionToken || null,
        userId: req.user.id,
        actorRole: req.user.role,
        sessionId: req.session ? req.session.id : null,
        ...requestContext(req, res),
      });

      return sendSuccess(res, result);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/auth/logout-all
   * Revokes all active sessions for the current administrator.
   */
  async logoutAll(req, res, next) {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      // BOLA guard: strictly scoped to req.user.id derived from server-side authenticated context
      if (req.body && req.body.userId && req.body.userId !== req.user.id) {
        throw new ValidationError('Cross-user session revocation is strictly forbidden');
      }

      const result = await adminAuthService.logoutAll({
        userId: req.user.id,
        actorRole: req.user.role,
        ...requestContext(req, res),
      });

      return sendSuccess(res, result);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/auth/refresh
   * Rotates session token: revokes old session and creates a fresh session credential.
   */
  async refresh(req, res, next) {
    try {
      const { token } = extractToken(req);
      const result = await adminAuthService.refreshSession({
        rawToken: token,
        ...requestContext(req, res),
      });
      res.set('Cache-Control', 'no-store');
      return sendSuccess(res, sessionResponse(result));
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminAuthController();
module.exports.OAUTH_BINDING_COOKIE = OAUTH_BINDING_COOKIE;
