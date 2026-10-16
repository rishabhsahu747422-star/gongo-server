'use strict';

const crypto = require('crypto');
const renflairProvider = require('../providers/renflair.provider');
const { redisClient } = require('../providers/redis');
const adminCredentialRepository = require('../repositories/admin-credential.repository');
const userRepository = require('../repositories/user.repository');
const adminAuthService = require('./admin-auth.service');
const auditService = require('./audit.service');
const { sha256 } = require('../utils/crypto');
const {
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  RateLimitError,
  ServiceUnavailableError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const env = require('../config/env');
const logger = require('../config/logger');

const CHALLENGE_PREFIX = 'admin:auth:challenge:';
const RESEND_COOLDOWN_PREFIX = 'admin:auth:cooldown:';
const OTP_SALT_PREFIX = 'admin:auth:salt:';
const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function safeAudit(event) {
  try {
    auditService.logAdminAction(event);
  } catch (err) {
    logger.error('Failed to record admin OTP audit event', { action: event.action, error: err.message });
  }
}

class AdminOtpService {
  /**
   * Generates a cryptographically random 6-digit numeric OTP.
   *
   * @returns {string} 6-digit string (e.g. "482910")
   */
  generateOtp() {
    return String(crypto.randomInt(100000, 1000000));
  }

  /**
   * Generates a 256-bit base64url challenge token.
   *
   * @returns {string}
   */
  generateChallengeId() {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Computes a salted HMAC-SHA256 hash of an OTP.
   *
   * @param {string} otp
   * @param {string} salt
   * @returns {string} Hex hash
   */
  hashOtp(otp, salt) {
    return crypto.createHmac('sha256', salt).update(String(otp)).digest('hex');
  }

  /**
   * Masks a phone number for safe API response and logging.
   *
   * @param {string} phone E.g. "8989232398", "+918989232398"
   * @returns {string} E.g. "+91 ******2398"
   */
  maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '+91 ******0000';
    const digits = phone.replace(/\D/g, '');
    const last4 = digits.slice(-4) || '0000';
    return `+91 ******${last4}`;
  }

  /**
   * Initiates an OTP challenge for an administrator whose password has just been verified.
   *
   * @param {object} params
   * @param {object} params.account Verified admin record
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ step: 'OTP_PENDING', challengeId: string, phoneMasked: string, expiresIn: number }>}
   */
  async createChallenge({ account, authMethod = 'password_sms_otp', ipAddress = null, userAgent = null, requestId = null }) {
    if (!account.phone || typeof account.phone !== 'string' || !account.phone.trim()) {
      logger.error('Admin account lacks verified phone number for OTP verification', { userId: account.id });
      throw new ForbiddenError(
        'Administrator account does not have a verified phone number configured for two-factor authentication',
        ERROR_CODES.FORBIDDEN,
      );
    }

    const cleanPhone = account.phone.replace(/[^0-9]/g, '').slice(-10);
    if (cleanPhone.length !== 10) {
      logger.error('Admin account phone number is invalid format', { userId: account.id });
      throw new ForbiddenError(
        'Administrator account phone number is not a valid 10-digit number for SMS delivery',
        ERROR_CODES.FORBIDDEN,
      );
    }

    const challengeId = this.generateChallengeId();
    const challengeKey = `${CHALLENGE_PREFIX}${sha256(challengeId)}`;
    const otp = this.generateOtp();
    const salt = crypto.randomBytes(16).toString('hex');
    const otpHash = this.hashOtp(otp, salt);

    const ttlSeconds = env.AUTH_OTP_EXPIRY_SECONDS || 300;
    const cooldownSeconds = env.AUTH_OTP_RESEND_COOLDOWN_SECONDS || 60;
    const maxAttempts = env.AUTH_OTP_MAX_ATTEMPTS || 3;

    // Send SMS first: if provider delivery fails, do NOT persist the challenge
    try {
      await renflairProvider.sendOtp({ phone: cleanPhone, otp });
    } catch (err) {
      logger.error('Admin OTP SMS delivery failed during login', {
        userId: account.id,
        phone: renflairProvider.maskPhone(cleanPhone),
        error: err.message,
      });
      safeAudit({
        actorId: account.id,
        actorRole: account.role || 'ADMIN',
        action: 'ADMIN_OTP_DISPATCH_FAILED',
        targetResource: 'ADMIN_CHALLENGE',
        requestId,
        ipAddress,
        userAgent,
        metadata: { reason: 'sms_delivery_failed' },
      });
      throw err;
    }

    const challengePayload = {
      userId: account.id,
      phone: cleanPhone,
      otpHash,
      salt,
      attempts: 0,
      maxAttempts,
      authMethod: authMethod || 'password_sms_otp',
      passwordChangeRequired: Boolean(account.must_change_password),
      createdAt: Date.now(),
    };

    try {
      await redisClient.set(challengeKey, JSON.stringify(challengePayload), 'EX', ttlSeconds);
      // Set resend cooldown per challenge
      await redisClient.set(`${RESEND_COOLDOWN_PREFIX}${sha256(challengeId)}`, '1', 'EX', cooldownSeconds);
    } catch (redisErr) {
      logger.error('Failed to persist Admin OTP challenge in Redis', { error: redisErr.message });
      throw new ServiceUnavailableError('Authentication service is temporarily unavailable');
    }

    safeAudit({
      actorId: account.id,
      actorRole: account.role || 'ADMIN',
      action: 'ADMIN_OTP_CHALLENGE_CREATED',
      targetResource: 'ADMIN_CHALLENGE',
      requestId,
      ipAddress,
      userAgent,
      metadata: { phoneMasked: this.maskPhone(cleanPhone) },
    });

    return {
      step: 'OTP_PENDING',
      challengeId,
      phoneMasked: this.maskPhone(cleanPhone),
      expiresIn: ttlSeconds,
    };
  }

  /**
   * Resends an OTP for an active challenge session while enforcing resend cooldown.
   *
   * @param {object} params
   * @param {string} params.challengeId
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ message: string, cooldownRemaining?: number }>}
   */
  async resendOtp({ challengeId, ipAddress = null, userAgent = null, requestId = null }) {
    if (!challengeId || typeof challengeId !== 'string' || !CHALLENGE_ID_PATTERN.test(challengeId)) {
      throw new ValidationError('A valid challengeId is required', [{ field: 'challengeId', message: 'Invalid challenge identifier' }]);
    }

    const challengeKey = `${CHALLENGE_PREFIX}${sha256(challengeId)}`;
    const cooldownKey = `${RESEND_COOLDOWN_PREFIX}${sha256(challengeId)}`;

    // Check cooldown
    const inCooldown = await redisClient.get(cooldownKey);
    if (inCooldown) {
      const ttl = await redisClient.ttl(cooldownKey);
      throw new RateLimitError(`Please wait ${ttl > 0 ? ttl : 60} seconds before requesting a new OTP.`);
    }

    const raw = await redisClient.get(challengeKey);
    if (!raw) {
      throw new UnauthorizedError('Verification challenge has expired. Please sign in again.', ERROR_CODES.TOKEN_EXPIRED);
    }

    let challenge;
    try {
      challenge = JSON.parse(raw);
    } catch {
      throw new UnauthorizedError('Invalid verification challenge state', ERROR_CODES.INVALID_TOKEN);
    }

    const newOtp = this.generateOtp();
    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = this.hashOtp(newOtp, newSalt);

    // Send SMS
    await renflairProvider.sendOtp({ phone: challenge.phone, otp: newOtp });

    // Update challenge state in Redis with remaining TTL
    const currentTtl = await redisClient.ttl(challengeKey);
    const ttlSeconds = currentTtl > 0 ? currentTtl : (env.AUTH_OTP_EXPIRY_SECONDS || 300);
    const cooldownSeconds = env.AUTH_OTP_RESEND_COOLDOWN_SECONDS || 60;

    challenge.otpHash = newHash;
    challenge.salt = newSalt;

    await redisClient.set(challengeKey, JSON.stringify(challenge), 'EX', ttlSeconds);
    await redisClient.set(cooldownKey, '1', 'EX', cooldownSeconds);

    safeAudit({
      actorId: challenge.userId,
      actorRole: 'ADMIN',
      action: 'ADMIN_OTP_RESENT',
      targetResource: 'ADMIN_CHALLENGE',
      requestId,
      ipAddress,
      userAgent,
      metadata: { phoneMasked: this.maskPhone(challenge.phone) },
    });

    return {
      message: 'A new verification passcode has been dispatched.',
      cooldownRemaining: cooldownSeconds,
    };
  }

  /**
   * Verifies an OTP against an active challenge and issues the authenticated Admin session.
   *
   * @param {object} params
   * @param {string} params.challengeId
   * @param {string} params.otp 6-digit numeric string
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {string} [params.requestId]
   * @returns {Promise<{ rawToken: string, session: object, user: object, passwordChangeRequired: boolean }>}
   */
  async verifyOtp({ challengeId, otp, ipAddress = null, userAgent = null, requestId = null }) {
    if (!challengeId || typeof challengeId !== 'string' || !CHALLENGE_ID_PATTERN.test(challengeId)) {
      throw new ValidationError('A valid challengeId is required', [{ field: 'challengeId', message: 'Invalid challenge identifier' }]);
    }

    const cleanOtp = String(otp || '').trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      throw new ValidationError('Passcode must be a 6-digit numeric code', [{ field: 'otp', message: '6-digit numeric OTP required' }]);
    }

    const challengeKey = `${CHALLENGE_PREFIX}${sha256(challengeId)}`;
    const raw = await redisClient.get(challengeKey);

    if (!raw) {
      throw new UnauthorizedError('Verification passcode has expired or is invalid. Please sign in again.', ERROR_CODES.TOKEN_EXPIRED);
    }

    let challenge;
    try {
      challenge = JSON.parse(raw);
    } catch {
      throw new UnauthorizedError('Invalid verification challenge state', ERROR_CODES.INVALID_TOKEN);
    }

    // Verify candidate OTP
    const candidateHash = this.hashOtp(cleanOtp, challenge.salt);
    const candidateBuf = Buffer.from(candidateHash, 'hex');
    const storedBuf = Buffer.from(challenge.otpHash, 'hex');
    const isMatch = candidateBuf.length === storedBuf.length && crypto.timingSafeEqual(candidateBuf, storedBuf);

    if (!isMatch) {
      challenge.attempts = (challenge.attempts || 0) + 1;
      const remainingAttempts = challenge.maxAttempts - challenge.attempts;

      safeAudit({
        actorId: challenge.userId,
        actorRole: 'ADMIN',
        action: 'ADMIN_OTP_VERIFY_FAILED',
        targetResource: 'ADMIN_CHALLENGE',
        requestId,
        ipAddress,
        userAgent,
        metadata: { attempts: challenge.attempts, remainingAttempts: Math.max(0, remainingAttempts) },
      });

      if (challenge.attempts >= challenge.maxAttempts) {
        // Invalidate challenge completely
        await redisClient.del(challengeKey);
        await redisClient.del(`${RESEND_COOLDOWN_PREFIX}${sha256(challengeId)}`);
        throw new UnauthorizedError('Too many failed attempts. This verification challenge has expired. Please sign in again.', ERROR_CODES.TOKEN_EXPIRED);
      }

      // Persist incremented attempts with remaining TTL
      const currentTtl = await redisClient.ttl(challengeKey);
      if (currentTtl > 0) {
        await redisClient.set(challengeKey, JSON.stringify(challenge), 'EX', currentTtl);
      }

      throw new UnauthorizedError(`Incorrect passcode. ${remainingAttempts} attempt(s) remaining.`, ERROR_CODES.INVALID_CREDENTIALS);
    }

    // Atomically consume challenge to prevent replay
    const deleted = await redisClient.del(challengeKey);
    await redisClient.del(`${RESEND_COOLDOWN_PREFIX}${sha256(challengeId)}`);
    if (deleted !== 1) {
      throw new UnauthorizedError('Verification passcode has already been used or expired.', ERROR_CODES.TOKEN_EXPIRED);
    }

    // Load user record from trusted server store and ensure still active and admin role
    const user = await userRepository.findById(challenge.userId);
    if (!user || !adminAuthService.isAccountActive(user)) {
      throw new ForbiddenError('Administrator account is disabled', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }
    if (!adminAuthService.isAdminRole(user.role)) {
      throw new ForbiddenError('Admin access required', ERROR_CODES.FORBIDDEN);
    }

    // Record successful login in credential store (clears failed lockout counters)
    await adminCredentialRepository.recordSuccessfulLogin(user.id);

    // Issue authentic administrative session
    const sessionResult = await adminAuthService.createAuthenticatedSession({
      user,
      authMethod: challenge.authMethod || 'password_sms_otp',
      ipAddress,
      userAgent,
      requestId,
    });

    safeAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'ADMIN_OTP_VERIFIED',
      targetResource: 'ADMIN_SESSION',
      targetResourceId: sessionResult.session.id,
      requestId,
      ipAddress,
      userAgent,
      metadata: { sessionId: sessionResult.session.id },
    });

    return {
      ...sessionResult,
      passwordChangeRequired: Boolean(challenge.passwordChangeRequired),
    };
  }

  /**
   * For testing only: retrieves stored challenge payload by challengeId
   */
  async getChallengeState(challengeId) {
    const raw = await redisClient.get(`${CHALLENGE_PREFIX}${sha256(challengeId)}`);
    return raw ? JSON.parse(raw) : null;
  }
}

module.exports = new AdminOtpService();
