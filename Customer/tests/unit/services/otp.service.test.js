'use strict';

const otpService = require('../../../src/services/otp.service');
const { BadRequestError } = require('../../../src/errors');

describe('OtpService Unit Tests', () => {
  describe('generateOtp', () => {
    it('should generate exactly a 6-digit numeric string', () => {
      for (let i = 0; i < 50; i += 1) {
        const otp = otpService.generateOtp();
        expect(typeof otp).toBe('string');
        expect(otp).toHaveLength(6);
        expect(otp).toMatch(/^\d{6}$/);

        const num = parseInt(otp, 10);
        expect(num).toBeGreaterThanOrEqual(100000);
        expect(num).toBeLessThanOrEqual(999999);
      }
    });

    it('should generate non-identical values across invocations', () => {
      const set = new Set();
      for (let i = 0; i < 20; i += 1) {
        set.add(otpService.generateOtp());
      }
      expect(set.size).toBeGreaterThan(1);
    });
  });

  describe('generateVerificationId', () => {
    it('should generate a valid UUID v4', () => {
      const id = otpService.generateVerificationId();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(id).toMatch(uuidRegex);
    });
  });

  describe('hashOtp and verifyOtpHash', () => {
    it('should create a deterministic hex HMAC hash for the same OTP', () => {
      const otp = '123456';
      const hash1 = otpService.hashOtp(otp);
      const hash2 = otpService.hashOtp(otp);

      expect(typeof hash1).toBe('string');
      expect(hash1).toHaveLength(64); // SHA-256 hex length
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(otp); // Never plaintext
    });

    it('should produce different hashes for different OTPs', () => {
      const hash1 = otpService.hashOtp('123456');
      const hash2 = otpService.hashOtp('654321');
      expect(hash1).not.toBe(hash2);
    });

    it('should return true for matching OTP and hash via timing-safe check', () => {
      const otp = '849201';
      const hash = otpService.hashOtp(otp);
      expect(otpService.verifyOtpHash(otp, hash)).toBe(true);
    });

    it('should return false for incorrect OTP', () => {
      const hash = otpService.hashOtp('849201');
      expect(otpService.verifyOtpHash('849202', hash)).toBe(false);
      expect(otpService.verifyOtpHash('000000', hash)).toBe(false);
    });

    it('should return false for empty or null inputs safely without crashing', () => {
      const hash = otpService.hashOtp('849201');
      expect(otpService.verifyOtpHash(null, hash)).toBe(false);
      expect(otpService.verifyOtpHash('', hash)).toBe(false);
      expect(otpService.verifyOtpHash('849201', null)).toBe(false);
    });
  });

  describe('normalizePhone', () => {
    it('should normalize standard 10-digit Indian phone with +91', () => {
      const normalized = otpService.normalizePhone('+91', '9876543210');
      expect(normalized.countryCode).toBe('+91');
      expect(normalized.phone).toBe('9876543210');
      expect(normalized.fullNumber).toBe('919876543210');
    });

    it('should handle countryCode without leading plus', () => {
      const normalized = otpService.normalizePhone('91', '7890123456');
      expect(normalized.countryCode).toBe('+91');
      expect(normalized.phone).toBe('7890123456');
      expect(normalized.fullNumber).toBe('917890123456');
    });

    it('should strip spaces and hyphens from phone number', () => {
      const normalized = otpService.normalizePhone('+91', ' 98765-43210 ');
      expect(normalized.phone).toBe('9876543210');
      expect(normalized.fullNumber).toBe('919876543210');
    });

    it('should reject invalid Indian numbers starting with 0, 1, 2, 3, 4, 5', () => {
      expect(() => otpService.normalizePhone('+91', '1234567890')).toThrow(BadRequestError);
      expect(() => otpService.normalizePhone('+91', '0987654321')).toThrow(BadRequestError);
      expect(() => otpService.normalizePhone('+91', '5555555555')).toThrow(BadRequestError);
    });

    it('should reject Indian numbers with fewer or more than 10 digits', () => {
      expect(() => otpService.normalizePhone('+91', '987654321')).toThrow(BadRequestError);
      expect(() => otpService.normalizePhone('+91', '98765432100')).toThrow(BadRequestError);
    });
  });
});
