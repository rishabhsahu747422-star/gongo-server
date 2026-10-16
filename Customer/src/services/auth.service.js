'use strict';

const crypto = require('crypto');
const otpService = require('./otp.service');
const redisService = require('./redis.service');
const firebaseAuthService = require('./firebase-auth.service');
const { Msg91Provider } = require('./sms');
const { UserRepository, CustomerRepository } = require('../repositories');
const s3Provider = require('./storage/s3.provider');
const { env, logger } = require('../config');
const {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  TooManyRequestsError,
} = require('../errors');

/**
 * AuthService implements customer authentication business logic:
 * - OTP generation, delivery, and verification
 * - Rate limiting and brute-force protection
 * - Firebase Custom Token minting
 * - User resolution and creation (enforcing role=customer)
 * - Session revocation (logout)
 */
class AuthService {
  constructor({
    userRepo = new UserRepository(),
    customerRepo = new CustomerRepository(),
    sms = new Msg91Provider(),
    firebase = firebaseAuthService,
    redis = redisService,
    s3 = s3Provider,
  } = {}) {
    this.userRepository = userRepo;
    this.customerRepository = customerRepo;
    this.smsProvider = sms;
    this.firebaseAuthService = firebase;
    this.redisService = redis;
    this.s3Provider = s3;
  }

  /**
   * Sends an OTP to the customer's phone number.
   * Enforces layered rate limits (per-phone and per-IP) and cooldown.
   *
   * @param {object} params
   * @param {string} params.countryCode - International country code (e.g. "+91")
   * @param {string} params.phone - 10-digit mobile number
   * @param {string} params.ipAddress - Client IP for abuse prevention
   * @returns {Promise<{ verificationId: string, expiresIn: number, resendAfter: number }>}
   */
  async sendOtp({ countryCode, phone, ipAddress }) {
    // 1. Normalize and validate phone format
    const normalized = otpService.normalizePhone(countryCode, phone);
    const phoneId = `${normalized.countryCode}:${normalized.phone}`;

    // 2. Check resend cooldown
    const inCooldown = await this.redisService.isPhoneInCooldown(phoneId);
    if (inCooldown) {
      throw new TooManyRequestsError(
        'Please wait before requesting another OTP code',
        'AUTH_COOLDOWN_ACTIVE',
      );
    }

    // 3. Layered Rate Limiting: Per-phone limit
    const phoneLimit = await this.redisService.checkRateLimit(
      'phone',
      phoneId,
      env.AUTH_RATE_LIMIT_PHONE_MAX,
      env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!phoneLimit.allowed) {
      logger.warn('Phone OTP rate limit exceeded', {
        phoneMasked: normalized.phone.replace(/\d(?=\d{4})/g, '*'),
      });
      throw new TooManyRequestsError(
        'Too many OTP requests for this phone number. Please try again later.',
        'AUTH_RATE_LIMITED',
      );
    }

    // 4. Layered Rate Limiting: Per-IP limit
    const ipIdentifier = String(ipAddress || 'unknown').trim();
    const ipLimit = await this.redisService.checkRateLimit(
      'ip',
      ipIdentifier,
      env.AUTH_RATE_LIMIT_IP_MAX,
      env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!ipLimit.allowed) {
      logger.warn('IP OTP rate limit exceeded', { ip: ipIdentifier });
      throw new TooManyRequestsError(
        'Too many requests from this network. Please try again later.',
        'AUTH_RATE_LIMITED',
      );
    }

    // 5. Generate cryptographically secure 6-digit OTP and unique verificationId
    const otp = otpService.generateOtp();
    const verificationId = otpService.generateVerificationId();
    const hashedOtp = otpService.hashOtp(otp);

    // 6. Store temporary verification state in Redis (never plaintext OTP)
    await this.redisService.setOtpState(
      verificationId,
      {
        countryCode: normalized.countryCode,
        phone: normalized.phone,
        hashedOtp,
        createdAt: Date.now(),
      },
      env.AUTH_OTP_EXPIRY_SECONDS,
    );

    // 7. Set cooldown in Redis
    await this.redisService.setPhoneCooldown(phoneId, env.AUTH_OTP_RESEND_SECONDS);

    // 8. Dispatch OTP via SMS Provider
    await this.smsProvider.sendOtp({
      mobile: normalized.fullNumber,
      otp,
      countryCode: normalized.countryCode,
    });

    // 9. Return verification metadata — NEVER return the OTP
    return {
      verificationId,
      expiresIn: env.AUTH_OTP_EXPIRY_SECONDS,
      resendAfter: env.AUTH_OTP_RESEND_SECONDS,
    };
  }

