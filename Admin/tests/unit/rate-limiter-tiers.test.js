'use strict';

const {
  getClientIp,
  adminApiLimiter,
  authLimiter,
  sensitiveOpLimiter,
  expensiveQueryLimiter,
  createRateLimiter,
} = require('../../src/middlewares/rateLimiter');

describe('Unit: Rate Limiter Tiers & IP Spoofing Prevention', () => {
  describe('1. getClientIp Safety', () => {
    it('uses socket.remoteAddress directly when TRUST_PROXY is false', () => {
      const req = {
        socket: { remoteAddress: '192.168.1.50' },
        headers: { 'x-forwarded-for': '203.0.113.195' }, // Attacker trying to spoof IP
      };

      const ip = getClientIp(req);
      // In production/default TRUST_PROXY=false, x-forwarded-for header must be ignored
      expect(ip).toBe('192.168.1.50');
    });

    it('falls back to 127.0.0.1 if socket address is missing', () => {
      const req = {};
      const ip = getClientIp(req);
      expect(ip).toBe('127.0.0.1');
    });
  });

  describe('2. Rate Limiter Tiers Exported', () => {
    it('exports all designated security limiters', () => {
      expect(typeof adminApiLimiter).toBe('function');
      expect(typeof authLimiter).toBe('function');
      expect(typeof sensitiveOpLimiter).toBe('function');
      expect(typeof expensiveQueryLimiter).toBe('function');
    });

    it('sets Retry-After header and returns 429 when max limit is exceeded in memory fallback', async () => {
      const limiter = createRateLimiter({
        max: 2,
        windowMs: 5000,
        prefix: 'rl:test:mem',
      });

      const req = { socket: { remoteAddress: '10.99.88.77' } };
      const headers = {};
      const res = {
        setHeader: (k, v) => {
          headers[k] = v;
        },
      };

      let err1;
      let err2;
      let err3;

      await limiter(req, res, (e) => { err1 = e; });
      expect(err1).toBeUndefined();
      expect(headers['X-RateLimit-Remaining']).toBe(1);

      await limiter(req, res, (e) => { err2 = e; });
      expect(err2).toBeUndefined();
      expect(headers['X-RateLimit-Remaining']).toBe(0);

      await limiter(req, res, (e) => { err3 = e; });
      expect(err3).toBeDefined();
      expect(err3.statusCode).toBe(429);
      expect(headers['Retry-After']).toBeDefined();
      expect(headers['Retry-After']).toBeGreaterThanOrEqual(1);
    });
  });
});
