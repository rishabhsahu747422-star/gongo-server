'use strict';

const crypto = require('crypto');
const googleOAuth = require('../providers/google-oauth');
const redisProvider = require('../providers/redis');
const userRepository = require('../repositories/user.repository');
const adminSessionRepository = require('../repositories/admin-session.repository');
const adminOAuthIdentityRepository = require('../repositories/admin-oauth-identity.repository');
const adminCredentialRepository = require('../repositories/admin-credential.repository');
const adminAuthService = require('./admin-auth.service');
const auditService = require('./audit.service');
const { sha256 } = require('../utils/crypto');
const {
  UnauthorizedError, ForbiddenError, ConflictError, ServiceUnavailableError, ValidationError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const env = require('../config/env');
const logger = require('../config/logger');

const PROVIDER = 'google';
const STATE_PREFIX = 'admin:oauth:google:state:';
const TICKET_PREFIX = 'admin:oauth:google:ticket:';
const TICKET_TTL_SECONDS = 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const randomToken = () => googleOAuth.base64url(crypto.randomBytes(32));

function safeAudit(event) {
  try {
    auditService.logAdminAction(event);
  } catch (err) {
    logger.error('Failed to record Google auth audit event', { action: event.action, error: err.message });
  }
}

function hashesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function storeOnce(key, value, ttlSeconds) {
  try {
    await redisProvider.redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.error('Failed to persist Google OAuth state', { error: err.message });
    throw new ServiceUnavailableError('Google sign-in is temporarily unavailable');
  }
}

/**
 * Reads and deletes a single-use record. Only the caller whose DEL removed the key gets
 * the value, so concurrent replays of the same state/ticket cannot both succeed.
 */
async function takeOnce(key) {
  const redis = redisProvider.redisClient;
  const raw = await redis.get(key);
  if (!raw) return null;
  const removed = await redis.del(key);
  if (removed !== 1) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Builds the Admin Portal redirect. Values go in the URL fragment so the one-time ticket
 * is never sent to any server in a Referer header or access log.
 */
function portalRedirect(params) {
  const base = googleOAuth.getConfig().portalRedirectUrl.split('#')[0];
  return `${base}#${new URLSearchParams(params).toString()}`;
}

function assertConfigured() {
  if (!googleOAuth.isConfigured()) {
    throw new ServiceUnavailableError('Google sign-in is not configured', ERROR_CODES.OAUTH_NOT_CONFIGURED);
  }
}

class AdminGoogleAuthService {
  isConfigured() {
    return googleOAuth.isConfigured();
  }

  /**
   * Starts Google sign-in. Returns the Google URL and a browser-binding secret that the
   * controller sets as an HttpOnly cookie; the callback must present it (login CSRF guard).
   *
   * @returns {Promise<{ authorizationUrl: string, browserBinding: string, ttlSeconds: number }>}
   */
  async startLogin() {
    assertConfigured();
    const state = randomToken();
    const nonce = randomToken();
    const browserBinding = randomToken();
    const pkce = googleOAuth.createPkcePair();
    const ttlSeconds = env.GOOGLE_OAUTH_STATE_TTL_SECONDS;

    await storeOnce(`${STATE_PREFIX}${sha256(state)}`, {
      mode: 'login',
      codeVerifier: pkce.verifier,
      nonce,
      bindingHash: sha256(browserBinding),
    }, ttlSeconds);

    return {
      authorizationUrl: googleOAuth.buildAuthorizationUrl({
        state, nonce, codeChallenge: pkce.challenge,
      }),
      browserBinding,
      ttlSeconds,
    };
  }

  /**
   * Starts linking a Google account to the signed-in administrator. Requires the admin's
   * current password (step-up), so a stolen session alone cannot attach an attacker's
   * Google account as a persistent backdoor.
   *
   * @param {object} params
   * @param {object} params.user Authenticated admin
   * @param {object} params.session Current session
   * @param {string} params.password Current password
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ authorizationUrl: string, expiresIn: number }>}
   */
  async startLink({
    user, session, password, ipAddress = null, userAgent = null, requestId = null,
  }) {
    assertConfigured();
    if (!session || !session.id) {
      throw new UnauthorizedError('An admin session is required to link a Google account', ERROR_CODES.AUTH_REQUIRED);
    }
    if (typeof password !== 'string' || !password) {
      throw new ValidationError('password is required to link a Google account', [
        { field: 'password', message: 'Current password required' },
      ]);
    }

    const existing = await adminOAuthIdentityRepository.findByUserAndProvider(user.id, PROVIDER);
    if (existing) {
      throw new ConflictError('A Google account is already linked to this administrator');
    }

    const ok = await adminAuthService.verifyAccountPassword(user.id, password);
    if (!ok) {
      safeAudit({
        actorId: user.id,
        actorRole: user.role,
        action: 'ADMIN_GOOGLE_LINK_REJECTED',
        targetResource: 'ADMIN_OAUTH_IDENTITY',
        requestId,
        ipAddress,
        userAgent,
        metadata: { reason: 'password_reverification_failed' },
      });
      throw new ForbiddenError('Current password is incorrect', ERROR_CODES.INVALID_CREDENTIALS);
    }

    const state = randomToken();
    const nonce = randomToken();
    const pkce = googleOAuth.createPkcePair();
    const ttlSeconds = env.GOOGLE_OAUTH_STATE_TTL_SECONDS;

    await storeOnce(`${STATE_PREFIX}${sha256(state)}`, {
      mode: 'link',
      codeVerifier: pkce.verifier,
      nonce,
      userId: user.id,
      sessionId: session.id,
    }, ttlSeconds);

    return {
      authorizationUrl: googleOAuth.buildAuthorizationUrl({
        state, nonce, codeChallenge: pkce.challenge,
      }),
      expiresIn: ttlSeconds,
    };
  }

  /**
   * Handles Google's redirect back to the backend. Never throws for OAuth failures:
   * returns a portal redirect carrying either a one-time ticket or a generic error code.
   *
   * @param {object} params
   * @param {object} params.query req.query
   * @param {string|null} params.browserBinding Cookie value set by startLogin
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ redirectUrl: string }>}
   */
  async handleCallback({
    query = {}, browserBinding = null, ipAddress = null, userAgent = null, requestId = null,
  }) {
    assertConfigured();
    const reject = (error, reason, actorId = 'anonymous') => {
      safeAudit({
        actorId,
        actorRole: actorId === 'anonymous' ? 'ANONYMOUS' : 'ADMIN',
        action: 'ADMIN_GOOGLE_LOGIN_REJECTED',
        targetResource: 'ADMIN_SESSION',
        requestId,
        ipAddress,
        userAgent,
        metadata: { reason },
      });
      return { redirectUrl: portalRedirect({ error }) };
    };

    const { state, code } = query;
    if (typeof state !== 'string' || !TOKEN_PATTERN.test(state)) {
      return reject('invalid_state', 'state_missing_or_malformed');
    }

    let record;
    try {
      record = await takeOnce(`${STATE_PREFIX}${sha256(state)}`);
    } catch (err) {
      logger.error('Google OAuth state lookup failed', { error: err.message });
      return reject('temporarily_unavailable', 'state_store_unavailable');
    }
    if (!record) return reject('invalid_state', 'state_unknown_expired_or_replayed');

    if (record.mode === 'login') {
      if (!browserBinding || !hashesMatch(sha256(browserBinding), record.bindingHash)) {
        return reject('invalid_state', 'browser_binding_mismatch');
      }
    }

    if (typeof query.error === 'string') {
      return reject('access_denied', 'provider_returned_error');
    }
    if (typeof code !== 'string' || !code || code.length > 2048) {
      return reject('invalid_request', 'code_missing');
    }

    let identity;
    try {
      const { idToken } = await googleOAuth.exchangeCode({
        code,
        codeVerifier: record.codeVerifier,
      });
      identity = await googleOAuth.verifyIdToken(idToken, { nonce: record.nonce });
    } catch (err) {
      const reason = err instanceof googleOAuth.GoogleOAuthError ? err.reason : 'unexpected_error';
      logger.warn('Google OAuth verification failed', { reason });
      return reject(reason === 'email_not_verified' ? 'email_not_verified' : 'google_verification_failed', reason);
    }

    if (record.mode === 'link') {
      return this._completeLink({ record, identity, ipAddress, userAgent, requestId, reject });
    }
    return this._completeLogin({ identity, reject, ipAddress, userAgent, requestId });
  }

  async _completeLogin({ identity, reject, ipAddress = null, userAgent = null, requestId = null }) {
    let link = await adminOAuthIdentityRepository.findByProviderSubject(PROVIDER, identity.sub);
    let user = null;

    if (link) {
      user = await userRepository.findById(link.user_id);
      if (!user || !adminAuthService.isAdminRole(user.role)) {
        return reject('account_not_authorized', 'linked_user_not_admin', link.user_id);
      }
      if (!adminAuthService.isAccountActive(user)) {
        return reject('account_disabled', 'linked_user_inactive', link.user_id);
      }
    } else {
      // Identity is not yet linked: match against pre-existing authorized Admin account by verified email
      if (!identity.email || !identity.emailVerified) {
        return reject('email_not_verified', 'email_not_verified_by_google');
      }

      const normalizedEmail = (identity.email || '').trim().toLowerCase();
      const rows = await adminCredentialRepository.findAdminsByEmail(normalizedEmail);

      if (rows.length !== 1) {
        return reject(
          'account_not_authorized',
          rows.length > 1 ? 'ambiguous_admin_email' : 'no_admin_account_for_email'
        );
      }

      user = rows[0];

      if (!adminAuthService.isAccountActive(user)) {
        return reject('account_disabled', 'admin_inactive', user.id);
      }
      if (!adminAuthService.isAdminRole(user.role)) {
        return reject('account_not_authorized', 'not_admin_role', user.id);
      }

      // Ensure this admin account is not already linked to a different Google identity
      const existingForUser = await adminOAuthIdentityRepository.findByUserAndProvider(user.id, PROVIDER);
      if (existingForUser && existingForUser.provider_subject !== identity.sub) {
        return reject('account_not_authorized', 'admin_linked_to_different_google_account', user.id);
      }

      // Link the verified Google subject to this admin account
      link = await adminOAuthIdentityRepository.link({
        userId: user.id,
        provider: PROVIDER,
        subject: identity.sub,
        email: normalizedEmail,
      });
      if (!link) {
        link = await adminOAuthIdentityRepository.findByProviderSubject(PROVIDER, identity.sub);
      }
    }

    const ticket = randomToken();
    await storeOnce(`${TICKET_PREFIX}${sha256(ticket)}`, {
      userId: user.id,
      identityId: link ? link.id : null,
      email: identity.email,
    }, TICKET_TTL_SECONDS);

    return { redirectUrl: portalRedirect({ ticket }) };
  }

  async _completeLink({ record, identity, ipAddress, userAgent, requestId, reject }) {
    const session = await adminSessionRepository.findSessionByIdForUser(
      record.sessionId,
      record.userId,
    );
    const sessionLive = Boolean(session && session.is_active)
      && new Date(session.expires_at).getTime() > Date.now();
    if (!sessionLive) return reject('session_expired', 'link_session_no_longer_active', record.userId);

    const user = await userRepository.findById(record.userId);
    const eligible = user && adminAuthService.isAdminRole(user.role)
      && adminAuthService.isAccountActive(user);
    if (!eligible) {
      return reject('account_not_authorized', 'link_user_not_active_admin', record.userId);
    }

    const existing = await adminOAuthIdentityRepository.findByProviderSubject(
      PROVIDER,
      identity.sub,
    );
    if (existing && existing.user_id !== user.id) {
      return reject('identity_already_linked', 'identity_linked_to_other_admin', user.id);
    }
    if (!existing) {
      const linked = await adminOAuthIdentityRepository.link({
        userId: user.id,
        provider: PROVIDER,
        subject: identity.sub,
        email: identity.email,
      });
      if (!linked) return reject('identity_already_linked', 'link_conflict', user.id);
    }

    safeAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'ADMIN_GOOGLE_LINKED',
      targetResource: 'ADMIN_OAUTH_IDENTITY',
      targetResourceId: user.id,
      requestId,
      ipAddress,
      userAgent,
      metadata: { provider: PROVIDER },
    });

    return { redirectUrl: portalRedirect({ linked: PROVIDER }) };
  }

  setRequireOtpOverride(val) {
    this._requireOtpOverride = val;
  }

  isOtpRequired() {
    if (typeof this._requireOtpOverride === 'boolean') {
      return this._requireOtpOverride;
    }
    // Google OAuth login flow does not require mobile OTP step
    return false;
  }

  /**
   * Exchanges the one-time ticket from the callback redirect for an admin session.
   *
   * @param {object} params
   * @param {string} params.ticket
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ rawToken: string, session: object, user: object }>}
   */
  async exchangeTicket({ ticket, ipAddress = null, userAgent = null, requestId = null }) {
    assertConfigured();
    if (typeof ticket !== 'string' || !TOKEN_PATTERN.test(ticket)) {
      throw new ValidationError('A valid ticket is required', [{ field: 'ticket', message: 'Invalid ticket' }]);
    }

    const record = await takeOnce(`${TICKET_PREFIX}${sha256(ticket)}`);
    if (!record) {
      throw new UnauthorizedError('Sign-in ticket is invalid or has expired', ERROR_CODES.INVALID_TOKEN);
    }

    // Re-check the account: it may have been disabled between callback and exchange.
    const user = await userRepository.findById(record.userId);
    if (!user || !adminAuthService.isAdminRole(user.role)) {
      throw new UnauthorizedError('Sign-in ticket is invalid or has expired', ERROR_CODES.INVALID_TOKEN);
    }
    if (!adminAuthService.isAccountActive(user)) {
      throw new ForbiddenError('Administrator account is disabled', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    if (record.identityId) {
      try {
        await adminOAuthIdentityRepository.touchLogin(record.identityId, record.email || null);
      } catch (err) {
        logger.warn('Failed to update Google identity last login', { error: err.message });
      }
    }

    if (this.isOtpRequired()) {
      const adminOtpService = require('./admin-otp.service');
      const challenge = await adminOtpService.createChallenge({
        account: user,
        authMethod: 'google_sms_otp',
        ipAddress,
        userAgent,
        requestId,
      });
      return {
        step: 'OTP_PENDING',
        ...challenge,
        sessionToken: challenge.challengeId,
        identifier: user.email,
      };
    }

    return adminAuthService.createAuthenticatedSession({
      user,
      authMethod: 'google',
      ipAddress,
      userAgent,
      requestId,
    });
  }
}

module.exports = new AdminGoogleAuthService();