  /**
   * Verifies an OTP, provisions/finds the customer, and mints a Firebase Custom Token.
   *
   * Uses atomic Redis operations to prevent TOCTOU races:
   * - Attempt counter uses dedicated INCR key (fully atomic, no read-modify-write)
   * - OTP state is consumed via Lua GET+DEL (only one concurrent winner)
   *
   * @param {object} params
   * @param {string} params.verificationId - Verification session UUID
   * @param {string} params.otp - 6-digit OTP code entered by user
   * @returns {Promise<object>} Authentication result with tokens and user entity
   */
  async verifyOtp({ verificationId, otp }) {
    // 1. Atomically check attempt count BEFORE doing anything else.
    //    Uses dedicated counter key — concurrent reads all see the latest count.
    const currentAttempts = await this.redisService.getOtpAttemptCount(verificationId);

    // 2. Reject immediately if already at/above max attempts (state may already be deleted)
    if (currentAttempts >= env.AUTH_OTP_MAX_ATTEMPTS) {
      // Invalidate the OTP state so it cannot be verified
      const otpKey = this.redisService.getKey('otp', verificationId);
      await this.redisService.client.del(otpKey);
      throw new BadRequestError(
        'Maximum verification attempts exceeded. Please request a new OTP.',
        'AUTH_OTP_ATTEMPTS_EXCEEDED',
      );
    }

    // 3. Peek at OTP state to read metadata and validate existence —
    //    do NOT delete yet; consumption is atomic below.
    const state = await this.redisService.getOtpState(verificationId);
    if (!state) {
      throw new BadRequestError(
        'OTP has expired or verification session is invalid. Please request a new code.',
        'AUTH_OTP_EXPIRED',
      );
    }

    // 4. Constant-time comparison of hashed OTP
    const isValid = otpService.verifyOtpHash(otp, state.hashedOtp);

    if (!isValid) {
      // Atomically increment dedicated attempt counter (INCR — no race)
      const newCount = await this.redisService.incrementOtpAttempts(verificationId);
      if (newCount >= env.AUTH_OTP_MAX_ATTEMPTS) {
        // Invalidate the OTP state so it cannot be used again
        const otpKey = this.redisService.getKey('otp', verificationId);
        await this.redisService.client.del(otpKey);
        throw new BadRequestError(
          'Maximum verification attempts exceeded. Please request a new OTP.',
          'AUTH_OTP_ATTEMPTS_EXCEEDED',
        );
      }
      throw new BadRequestError('Invalid OTP code. Please check and try again.', 'AUTH_INVALID_OTP');
    }

    // 5. Atomically consume OTP state via Lua GET+DEL — only ONE concurrent
    //    winner can get the state; all others receive null and fail.
    const consumed = await this.redisService.consumeOtpState(verificationId);
    if (!consumed) {
      // Another concurrent request won the race — this request loses
      throw new BadRequestError(
        'OTP has already been used or has expired. Please request a new code.',
        'AUTH_OTP_EXPIRED',
      );
    }

    // 6. Clean up the attempt counter key (consumed state cannot be retried)
    await this.redisService.cleanupOtpSession(verificationId);

    // 7. Resolve or create customer in PostgreSQL
    let user = await this.userRepository.findByPhone(consumed.countryCode, consumed.phone);

    if (user) {
      if (!user.isActive) {
        throw new ForbiddenError(
          'Your account has been deactivated. Please contact support.',
          'AUTH_USER_INACTIVE',
        );
      }

      // Ensure user has auth_id
      if (!user.authId) {
        const authId = `gongo_cust_${crypto.randomUUID()}`;
        user = await this.userRepository.update(user.id, { authId });
      }
    } else {
      // Create new customer record
      // ROLE IS STRICTLY 'customer' — client cannot influence or choose role
      const authId = `gongo_cust_${crypto.randomUUID()}`;
      user = await this.userRepository.create({
        role: 'customer',
        countryCode: consumed.countryCode,
        phone: consumed.phone,
        authProvider: 'firebase',
        authId,
        isActive: true,
      });

      logger.info('New customer account created via OTP verification', {
        userId: user.id,
      });
    }

    // 8. Mint Firebase Custom Token using Firebase Admin SDK
    const customToken = await this.firebaseAuthService.createCustomToken(user.authId, {
      gongoUserId: user.id,
      role: 'customer',
    });

    return {
      customToken,
      accessToken: customToken,
      tokenType: 'Bearer',
      user: {
        id: user.id,
        role: 'customer',
        phone: user.phone,
        countryCode: user.countryCode,
        name: user.name,
        email: user.email,
        isProfileComplete: Boolean(user.name && (user.phone || user.email)),
      },
    };
  }

