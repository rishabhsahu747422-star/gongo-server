'use strict';

const crypto = require('crypto');
const renflairProvider = require('../providers/renflair.provider');
const redisService = require('./redis.service');
const { UserRepository } = require('../repositories');
const { env, logger } = require('../config');
const {
  BadRequestError,
  ForbiddenError,
  TooManyRequestsError,
} = require('../errors');

class CustomerAuthService {
  constructor({
    userRepo = new UserRepository(),
    renflair = renflairProvider,
    redis = redisService,
  } = {}) {
    this.userRepository = userRepo;
    this.renflairProvider = renflair;
    this.redisService = redis;
    this.redisClient = redis.client;
    this.hashSecret = env.SUPABASE_SERVICE_ROLE_KEY || env.FIREBASE_PRIVATE_KEY || 'gongo-customer-otp-salt';
  }

  /**
   * Normalizes mobile number to 10-digit format (Indian mobile).
   *
   * @param {string} rawPhone
   * @returns {string} 10-digit number
   */
  normalizePhone(rawPhone) {
    if (!rawPhone || typeof rawPhone !== 'string') {
      throw new BadRequestError('Phone number is required', 'INVALID_PHONE');
    }

    const digits = rawPhone.replace(/\D/g, '');
    const cleanPhone = digits.slice(-10);

    if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
      throw new BadRequestError(
        'Please enter a valid 10-digit Indian mobile number (starting with 6-9)',
        'INVALID_PHONE',
      );
    }

