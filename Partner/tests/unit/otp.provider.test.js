'use strict';

const otpProvider = require('../../src/providers/otp.provider');
const { redisClient } = require('../../src/providers/redis');

describe('Unit: OtpProvider', () => {
  const bookingId = '11111111-2222-3333-4444-555555555555';

  beforeEach(async () => {
    await redisClient.flushall();
  });

  afterAll(async () => {
    await redisClient.flushall();
  });

  describe('generateOtp', () => {
    it('generates a 4-digit numeric string by default', () => {
      const otp = otpProvider.generateOtp();
      expect(typeof otp).toBe('string');
      expect(otp).toHaveLength(4);
      expect(/^\d{4}$/.test(otp)).toBe(true);
    });

    it('generates a 6-digit numeric string when requested', () => {
      const otp = otpProvider.generateOtp(6);
      expect(typeof otp).toBe('string');
      expect(otp).toHaveLength(6);
      expect(/^\d{6}$/.test(otp)).toBe(true);
    });

    it('generates random codes across multiple invocations', () => {
      const codes = new Set();
      for (let i = 0; i < 20; i += 1) {
        codes.add(otpProvider.generateOtp());
      }
      expect(codes.size).toBeGreaterThan(1);
    });
  });

  describe('generateSalt and hashOtp', () => {
    it('generates a 32-character hex salt by default', () => {
      const salt = otpProvider.generateSalt();
      expect(typeof salt).toBe('string');
      expect(salt).toHaveLength(32);
    });

    it('generates a 64-character SHA-256 hex hash', () => {
      const salt = otpProvider.generateSalt();
      const hash = otpProvider.hashOtp('4829', salt);
      expect(typeof hash).toBe('string');
      expect(hash).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    });

    it('produces distinct hashes for different salts with identical OTP', () => {
      const salt1 = otpProvider.generateSalt();
      const salt2 = otpProvider.generateSalt();
      const hash1 = otpProvider.hashOtp('1234', salt1);
      const hash2 = otpProvider.hashOtp('1234', salt2);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyOtp', () => {
    it('returns true when candidate matches stored hash with identical salt', () => {
      const salt = otpProvider.generateSalt();
      const hash = otpProvider.hashOtp('5829', salt);
      const isValid = otpProvider.verifyOtp('5829', hash, salt);
      expect(isValid).toBe(true);
    });

    it('returns false when candidate OTP does not match', () => {
      const salt = otpProvider.generateSalt();
      const hash = otpProvider.hashOtp('5829', salt);
      const isValid = otpProvider.verifyOtp('9999', hash, salt);
      expect(isValid).toBe(false);
    });

    it('returns false when salt is incorrect', () => {
      const salt1 = otpProvider.generateSalt();
      const salt2 = otpProvider.generateSalt();
      const hash = otpProvider.hashOtp('5829', salt1);
      const isValid = otpProvider.verifyOtp('5829', hash, salt2);
      expect(isValid).toBe(false);
    });

    it('handles empty or missing parameters safely', () => {
      expect(otpProvider.verifyOtp(null, 'hash', 'salt')).toBe(false);
      expect(otpProvider.verifyOtp('1234', null, 'salt')).toBe(false);
      expect(otpProvider.verifyOtp('1234', 'hash', null)).toBe(false);
    });
  });

  describe('Redis attempt tracking and state lifecycle', () => {
    it('stores and retrieves OTP state in Redis', async () => {
      const salt = otpProvider.generateSalt();
      const hash = otpProvider.hashOtp('4321', salt);

      await otpProvider.storeOtpState(bookingId, { otpHash: hash, salt }, 60);
      const state = await otpProvider.getOtpState(bookingId);

      expect(state).toBeDefined();
      expect(state.otpHash).toBe(hash);
      expect(state.salt).toBe(salt);
    });

    it('tracks and increments failed attempts', async () => {
      expect(await otpProvider.getAttempts(bookingId)).toBe(0);

      const a1 = await otpProvider.incrementAttempts(bookingId);
      expect(a1).toBe(1);

      const a2 = await otpProvider.incrementAttempts(bookingId);
      expect(a2).toBe(2);

      expect(await otpProvider.getAttempts(bookingId)).toBe(2);
    });

    it('clears OTP state and attempts upon clearOtpState', async () => {
      await otpProvider.storeOtpState(bookingId, { otpHash: 'h', salt: 's' });
      await otpProvider.incrementAttempts(bookingId);

      await otpProvider.clearOtpState(bookingId);

      expect(await otpProvider.getOtpState(bookingId)).toBeNull();
      expect(await otpProvider.getAttempts(bookingId)).toBe(0);
    });
  });
});