  /**
   * Session keepalive endpoint — architecture notice.
   *
   * This GONGO backend uses Firebase Authentication with Custom Tokens
   * (Option B architecture). The token lifecycle is managed entirely by the
   * Firebase Client SDK on the device:
   *
   *   1. Client calls POST /auth/verify-otp → receives a Firebase Custom Token
   *   2. Client exchanges it via Firebase Client SDK signInWithCustomToken()
   *      → receives a Firebase ID Token (60 min TTL) + opaque Refresh Token
   *   3. Client SDK automatically refreshes the ID Token using the Refresh Token
   *      before it expires — no backend call required
   *
   * This backend CANNOT:
   *   - Accept Google/Firebase Refresh Tokens (opaque; only Firebase STS can process)
   *   - Refresh an expired Firebase ID Token (verifyIdToken rejects expired tokens)
   *   - Mint new tokens from scratch without re-running the OTP flow
   *
   * Therefore this endpoint accepts a VALID (non-expired) Firebase ID Token,
   * verifies it, and returns a new Firebase Custom Token the client can exchange
   * for a fresh session. This covers the case where a client needs a new custom
   * token after its ID token was revoked (e.g. after a forced logout + re-auth).
   *
   * If the token is expired, the client must re-authenticate via POST /auth/send-otp.
   *
   * @param {object} params
   * @param {string} params.token - Valid Firebase ID Token
   * @returns {Promise<object>} New custom token + advisory message
   */
  async refreshSession({ token }) {
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedError('Authentication token is required for refresh', 'AUTH_MISSING_CREDENTIAL');
    }

    // Verify the presented ID token — rejects expired tokens
    const decoded = await this.firebaseAuthService.verifyIdToken(token);

    // Resolve user from database using Firebase UID (primary identity key)
    const user = await this.userRepository.findByAuthId('firebase', decoded.uid);
    if (!user) {
      throw new UnauthorizedError('User account not found', 'AUTH_USER_NOT_FOUND');
    }

    if (!user.isActive) {
      throw new ForbiddenError('Account is inactive', 'AUTH_USER_INACTIVE');
    }

    // Check if session was revoked in Redis
    const tokenIssuedAtMs = decoded.auth_time * 1000;
    const isRevoked = await this.redisService.isUserSessionRevoked(user.id, tokenIssuedAtMs);
    if (isRevoked) {
      throw new UnauthorizedError('Session has been revoked. Please log in again.', 'AUTH_SESSION_REVOKED');
    }