    return cleanPhone;
  }

  /**
   * Generates a cryptographically secure 6-digit numeric OTP.
   *
   * @returns {string} 6-digit OTP
   */
  generateOtp() {
    return crypto.randomInt(100000, 1000000).toString();
  }

  /**
   * Hashes an OTP with a random cryptographic salt using HMAC-SHA256.
   * Plaintext OTPs are NEVER persisted in Redis or PostgreSQL.
   *
   * @param {string} otp
   * @param {string} salt
   * @returns {string}
   */
  hashOtp(otp, salt) {
    return crypto
      .createHmac('sha256', this.hashSecret)
      .update(`${String(otp)}:${String(salt)}`)
      .digest('hex');
  }

  /**
   * Performs constant-time comparison to prevent timing attacks.
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
   * Sends 6-digit OTP SMS via Renflair SMS Gateway to customer's mobile number.
   * Enforces 30s resend cooldown, per-phone & per-IP rate limits, and 5-min TTL.
   *
   * @param {object} params
   * @param {string} params.phone
   * @param {string} [params.ipAddress]
   * @returns {Promise<{ expiresIn: number, resendAfter: number, devOtp?: string }>}
   */
  async sendOtp({ phone, ipAddress }) {
    const cleanPhone = this.normalizePhone(phone);
    const cooldownKey = `customer:otp:cooldown:${cleanPhone}`;
    const stateKey = `customer:otp:${cleanPhone}`;

    // 1. Resend cooldown guard (30 seconds)
    const existingCooldown = await this.redisClient.ttl(cooldownKey);
    if (existingCooldown > 0) {
      throw new TooManyRequestsError(
        `Please wait ${existingCooldown} seconds before requesting a new OTP.`,
        'AUTH_COOLDOWN_ACTIVE',
      );
    }

    // 2. Layered Rate Limiting: Per-phone limit
    const phoneLimit = await this.redisService.checkRateLimit(
      'customer_phone',
      cleanPhone,
      env.AUTH_RATE_LIMIT_PHONE_MAX || 5,
      env.AUTH_RATE_LIMIT_WINDOW_SECONDS || 3600,
    );
    if (!phoneLimit.allowed) {
      logger.warn('Customer OTP phone rate limit exceeded', {
        phone: this.renflairProvider.maskPhone(cleanPhone),
      });
      throw new TooManyRequestsError(
        'Too many OTP requests for this phone number. Please try again later.',
        'AUTH_RATE_LIMITED',
      );
    }

    // 3. Layered Rate Limiting: Per-IP limit
    const ipIdentifier = String(ipAddress || 'unknown').trim();
    if (ipIdentifier && ipIdentifier !== 'unknown') {
      const ipLimit = await this.redisService.checkRateLimit(
        'customer_ip',
        ipIdentifier,
        env.AUTH_RATE_LIMIT_IP_MAX || 20,
        env.AUTH_RATE_LIMIT_WINDOW_SECONDS || 3600,
      );
      if (!ipLimit.allowed) {
        logger.warn('Customer OTP IP rate limit exceeded', { ip: ipIdentifier });
        throw new TooManyRequestsError(
          'Too many requests from this network. Please try again later.',
          'AUTH_RATE_LIMITED',
        );
      }
    }

    // 4. Generate secure 6-digit numeric OTP and salt
    const otp = this.generateOtp();
    const salt = crypto.randomBytes(16).toString('hex');
    const otpHash = this.hashOtp(otp, salt);

    // 5. Dispatch SMS via Renflair SMS Gateway
    const dispatchResult = await this.renflairProvider.sendOtp({
      phone: cleanPhone,
      otp,
    });

    // 6. Replace old OTP, reset attempts to 0, store hashed state with 5-minute TTL
    const payload = JSON.stringify({
      otpHash,
      salt,
      attempts: 0,
      phone: cleanPhone,
      createdAt: new Date().toISOString(),
    });

    await Promise.all([
      this.redisClient.set(stateKey, payload, 'EX', 300), // 5 minutes TTL
      this.redisClient.set(cooldownKey, '1', 'EX', 30),   // 30 seconds cooldown
    ]);

    logger.info('Customer OTP sent via Renflair', {
      phone: this.renflairProvider.maskPhone(cleanPhone),
      expiresIn: 300,
      resendAfter: 30,
    });

    const response = {
      expiresIn: 300,
      resendAfter: 30,
    };

    // In isolated test environments only, expose devOtp for automated test assertions
    if (process.env.NODE_ENV === 'test') {
      response.devOtp = otp;
      response.simulated = Boolean(dispatchResult?.simulated);
    }

    return response;
  }

  /**
   * Verifies 6-digit OTP, enforces maximum 3 incorrect attempts,
   * creates or resolves customer in PostgreSQL, and generates authenticated session tokens.
   *
   * @param {object} params
   * @param {string} params.phone
   * @param {string} params.otp
   * @returns {Promise<object>} Customer info and tokens
   */
  async verifyOtp({ phone, otp }) {
    const cleanPhone = this.normalizePhone(phone);
    const cleanOtp = String(otp || '').trim();

    if (!/^\d{6}$/.test(cleanOtp)) {
      const err = new BadRequestError('Invalid OTP', 'INVALID_OTP');
      err.data = { attemptsRemaining: 2 };
      throw err;
    }

    const stateKey = `customer:otp:${cleanPhone}`;
    const cooldownKey = `customer:otp:cooldown:${cleanPhone}`;
    const lockKey = `customer:otp:lock:${cleanPhone}`;

    // Concurrency guard: prevent race conditions during verification
    const acquired = await this.redisClient.set(lockKey, '1', 'NX', 'EX', 5);
    if (!acquired) {
      throw new BadRequestError('A verification is currently in progress. Please wait a moment.', 'CONCURRENT_VERIFICATION');
    }

    try {
      // 1. Retrieve stored OTP state
      const rawState = await this.redisClient.get(stateKey);
      if (!rawState) {
        throw new BadRequestError(
          'OTP has expired or is invalid. Please request a new code.',
          'OTP_EXPIRED',
        );
      }

      let state;
      try {
        state = JSON.parse(rawState);
      } catch {
        throw new BadRequestError('Invalid OTP state. Please request a new code.', 'OTP_EXPIRED');
      }

      const currentAttempts = Number(state.attempts || 0);

      // If attempts already exhausted (>= 3)
      if (currentAttempts >= 3) {
        await Promise.all([
          this.redisClient.del(stateKey),
          this.redisClient.del(cooldownKey),
        ]);
        const err = new BadRequestError(
          'Too many incorrect attempts. Please try again.',
          'OTP_ATTEMPTS_EXCEEDED',
        );
        err.data = { attemptsRemaining: 0 };
        throw err;
      }

      // 2. Constant-time cryptographic comparison
      const isValid = this.verifyOtpHash(cleanOtp, state.otpHash, state.salt);

      if (!isValid) {
        const newAttempts = currentAttempts + 1;

        if (newAttempts >= 3) {
          // Third wrong OTP: invalidate/delete immediately
          await Promise.all([
            this.redisClient.del(stateKey),
            this.redisClient.del(cooldownKey),
          ]);
          const err = new BadRequestError(
            'Too many incorrect attempts. Please try again.',
            'OTP_ATTEMPTS_EXCEEDED',
          );
          err.data = { attemptsRemaining: 0 };
          throw err;
        } else {
          // First or second wrong OTP: update attempts, retain TTL, stay on OTP screen
          const remainingTtl = await this.redisClient.ttl(stateKey);
          const updatedPayload = JSON.stringify({
            ...state,
            attempts: newAttempts,
          });
          await this.redisClient.set(
            stateKey,
            updatedPayload,
            'EX',
            remainingTtl > 0 ? remainingTtl : 300,
          );

          const remainingAttempts = 3 - newAttempts;
          const err = new BadRequestError('Invalid OTP', 'INVALID_OTP');
          err.data = { attemptsRemaining: remainingAttempts };
          throw err;
        }
      }

      // 3. CORRECT OTP: Delete OTP state & cooldown immediately to prevent reuse
      await Promise.all([
        this.redisClient.del(stateKey),
        this.redisClient.del(cooldownKey),
      ]);

      // 4. Find or create customer in PostgreSQL
      let user = await this.userRepository.findByPhone(cleanPhone);

      if (user) {
        if (!user.isActive) {
          throw new ForbiddenError(
            'Your account has been deactivated. Please contact support.',
            'AUTH_USER_INACTIVE',
          );
        }

        // Ensure user has authId
        if (!user.authId) {
          const authId = `gongo_cust_${crypto.randomUUID()}`;
          user = await this.userRepository.update(user.id, { authId });
        }
      } else {
        // Create new Customer record
        const authId = `gongo_cust_${crypto.randomUUID()}`;
        user = await this.userRepository.create({
          role: 'customer',
          name: null,
          countryCode: '+91',
          phone: `+91${cleanPhone}`,
          authProvider: 'supabase',
          authId,
          isActive: true,
          status: 'active',
        });

        logger.info('New customer account created via Mobile OTP verification', {
          userId: user.id,
          phone: this.renflairProvider.maskPhone(cleanPhone),
        });
      }

      // 5. Generate authenticated session tokens
      const accessToken = crypto.randomBytes(32).toString('hex');
      const refreshToken = crypto.randomBytes(32).toString('hex');

      const sessionPayload = JSON.stringify({
        uid: user.authId,
        userId: user.id,
        phone: cleanPhone,
        email: user.email || null,
        role: 'customer',
        // Issue time (seconds, ms precision) lets logout revocation distinguish old sessions
        // from ones created right after re-login
        iat: Date.now() / 1000,
        createdAt: new Date().toISOString(),
      });

      // Persist in Redis with 30-day / 60-day TTL.
      // Refresh tokens use their own prefix so they can never be presented as access tokens.
      await Promise.all([
        this.redisClient.set(`auth:session:${accessToken}`, sessionPayload, 'EX', 30 * 24 * 3600),
        this.redisClient.set(`auth:refresh:${refreshToken}`, sessionPayload, 'EX', 60 * 24 * 3600),
      ]);

      logger.info('Customer authenticated via Mobile OTP', {
        userId: user.id,
        phone: this.renflairProvider.maskPhone(cleanPhone),
      });

      return {
        user: {
          id: user.id,
          customerReference: user.customerReference || user.customer_reference || null,
          phone: cleanPhone,
          role: 'customer',
          isProfileComplete: Boolean(user.name && (user.phone || user.email)),
        },
        accessToken,
        refreshToken,
      };
    } finally {
      await this.redisClient.del(lockKey).catch(() => {});
    }
  }
}

module.exports = new CustomerAuthService();
