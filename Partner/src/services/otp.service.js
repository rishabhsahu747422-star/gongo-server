'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const { redisClient } = require('../providers/redis');
const renflairProvider = require('../providers/renflair.provider');
const UserRepository = require('../repositories/user.repository');
const PartnerRepository = require('../repositories/partner.repository');
const authService = require('./auth.service');
const {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class OtpService {
  constructor() {
    this.userRepository = new UserRepository();
    this.partnerRepository = new PartnerRepository();
  }

  /**
   * Normalizes mobile number to 10-digit format.
   *
   * @param {string} phone
   * @returns {string} 10-digit number
   */
  normalizePhone(phone) {
    if (!phone || typeof phone !== 'string') {
      throw new ValidationError('Phone number is required', [
        { field: 'phone', message: 'Valid 10-digit mobile number required' },
      ]);
    }

    const clean = phone.replace(/[^0-9]/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(clean)) {
      throw new ValidationError('Please enter a valid 10-digit Indian mobile number', [
        { field: 'phone', message: 'Number must be 10 digits starting with 6, 7, 8, or 9' },
      ]);
    }

    return clean;
  }

  /**
   * Hashes an OTP with a cryptographic salt using HMAC-SHA256.
   * Plaintext OTPs are NEVER persisted or returned.
   *
   * @param {string} otp
   * @param {string} salt
   * @returns {string} Hex hash
   */
  hashOtp(otp, salt) {
    const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.ENCRYPTION_KEY || 'gongo-partner-otp-secret';
    return crypto
      .createHmac('sha256', secret)
      .update(`${String(otp)}:${String(salt)}`)
      .digest('hex');
  }

  /**
   * Constant-time verification of candidate OTP against stored hash.
   *
   * @param {string} candidateOtp
   * @param {string} storedHash
   * @param {string} salt
   * @returns {boolean}
   */
  verifyOtpHash(candidateOtp, storedHash, salt) {
    if (!candidateOtp || !storedHash || !salt) return false;

    const candidateHash = this.hashOtp(candidateOtp, salt);
    const candidateBuffer = Buffer.from(candidateHash, 'hex');
    const storedBuffer = Buffer.from(storedHash, 'hex');

    if (candidateBuffer.length !== storedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(candidateBuffer, storedBuffer);
  }

  /**
   * Sends 6-digit OTP SMS via Renflair SMS Gateway with cooldown and rate-limit tracking.
   *
   * @param {object} params
   * @param {string} params.phone - 10-digit mobile number
   * @returns {Promise<{ phone: string, cooldown: number, expiresIn: number, simulated?: boolean, devOtp?: string }>}
   */
  /**
   * Dispatches 6-digit OTP SMS via Renflair SMS Gateway to partner's mobile number.
   * Enforces 30s resend cooldown and 300s TTL.
   *
   * @param {object} params
   * @param {string} params.phone - 10-digit mobile number
   * @returns {Promise<{ phone: string, cooldown: number, expiresIn: number, simulated?: boolean, devOtp?: string }>}
   */
  async sendPartnerOtp({ phone }) {
    const cleanPhone = this.normalizePhone(phone);
    const cooldownKey = `partner:otp:cooldown:${cleanPhone}`;
    const stateKey = `partner:otp:${cleanPhone}`;
    const attemptsKey = `partner:otp:attempts:${cleanPhone}`;

    // 1. Resend cooldown guard (30 seconds)
    const existingCooldown = await redisClient.ttl(cooldownKey);
    if (existingCooldown > 0) {
      throw new RateLimitError(
        `Please wait ${existingCooldown} seconds before requesting a new OTP.`,
        ERROR_CODES.RATE_LIMIT_EXCEEDED,
      );
    }

    // 2. Generate secure 6-digit OTP
    const rawOtp = String(crypto.randomInt(100000, 1000000));
    const salt = crypto.randomBytes(16).toString('hex');
    const otpHash = this.hashOtp(rawOtp, salt);

    const ttlSeconds = env.AUTH_OTP_EXPIRY_SECONDS || 300;
    const cooldownSeconds = env.OTP_RESEND_COOLDOWN_SECONDS || 30;

    // 3. Dispatch SMS via Renflair SMS Gateway
    const dispatchResult = await renflairProvider.sendOtp({
      phone: cleanPhone,
      otp: rawOtp,
    });

    if (dispatchResult.simulated && env.NODE_ENV !== 'test') {
      throw new ServiceUnavailableError('Simulated OTP dispatch is strictly forbidden outside automated test suites');
    }

    // 4. Store salted hash in Redis (NEVER plaintext) with TTL
    const payload = JSON.stringify({
      otpHash,
      salt,
      createdAt: new Date().toISOString(),
    });

    await Promise.all([
      redisClient.set(stateKey, payload, 'EX', ttlSeconds),
      redisClient.set(cooldownKey, '1', 'EX', cooldownSeconds),
      redisClient.del(attemptsKey),
    ]);

    logger.info('Partner OTP dispatched and stored in Redis', {
      phone: renflairProvider.maskPhone(cleanPhone),
      expiresIn: ttlSeconds,
    });

    const response = {
      phone: cleanPhone,
      cooldown: cooldownSeconds,
      expiresIn: ttlSeconds,
      message: 'OTP sent successfully',
    };

    if (env.NODE_ENV === 'test') {
      response.devOtp = rawOtp;
      response.simulated = Boolean(dispatchResult.simulated);
    }

    return response;
  }

  /**
   * Legacy sendOtp for /api/auth/otp/send backwards compatibility.
   */
  async sendOtp({ phone }) {
    const cleanPhone = this.normalizePhone(phone);
    const cooldownKey = `otp:cooldown:${cleanPhone}`;
    const stateKey = `otp:state:${cleanPhone}`;
    const attemptsKey = `otp:attempts:${cleanPhone}`;

    const existingCooldown = await redisClient.ttl(cooldownKey);
    if (existingCooldown > 0) {
      throw new RateLimitError(
        `Please wait ${existingCooldown} seconds before requesting a new OTP.`,
        ERROR_CODES.RATE_LIMIT_EXCEEDED,
      );
    }

    const rawOtp = String(crypto.randomInt(100000, 1000000));
    const salt = crypto.randomBytes(16).toString('hex');
    const otpHash = this.hashOtp(rawOtp, salt);

    const ttlSeconds = env.AUTH_OTP_EXPIRY_SECONDS || 300;
    const cooldownSeconds = env.AUTH_OTP_RESEND_COOLDOWN_SECONDS || 60;

    const dispatchResult = await renflairProvider.sendOtp({
      phone: cleanPhone,
      otp: rawOtp,
    });

    if (dispatchResult.simulated && env.NODE_ENV !== 'test') {
      throw new ServiceUnavailableError('Simulated OTP dispatch is strictly forbidden outside automated test suites');
    }

    const payload = JSON.stringify({
      otpHash,
      salt,
      createdAt: new Date().toISOString(),
    });

    await Promise.all([
      redisClient.set(stateKey, payload, 'EX', ttlSeconds),
      redisClient.set(cooldownKey, '1', 'EX', cooldownSeconds),
      redisClient.del(attemptsKey),
    ]);

    const response = {
      phone: cleanPhone,
      cooldown: cooldownSeconds,
      expiresIn: ttlSeconds,
      message: 'OTP sent successfully',
    };

    if (env.NODE_ENV === 'test') {
      response.devOtp = rawOtp;
      response.simulated = Boolean(dispatchResult.simulated);
    }

    return response;
  }

  /**
   * Verifies 6-digit OTP, enforces 3-attempt lockout with purge on 3rd failure,
   * validates partner existence, checks account status, and establishes authenticated session.
   *
   * @param {object} params
   * @param {string} params.phone - 10-digit mobile number
   * @param {string} params.otp - 6-digit OTP string
   * @param {boolean} [params.requireExisting=true] - If true, requires existing Partner account (returns PARTNER_NOT_FOUND)
   * @returns {Promise<object>} Authenticated session payload
   */
  async verifyPartnerOtp({ phone, otp, requireExisting = true }) {
    const cleanPhone = this.normalizePhone(phone);
    const cleanOtp = String(otp || '').trim();

    if (!/^\d{6}$/.test(cleanOtp)) {
      throw new ValidationError('Invalid verification code: exactly 6 digits required', [
        { field: 'otp', message: 'Verification code must be 6 digits' },
      ]);
    }

    const lockKey = `partner:lock:otp:verify:${cleanPhone}`;
    const stateKey = `partner:otp:${cleanPhone}`;
    const attemptsKey = `partner:otp:attempts:${cleanPhone}`;
    const cooldownKey = `partner:otp:cooldown:${cleanPhone}`;
    const maxAttempts = 3;

    // 1. Atomic concurrency guard
    const acquired = await redisClient.set(lockKey, '1', 'NX', 'EX', 5);
    if (!acquired) {
      throw new ConflictError(
        'A verification is currently in progress. Please wait a moment.',
        ERROR_CODES.CONFLICT,
      );
    }

    try {
      // 2. Check failed attempt limits
      const attemptsVal = await redisClient.get(attemptsKey);
      const currentAttempts = attemptsVal ? parseInt(attemptsVal, 10) : 0;

      if (currentAttempts >= maxAttempts) {
        await Promise.all([
          redisClient.del(stateKey),
          redisClient.del(`otp:state:${cleanPhone}`),
        ]);
        const err = new UnauthorizedError('Too many incorrect attempts. Please try again.', 'OTP_ATTEMPTS_EXCEEDED');
        err.data = { attemptsRemaining: 0 };
        throw err;
      }

      // 3. Retrieve stored state (check partner:otp: first, then fallback to otp:state:)
      let rawState = await redisClient.get(stateKey);
      if (!rawState) {
        rawState = await redisClient.get(`otp:state:${cleanPhone}`);
      }

      if (!rawState) {
        throw new UnauthorizedError(
          'Verification code has expired or is invalid. Please request a new one.',
          ERROR_CODES.INVALID_TOKEN,
        );
      }

      let state;
      try {
        state = JSON.parse(rawState);
      } catch {
        throw new UnauthorizedError(
          'Invalid OTP state. Please request a new OTP.',
          ERROR_CODES.INVALID_TOKEN,
        );
      }

      // 4. Constant-time cryptographic verification
      const isValid = this.verifyOtpHash(cleanOtp, state.otpHash, state.salt);

      if (!isValid) {
        const attempts = await redisClient.incr(attemptsKey);
        if (attempts === 1) {
          await redisClient.expire(attemptsKey, 300);
        }

        const remaining = Math.max(0, maxAttempts - attempts);
        if (remaining <= 0) {
          await Promise.all([
            redisClient.del(stateKey),
            redisClient.del(`otp:state:${cleanPhone}`),
            redisClient.del(attemptsKey),
          ]);
          const err = new UnauthorizedError('Too many incorrect attempts. Please try again.', 'OTP_ATTEMPTS_EXCEEDED');
          err.data = { attemptsRemaining: 0 };
          throw err;
        }

        const err = new UnauthorizedError('Invalid OTP', 'INVALID_OTP');
        err.data = { attemptsRemaining: remaining };
        throw err;
      }

      // 5. SUCCESS: Immediately purge OTP state & attempts to prevent reuse
      await Promise.all([
        redisClient.del(stateKey),
        redisClient.del(attemptsKey),
        redisClient.del(cooldownKey),
        redisClient.del(`otp:state:${cleanPhone}`),
        redisClient.del(`otp:attempts:${cleanPhone}`),
        redisClient.del(`otp:cooldown:${cleanPhone}`),
      ]);

      // 6. Look up partner
      let user = await this.userRepository.findByPhone(cleanPhone);
      let partner = null;
      if (user && user.auth_id) {
        partner = await this.partnerRepository.findByAuthId(user.auth_id);
      }
      if (!partner) {
        partner = await this.partnerRepository.findByPhone(cleanPhone);
      }

      // If requireExisting is false (Register flow):
      if (!requireExisting) {
        if (partner && partner.partnerId) {
          throw new ConflictError(
            'A partner account already exists with this mobile number. Please sign in instead.',
            'PARTNER_ALREADY_EXISTS',
          );
        }

        // Generate verified registration session token for the new partner
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const authId = user?.auth_id || crypto.randomUUID();

        const sessionPayload = JSON.stringify({
          uid: authId,
          userId: user?.id || null,
          phone: cleanPhone,
          email: user?.email || null,
          role: null,
          partnerId: null,
          status: 'UNREGISTERED',
          createdAt: new Date().toISOString(),
        });

        // 24-hour TTL for registration session token
        await redisClient.set(`auth:session:${sessionToken}`, sessionPayload, 'EX', 24 * 3600);

        logger.info('Partner registration OTP verified, session token issued for new partner', {
          phone: renflairProvider.maskPhone(cleanPhone),
        });

        return {
          token: sessionToken,
          isRegistered: false,
          phone: cleanPhone,
          message: 'OTP verified successfully. Partner registration required.',
        };
      }

      // If requireExisting is true (Login flow):
      if (!partner || !partner.partnerId) {
        throw new NotFoundError(
          'No partner account found with this mobile number.',
          'PARTNER_NOT_FOUND',
        );
      }

      // 7. Account status and deactivation checks
      if (partner.is_active === false) {
        throw new ForbiddenError(
          'Partner account has been deactivated',
          ERROR_CODES.ACCOUNT_DEACTIVATED,
        );
      }

      const statusUpper = String(partner.partner_status || '').toUpperCase();
      if (['SUSPENDED', 'BLOCKED', 'REJECTED'].includes(statusUpper)) {
        throw new ForbiddenError(
          `Partner account is ${statusUpper.toLowerCase()}. Access denied.`,
          ERROR_CODES.FORBIDDEN,
        );
      }

      // 8. Generate cryptographically random authenticated session token
      const sessionToken = crypto.randomBytes(32).toString('hex');
      const sessionData = await authService.createSession({
        authUser: {
          authId: partner.auth_id,
          phone: partner.phone || cleanPhone,
          email: partner.email || null,
        },
      });

      const sessionPayload = JSON.stringify({
        uid: partner.auth_id,
        userId: partner.userId,
        phone: partner.phone || cleanPhone,
        email: partner.email || null,
        role: partner.role || 'PARTNER',
        partnerId: partner.partnerId,
        createdAt: new Date().toISOString(),
      });
      await redisClient.set(`auth:session:${sessionToken}`, sessionPayload, 'EX', 30 * 24 * 3600);

      logger.info('Partner authenticated via OTP and session established', {
        partnerId: partner.partnerId,
        phone: renflairProvider.maskPhone(cleanPhone),
      });

      return {
        token: sessionToken,
        isRegistered: true,
        ...sessionData,
      };
    } finally {
      await redisClient.del(lockKey).catch(() => {});
    }
  }

  /**
   * Legacy verifyOtp for /api/auth/otp/verify backwards compatibility.
   */
  async verifyOtp({ phone, otp }) {
    const cleanPhone = this.normalizePhone(phone);
    const cleanOtp = String(otp || '').trim();

    if (!/^\d{6}$/.test(cleanOtp)) {
      throw new ValidationError('Invalid verification code: exactly 6 digits required', [
        { field: 'otp', message: 'Verification code must be 6 digits' },
      ]);
    }

    const lockKey = `lock:otp:verify:${cleanPhone}`;
    const stateKey = `otp:state:${cleanPhone}`;
    const attemptsKey = `otp:attempts:${cleanPhone}`;
    const maxAttempts = env.AUTH_OTP_MAX_ATTEMPTS || 3;

    const acquired = await redisClient.set(lockKey, '1', 'NX', 'EX', 5);
    if (!acquired) {
      throw new ConflictError(
        'A verification is currently in progress. Please wait a moment.',
        ERROR_CODES.CONFLICT,
      );
    }

    try {
      const attemptsVal = await redisClient.get(attemptsKey);
      const currentAttempts = attemptsVal ? parseInt(attemptsVal, 10) : 0;

      if (currentAttempts >= maxAttempts) {
        await redisClient.del(stateKey);
        throw new UnauthorizedError(
          'Maximum verification attempts exceeded. Please request a new OTP.',
          ERROR_CODES.AUTH_REQUIRED,
        );
      }

      const rawState = await redisClient.get(stateKey);
      if (!rawState) {
        throw new UnauthorizedError(
          'Verification code has expired or is invalid. Please request a new one.',
          ERROR_CODES.INVALID_TOKEN,
        );
      }

      let state;
      try {
        state = JSON.parse(rawState);
      } catch {
        throw new UnauthorizedError(
          'Invalid OTP state. Please request a new OTP.',
          ERROR_CODES.INVALID_TOKEN,
        );
      }

      const isValid = this.verifyOtpHash(cleanOtp, state.otpHash, state.salt);

      if (!isValid) {
        const attempts = await redisClient.incr(attemptsKey);
        if (attempts === 1) {
          await redisClient.expire(attemptsKey, env.AUTH_OTP_EXPIRY_SECONDS || 300);
        }

        const remaining = Math.max(0, maxAttempts - attempts);
        if (remaining <= 0) {
          await redisClient.del(stateKey);
          throw new UnauthorizedError(
            'Maximum verification attempts exceeded. Please request a new OTP.',
            ERROR_CODES.AUTH_REQUIRED,
          );
        }

        throw new UnauthorizedError(
          `Invalid verification code. ${remaining} attempt(s) remaining.`,
          ERROR_CODES.INVALID_TOKEN,
        );
      }

      await Promise.all([
        redisClient.del(stateKey),
        redisClient.del(attemptsKey),
        redisClient.del(`otp:cooldown:${cleanPhone}`),
      ]);

      const user = await this.userRepository.findByPhone(cleanPhone);
      if (!user || String(user.role || '').toUpperCase() !== 'PARTNER') {
        const registrationToken = crypto.randomBytes(32).toString('hex');
        const tempAuthId = user?.auth_id || `auth_${cleanPhone}`;
        const sessionPayload = JSON.stringify({
          uid: tempAuthId,
          userId: user ? user.id : null,
          phone: cleanPhone,
          role: 'PARTNER',
          partnerId: null,
          createdAt: new Date().toISOString(),
        });
        await redisClient.set(`auth:session:${registrationToken}`, sessionPayload, 'EX', 24 * 3600);

        return {
          token: registrationToken,
          isRegistered: false,
          phone: cleanPhone,
          message: 'Partner registration required',
        };
      }

      const partner = await this.partnerRepository.findByAuthId(user.auth_id);
      if (!partner || !partner.partnerId) {
        const registrationToken = crypto.randomBytes(32).toString('hex');
        const sessionPayload = JSON.stringify({
          uid: user.auth_id,
          userId: user.id,
          phone: user.phone || cleanPhone,
          email: user.email || null,
          role: 'PARTNER',
          partnerId: null,
          createdAt: new Date().toISOString(),
        });
        await redisClient.set(`auth:session:${registrationToken}`, sessionPayload, 'EX', 24 * 3600);

        return {
          token: registrationToken,
          isRegistered: false,
          phone: cleanPhone,
          user: {
            authId: user.auth_id,
            phone: user.phone || cleanPhone,
            email: user.email || null,
          },
          message: 'Partner registration required',
        };
      }

      if (partner.is_active === false) {
        throw new ForbiddenError(
          'Partner account has been deactivated',
          ERROR_CODES.ACCOUNT_DEACTIVATED,
        );
      }

      const sessionToken = crypto.randomBytes(32).toString('hex');
      const sessionData = await authService.createSession({
        authUser: {
          authId: user.auth_id,
          phone: user.phone || cleanPhone,
          email: user.email || null,
        },
      });

      const sessionPayload = JSON.stringify({
        uid: user.auth_id,
        userId: user.id,
        phone: user.phone || cleanPhone,
        email: user.email || null,
        role: user.role,
        partnerId: partner.partnerId,
        createdAt: new Date().toISOString(),
      });
      await redisClient.set(`auth:session:${sessionToken}`, sessionPayload, 'EX', 30 * 24 * 3600);

      logger.info('Partner authenticated via OTP and session established', {
        partnerId: partner.partnerId,
        phone: renflairProvider.maskPhone(cleanPhone),
      });

      return {
        token: sessionToken,
        isRegistered: true,
        ...sessionData,
      };
    } finally {
      await redisClient.del(lockKey).catch(() => {});
    }
  }
}

module.exports = new OtpService();