    // Do NOT mint arbitrary replacement tokens.
    // Return a safe response documenting the required Firebase Client SDK flow.
    return {
      clientRefreshRequired: true,
      message: 'Firebase ID tokens are refreshed automatically by the Firebase Client SDK on the client device. Server-side token refresh is not supported.',
      clientFlow: {
        step1: 'Call Firebase Client SDK auth.currentUser.getIdToken(true) on the client device to receive a fresh ID token.',
        step2: 'Use the fresh ID token in Authorization: Bearer <idToken> headers for subsequent backend API requests.',
      },
    };
  }

  /**
   * Retrieves current authenticated user profile.
   *
   * @param {string} userId - User UUID from verified authentication middleware
   * @returns {Promise<object>}
   */
  async getMe(userId) {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new UnauthorizedError('User account not found', 'AUTH_USER_NOT_FOUND');
    }

    if (!user.isActive) {
      throw new ForbiddenError('Account is inactive', 'AUTH_USER_INACTIVE');
    }

    let avatarUrl = null;
    try {
      const customer = await this.customerRepository.findById(userId);
      if (customer && customer.avatarStorageKey) {
        const presigned = await this.s3Provider.createPresignedGetUrl({
          key: customer.avatarStorageKey,
        });
        avatarUrl = presigned.downloadUrl;
        if (avatarUrl && customer.updatedAt) {
          avatarUrl += (avatarUrl.includes('?') ? '&' : '?') + `v=${new Date(customer.updatedAt).getTime()}`;
        }
      }
    } catch (_photoErr) {
      avatarUrl = null;
    }

    let customerReference = user.customerReference || user.customer_reference || null;
    if (!customerReference && (!user.role || String(user.role).toLowerCase() === 'customer')) {
      try {
        const { generateUniqueEntityReference } = require('../utils/reference-generator');
        customerReference = await generateUniqueEntityReference(this.userRepository, 'users', 'customer_reference', 'CUS');
        await this.userRepository.update(userId, { customerReference });
      } catch (_refErr) {
        // Fallback safely
      }
    }

    return {
      id: user.id,
      customerReference: customerReference || null,
      role: user.role,
      name: user.name,
      countryCode: user.countryCode,
      phone: user.phone,
      email: user.email,
      avatarUrl: avatarUrl || null,
      profileImage: avatarUrl || null,
      profilePhoto: avatarUrl || null,
      isProfileComplete: Boolean(user.name && (user.phone || user.email)),
      createdAt: user.createdAt,
    };
  }

  /**
   * Logs out user by revoking Firebase refresh tokens and registering Redis revocation timestamp.
   *
   * @param {object} authenticatedUser - req.user object
   * @param {string|null} [rawToken] - Presented bearer token; its Redis session is deleted
   * @returns {Promise<void>}
   */
  async logout(authenticatedUser, rawToken = null) {
    if (!authenticatedUser || !authenticatedUser.id) {
      return;
    }

    // 1. Revoke Firebase refresh tokens
    if (authenticatedUser.authId) {
      await this.firebaseAuthService.revokeRefreshTokens(authenticatedUser.authId);
    }

    // 2. Delete the presented backend session outright
    if (rawToken) {
      try {
        await this.redisService.client.del(`auth:session:${rawToken}`);
      } catch (err) {
        logger.warn('Failed to delete Redis session on logout', { code: err.code || 'REDIS_ERROR' });
      }
    }

    // 3. Invalidate any other in-flight sessions issued before now.
    // Keep the marker for the full 30-day session lifetime so old tokens cannot revive.
    await this.redisService.revokeUserSession(authenticatedUser.id, 30 * 24 * 3600);

    logger.info('User logged out successfully', {
      userId: authenticatedUser.id,
    });
  }
}

module.exports = new AuthService();
