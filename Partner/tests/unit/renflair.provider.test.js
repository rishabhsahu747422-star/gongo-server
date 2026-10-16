'use strict';

const renflairProvider = require('../../src/providers/renflair.provider');
const env = require('../../src/config/env');

describe('Unit: Renflair SMS Gateway Provider', () => {
  const originalFetch = global.fetch;
  const mockPhone = '9876543210';
  const mockOtp = '654321';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('1. Phone & OTP Input Validation & Sanitization', () => {
    it('masks phone numbers safely for logging and errors', () => {
      expect(renflairProvider.maskPhone('9876543210')).toBe('98****3210');
      expect(renflairProvider.maskPhone('+919876543210')).toBe('+9****3210');
      expect(renflairProvider.maskPhone('')).toBe('****');
      expect(renflairProvider.maskPhone(null)).toBe('****');
    });

    it('sanitizes provider error messages without leaking phone or API keys', () => {
      const msg = 'Failed sending to 9876543210 with API=secret_key_123&OTP=123456';
      const clean = renflairProvider.sanitizeMessage(msg, '9876543210');
      expect(clean).toContain('98****3210');
      expect(clean).not.toContain('9876543210');
      expect(clean).toContain('API=[REDACTED]');
      expect(clean).toContain('OTP=[REDACTED]');
    });

    it('rejects invalid or malformed phone numbers with descriptive error', async () => {
      await expect(renflairProvider.sendOtp({ phone: '123', otp: '123456' })).rejects.toThrow(
        /Invalid phone number: 10-digit number required/,
      );
    });

    it('rejects OTP codes that are not exactly 6 digits', async () => {
      await expect(renflairProvider.sendOtp({ phone: mockPhone, otp: '123' })).rejects.toThrow(
        /Invalid OTP: exactly 6 digits required/,
      );
      await expect(renflairProvider.sendOtp({ phone: mockPhone, otp: 'abcdef' })).rejects.toThrow(
        /Invalid OTP: exactly 6 digits required/,
      );
    });
  });

  describe('2. Provider Delivery Success Handling', () => {
    it('dispatches HTTP GET request with documented query parameters and parses success', async () => {
      let requestedUrl = null;
      global.fetch = jest.fn().mockImplementation((url) => {
        requestedUrl = url;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({
            status: 'SUCCESS',
            message: 'SMS SENT TO 9876543210 AND WHATSAPP',
            transaction_id: 'tx_ren_12345',
          })),
        });
      });

      const originalKey = process.env.RENFLAIR_API_KEY;
      process.env.RENFLAIR_API_KEY = 'test_renflair_key';

      try {
        const result = await renflairProvider.sendOtp({ phone: mockPhone, otp: mockOtp });

        expect(result.success).toBe(true);
        expect(result.simulated).toBe(false);
        expect(result.transactionId).toBe('tx_ren_12345');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(requestedUrl).toContain('https://sms.renflair.in/V1.php');
        expect(requestedUrl).toContain('API=test_renflair_key');
        expect(requestedUrl).toContain(`PHONE=${mockPhone}`);
        expect(requestedUrl).toContain(`OTP=${mockOtp}`);
      } finally {
        if (originalKey === undefined) delete process.env.RENFLAIR_API_KEY;
        else process.env.RENFLAIR_API_KEY = originalKey;
      }
    });

    it('accepts valid text success response when JSON is not returned', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('SMS SENT TO 9876543210 SUCCESSFULLY'),
      });

      const originalKey = process.env.RENFLAIR_API_KEY;
      process.env.RENFLAIR_API_KEY = 'test_renflair_key';

      try {
        const result = await renflairProvider.sendOtp({ phone: mockPhone, otp: mockOtp });
        expect(result.success).toBe(true);
        expect(result.simulated).toBe(false);
      } finally {
        if (originalKey === undefined) delete process.env.RENFLAIR_API_KEY;
        else process.env.RENFLAIR_API_KEY = originalKey;
      }
    });
  });

  describe('3. Provider Rejection & Failure Classification', () => {
    it('classifies invalid or incorrect API key and returns safe error message', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          status: 'FAILED',
          message: 'INCORRECT API KEY',
        })),
      });

      const originalKey = process.env.RENFLAIR_API_KEY;
      process.env.RENFLAIR_API_KEY = 'invalid_key';

      try {
        await expect(renflairProvider.sendOtp({ phone: mockPhone, otp: mockOtp })).rejects.toThrow(
          /SMS gateway authentication failed\. Please check provider credentials/,
        );
      } finally {
        if (originalKey === undefined) delete process.env.RENFLAIR_API_KEY;
        else process.env.RENFLAIR_API_KEY = originalKey;
      }
    });

    it('classifies insufficient balance / credits rejection accurately', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          status: 'FAILED',
          message: 'INSUFFICIENT BALANCE',
        })),
      });

      const originalKey = process.env.RENFLAIR_API_KEY;
      process.env.RENFLAIR_API_KEY = 'test_key';

      try {
        await expect(renflairProvider.sendOtp({ phone: mockPhone, otp: mockOtp })).rejects.toThrow(
          /Insufficient SMS credits in Renflair account/,
        );
      } finally {
        if (originalKey === undefined) delete process.env.RENFLAIR_API_KEY;
        else process.env.RENFLAIR_API_KEY = originalKey;
      }
    });

    it('classifies missing or rejected phone number rejection', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          status: 'FAILED',
          message: 'NO PHONE NUMBER FOUND',
        })),
      });

      const originalKey = process.env.RENFLAIR_API_KEY;
      process.env.RENFLAIR_API_KEY = 'test_key';

      try {
        await expect(renflairProvider.sendOtp({ phone: mockPhone, otp: mockOtp })).rejects.toThrow(
          /Invalid recipient phone number/,
        );
      } finally {
        if (originalKey === undefined) delete process.env.RENFLAIR_API_KEY;
        else process.env.RENFLAIR_API_KEY = originalKey;
      }
    });

    it('handles non-200 HTTP statuses from Renflair gateway', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.resolve('Bad Gateway'),
      });

      const originalKey = process.env.RENFLAIR_API_KEY;
      process.env.RENFLAIR_API_KEY = 'test_key';

      try {
        await expect(renflairProvider.sendOtp({ phone: mockPhone, otp: mockOtp })).rejects.toThrow(
          /Renflair SMS delivery failed with HTTP status 502/,
        );
      } finally {
        if (originalKey === undefined) delete process.env.RENFLAIR_API_KEY;
        else process.env.RENFLAIR_API_KEY = originalKey;
      }
    });

    it('handles network timeout (AbortError) with user-friendly message', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      global.fetch = jest.fn().mockRejectedValue(abortError);

      const originalKey = process.env.RENFLAIR_API_KEY;
      process.env.RENFLAIR_API_KEY = 'test_key';

      try {
        await expect(renflairProvider.sendOtp({ phone: mockPhone, otp: mockOtp })).rejects.toThrow(
          /SMS gateway request timed out\. Please try again\./,
        );
      } finally {
        if (originalKey === undefined) delete process.env.RENFLAIR_API_KEY;
        else process.env.RENFLAIR_API_KEY = originalKey;
      }
    });
  });

  describe('4. Missing Credentials Behavior', () => {
    it('returns simulated result in development/test when API key is missing', async () => {
      const originalKey = process.env.RENFLAIR_API_KEY;
      delete process.env.RENFLAIR_API_KEY;

      try {
        const result = await renflairProvider.sendOtp({ phone: mockPhone, otp: mockOtp });
        expect(result.success).toBe(true);
        expect(result.simulated).toBe(true);
      } finally {
        if (originalKey !== undefined) process.env.RENFLAIR_API_KEY = originalKey;
      }
    });

    it('strictly throws error in production when API key is missing', async () => {
      const originalKey = process.env.RENFLAIR_API_KEY;
      const originalNodeEnv = process.env.NODE_ENV;
      delete process.env.RENFLAIR_API_KEY;
      process.env.NODE_ENV = 'production';

      try {
        await expect(renflairProvider.sendOtp({ phone: mockPhone, otp: mockOtp })).rejects.toThrow(
          /SMS service is temporarily unavailable\. Missing provider credentials\./,
        );
      } finally {
        if (originalKey !== undefined) process.env.RENFLAIR_API_KEY = originalKey;
        process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });
});
