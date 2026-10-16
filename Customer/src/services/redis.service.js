'use strict';

const { redisClient, logger, env } = require('../config');
const { ServiceUnavailableError } = require('../errors');

/**
 * Service managing namespaced Redis operations for authentication state,
 * OTP lifecycle, rate limiting, and session revocation.
 */
class RedisService {
  constructor(client = redisClient) {
    this.client = client;
    this.prefix = 'gongo:auth';
  }

  /**
   * Helper to format Redis keys with proper namespacing.
   *
   * @param {string} namespace
   * @param {string} identifier
   * @returns {string}
   */
  getKey(namespace, identifier) {
    return `${this.prefix}:${namespace}:${identifier}`;
  }

  /**
   * Stores an OTP verification state with TTL.
   *
   * @param {string} verificationId
   * @param {object} data - OTP metadata (phone, countryCode, hashedOtp, etc.)
   * @param {number} ttlSeconds
   * @returns {Promise<void>}
   */
  async setOtpState(verificationId, data, ttlSeconds = env.AUTH_OTP_EXPIRY_SECONDS) {
    const key = this.getKey('otp', verificationId);
    try {
      const serialized = JSON.stringify(data);
      await this.client.set(key, serialized, 'EX', ttlSeconds);
    } catch (err) {
      logger.error('Failed to write OTP state to Redis', { code: err.code || 'REDIS_ERROR' });
      throw new ServiceUnavailableError('Authentication service temporarily unavailable', 'REDIS_UNAVAILABLE');
    }
  }

