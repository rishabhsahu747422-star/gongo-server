'use strict';

const redisService = require('../../../src/services/redis.service');

describe('RedisService Unit Tests', () => {
  const testVerificationId = 'test-uuid-verification-1234';

  afterEach(async () => {
    await redisService.deleteOtpState(testVerificationId);
  });

  describe('OTP State Management', () => {
    it('should store and retrieve OTP state correctly', async () => {
      const stateData = {
        phone: '9876543210',
        countryCode: '+91',
        hashedOtp: 'test-hash-string',
        attempts: 0,
        createdAt: Date.now(),
      };

      await redisService.setOtpState(testVerificationId, stateData, 60);

      const retrieved = await redisService.getOtpState(testVerificationId);
      expect(retrieved).toBeDefined();
      expect(retrieved.phone).toBe('9876543210');
      expect(retrieved.hashedOtp).toBe('test-hash-string');
      expect(retrieved.attempts).toBe(0);
    });

    it('should return null for non-existent or expired verification ID', async () => {
      const state = await redisService.getOtpState('non-existent-id');
      expect(state).toBeNull();
    });

    it('should increment attempt counter on OTP state atomically using dedicated key', async () => {
      await redisService.setOtpState(testVerificationId, {
        phone: '9876543210',
        hashedOtp: 'hash',
      }, 60);

      const attempts1 = await redisService.incrementOtpAttempts(testVerificationId);
      expect(attempts1).toBe(1);

      const attempts2 = await redisService.incrementOtpAttempts(testVerificationId);
      expect(attempts2).toBe(2);

      const count = await redisService.getOtpAttemptCount(testVerificationId);
      expect(count).toBe(2);
    });

    it('should atomically consume OTP state via Lua script (single-use)', async () => {
      await redisService.setOtpState(testVerificationId, { hashedOtp: 'hash' }, 60);
      const consumed = await redisService.consumeOtpState(testVerificationId);
      expect(consumed).toBeDefined();
      expect(consumed.hashedOtp).toBe('hash');

      // Second consumption must fail (already consumed and deleted)
      const secondTry = await redisService.consumeOtpState(testVerificationId);
      expect(secondTry).toBeNull();
    });

    it('should delete OTP state upon cleanup', async () => {
      await redisService.setOtpState(testVerificationId, { hashedOtp: 'hash' }, 60);
      await redisService.cleanupOtpSession(testVerificationId);

      const state = await redisService.getOtpState(testVerificationId);
      expect(state).toBeNull();
    });
  });

  describe('Rate Limiting', () => {
    it('should allow requests within the limit and block when exceeded', async () => {
      const testIdentifier = 'test-user-rate-phone';
      const maxRequests = 3;
      const windowSeconds = 60;

      const r1 = await redisService.checkRateLimit('phone', testIdentifier, maxRequests, windowSeconds);
      expect(r1.allowed).toBe(true);
      expect(r1.current).toBe(1);
      expect(r1.remaining).toBe(2);

      const r2 = await redisService.checkRateLimit('phone', testIdentifier, maxRequests, windowSeconds);
      expect(r2.allowed).toBe(true);
      expect(r2.current).toBe(2);

      const r3 = await redisService.checkRateLimit('phone', testIdentifier, maxRequests, windowSeconds);
      expect(r3.allowed).toBe(true);
      expect(r3.current).toBe(3);
      expect(r3.remaining).toBe(0);

      const r4 = await redisService.checkRateLimit('phone', testIdentifier, maxRequests, windowSeconds);
      expect(r4.allowed).toBe(false);
      expect(r4.current).toBe(4);
      expect(r4.remaining).toBe(0);
    });
  });

  describe('Session Revocation', () => {
    it('should record user session revocation and identify revoked tokens', async () => {
      const testUserId = 'user-uuid-12345';
      const tokenIssuedAt = Date.now();

      expect(await redisService.isUserSessionRevoked(testUserId, tokenIssuedAt)).toBe(false);

      // Revoke user session
      await redisService.revokeUserSession(testUserId, 60);

      // A token issued before revocation is now detected as revoked
      expect(await redisService.isUserSessionRevoked(testUserId, tokenIssuedAt - 1000)).toBe(true);
    });
  });
});