  /**
   * Retrieves OTP verification state.
   *
   * @param {string} verificationId
   * @returns {Promise<object|null>}
   */
  async getOtpState(verificationId) {
    const key = this.getKey('otp', verificationId);
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      logger.error('Failed to read OTP state from Redis', { code: err.code || 'REDIS_ERROR' });
      throw new ServiceUnavailableError('Authentication service temporarily unavailable', 'REDIS_UNAVAILABLE');
    }
  }

  /**
   * Atomically increments the attempt counter for an OTP session.
   *
   * Uses a DEDICATED Redis counter key (gongo:auth:attempts:<verificationId>)
   * with INCR — fully atomic, no read-modify-write race possible.
   *
   * The counter TTL is set once on the first increment and matches the OTP
   * expiry window so counters are automatically cleaned up.
   *
   * If Redis fails, throws ServiceUnavailableError — failing CLOSED to prevent
   * brute-force attacks from bypassing the attempt limit.
   *
   * @param {string} verificationId
   * @param {number} [ttlSeconds] - TTL to apply on first increment (must match OTP expiry)
   * @returns {Promise<number>} New attempt count after increment
   */
  async incrementOtpAttempts(verificationId, ttlSeconds = env.AUTH_OTP_EXPIRY_SECONDS) {
    const counterKey = this.getKey('attempts', verificationId);
    try {
      const count = await this.client.incr(counterKey);
      if (count === 1) {
        // Set TTL only on the first increment — avoids resetting an existing TTL
        await this.client.expire(counterKey, ttlSeconds);
      }
      return count;
    } catch (err) {
      logger.error('Failed to increment OTP attempt counter — failing closed', {
        code: err.code || 'REDIS_ERROR',
      });
      // Fail closed: treat as max attempts reached to prevent brute-force bypass
      throw new ServiceUnavailableError('Authentication service temporarily unavailable', 'REDIS_UNAVAILABLE');
    }
  }

  /**
   * Returns the current OTP attempt count without incrementing.
   *
   * @param {string} verificationId
   * @returns {Promise<number>} Current attempt count (0 if key not found)
   */
  async getOtpAttemptCount(verificationId) {
    const counterKey = this.getKey('attempts', verificationId);
    try {
      const raw = await this.client.get(counterKey);
      return raw ? parseInt(raw, 10) : 0;
    } catch (err) {
      logger.error('Failed to read OTP attempt counter — failing closed', {
        code: err.code || 'REDIS_ERROR',
      });
      throw new ServiceUnavailableError('Authentication service temporarily unavailable', 'REDIS_UNAVAILABLE');
    }
  }

  /**
   * Atomically consumes (gets + deletes) an OTP state key.
   *
   * Uses a Lua script to GET and DEL the key as a single atomic operation,
   * preventing TOCTOU races where multiple concurrent requests could each
   * read the state before any of them deletes it.
   *
   * Only ONE concurrent caller wins — all others receive null.
   *
   * @param {string} verificationId
   * @returns {Promise<object|null>} OTP state if successfully consumed, null if already gone
   */
  async consumeOtpState(verificationId) {
    const key = this.getKey('otp', verificationId);

    // Atomic Lua: GET the value then DEL the key in one round-trip.
    // If two requests race, exactly one gets the value; the other gets nil.
    const luaScript = "local val = redis.call('GET', KEYS[1])\nif val then\n  redis.call('DEL', KEYS[1])\nend\nreturn val";

    try {
      const raw = await this.client.eval(luaScript, 1, key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      logger.error('Failed to atomically consume OTP state from Redis', { code: err.code || 'REDIS_ERROR' });
      throw new ServiceUnavailableError('Authentication service temporarily unavailable', 'REDIS_UNAVAILABLE');
    }
  }

  /**
   * Cleans up all OTP-related keys for a verification session.
   * Called when a session is fully consumed or invalidated.
   *
   * @param {string} verificationId
   * @returns {Promise<void>}
   */
  async cleanupOtpSession(verificationId) {
    const otpKey = this.getKey('otp', verificationId);
    const counterKey = this.getKey('attempts', verificationId);
    try {
      await this.client.del(otpKey, counterKey);
    } catch (err) {
      // Best-effort cleanup — log and continue
      logger.error('Failed to cleanup OTP session keys from Redis', { code: err.code || 'REDIS_ERROR' });
    }
  }

  /**
   * Backwards-compatible alias for cleanupOtpSession.
   *
   * @param {string} verificationId
   * @returns {Promise<void>}
   */
  async deleteOtpState(verificationId) {
    return this.cleanupOtpSession(verificationId);
  }

  /**
   * Sets resend cooldown for a phone number.
   *
   * @param {string} phoneIdentifier - countryCode + phone
   * @param {number} cooldownSeconds
   * @returns {Promise<void>}
   */
  async setPhoneCooldown(phoneIdentifier, cooldownSeconds = env.AUTH_OTP_RESEND_SECONDS) {
    const key = this.getKey('cooldown', phoneIdentifier);
    try {
      await this.client.set(key, '1', 'EX', cooldownSeconds);
    } catch (err) {
      logger.error('Failed to set phone cooldown in Redis', { code: err.code || 'REDIS_ERROR' });
    }
  }

  /**
   * Checks if phone number is in cooldown.
   *
   * @param {string} phoneIdentifier
   * @returns {Promise<boolean>}
   */
  async isPhoneInCooldown(phoneIdentifier) {
    const key = this.getKey('cooldown', phoneIdentifier);
    try {
      const exists = await this.client.exists(key);
      return exists === 1;
    } catch (err) {
      logger.error('Failed to check phone cooldown in Redis', { code: err.code || 'REDIS_ERROR' });
      return false; // Non-blocking for cooldown check
    }
  }

  /**
   * Increments rate limit counter and checks against limit.
   * Uses Redis atomic INCR + EXPIRE.
   *
   * @param {string} namespace - 'phone' | 'ip'
   * @param {string} identifier - Phone number or IP
   * @param {number} maxRequests - Maximum allowed requests in window
   * @param {number} windowSeconds - Sliding window in seconds
   * @returns {Promise<{ allowed: boolean, current: number, remaining: number }>}
   */
  async checkRateLimit(namespace, identifier, maxRequests, windowSeconds) {
    const key = this.getKey(`rate:${namespace}`, identifier);
    try {
      const current = await this.client.incr(key);
      if (current === 1) {
        await this.client.expire(key, windowSeconds);
      }

      const allowed = current <= maxRequests;
      const remaining = Math.max(0, maxRequests - current);

      return { allowed, current, remaining };
    } catch (err) {
      logger.error('Rate limiter Redis error — failing closed', {
        namespace,
        code: err.code || 'REDIS_ERROR',
      });
      // Fail closed for security
      throw new ServiceUnavailableError('Rate limit verification unavailable', 'REDIS_UNAVAILABLE');
    }
  }

  /**
   * Marks a user session / tokens as revoked (for logout).
   *
   * @param {string} userId
   * @param {number} [ttlSeconds=3600] - Invalidation duration matching token lifetime
   * @returns {Promise<void>}
   */
  async revokeUserSession(userId, ttlSeconds = 3600) {
    const key = this.getKey('revoked', userId);
    try {
      await this.client.set(key, String(Date.now()), 'EX', ttlSeconds);
    } catch (err) {
      logger.error('Failed to set revocation timestamp in Redis', { code: err.code || 'REDIS_ERROR' });
    }
  }

  /**
   * Checks whether a user's session was revoked.
   *
   * SECURITY: Fails CLOSED on Redis errors — a Redis failure must NOT allow
   * revoked (logged-out) users to regain access. Protected routes depend on
   * this check to enforce logout. If Redis is unavailable, callers must reject
   * the request with 503 (ServiceUnavailable).
   *
   * Note: Firebase Admin SDK verifyIdToken(token, checkRevoked=true) also
   * checks Firebase-side revocation independently as a second layer.
   * However, application-level revocation (logout flow) depends solely on
   * this Redis check.
   *
   * @param {string} userId
   * @param {number} tokenIssuedAtMs - Timestamp when token was issued
   * @returns {Promise<boolean>} True if revoked after token issuance
   * @throws {ServiceUnavailableError} If Redis is unavailable (fail-closed)
   */
  async isUserSessionRevoked(userId, tokenIssuedAtMs) {
    const key = this.getKey('revoked', userId);
    try {
      const revokedAtStr = await this.client.get(key);
      if (!revokedAtStr) return false;

      const revokedAt = parseInt(revokedAtStr, 10);
      return revokedAt >= tokenIssuedAtMs;
    } catch (err) {
      logger.error('Failed to check user revocation in Redis — failing closed', {
        code: err.code || 'REDIS_ERROR',
      });
      // Fail CLOSED: do not allow revoked sessions to pass when Redis is down
      throw new ServiceUnavailableError(
        'Session verification temporarily unavailable. Please try again.',
        'REDIS_UNAVAILABLE',
      );
    }
  }
}

module.exports = new RedisService();
