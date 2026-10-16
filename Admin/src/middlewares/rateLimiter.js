'use strict';

const { redisClient } = require('../providers/redis');
const { RateLimitError } = require('../errors');
const env = require('../config/env');
const logger = require('../config/logger');

// In-memory bucket storage fallback when Redis is unreachable
const memoryBuckets = new Map();

/**
 * Safely resolves the client IP without trusting arbitrary forwarded headers
 * unless TRUST_PROXY is explicitly enabled.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIp(req) {
  if (env.TRUST_PROXY && req.ip) {
    return req.ip;
  }
  const socketIp = req.socket && req.socket.remoteAddress;
  const connIp = req.connection && req.connection.remoteAddress;
  return socketIp || connIp || req.ip || '127.0.0.1';
}

/**
 * Creates an Express rate-limiting middleware with Redis and memory fallback.
 *
 * @param {object} options
 * @param {number} [options.max] Max allowed requests within sliding window
 * @param {number} [options.windowMs] Duration of sliding window in ms
 * @param {string} [options.prefix] Key prefix
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter(options = {}) {
  const max = options.max || env.RATE_LIMIT_MAX_REQUESTS;
  const windowMs = options.windowMs || env.RATE_LIMIT_WINDOW_MS;
  const windowSec = Math.ceil(windowMs / 1000);
  const prefix = options.prefix || 'rl:admin:general';

  return async function rateLimiter(req, res, next) {
    const ip = getClientIp(req);
    const key = `${prefix}:${ip}`;

    try {
      if (
        redisClient
        && (redisClient.status === 'ready' || env.USE_REDIS_MOCK || env.NODE_ENV === 'test')
      ) {
        const current = await redisClient.incr(key);
        if (current === 1) {
          await redisClient.expire(key, windowSec);
        }

        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, max - current));

        if (current > max) {
          let ttl = windowSec;
          try {
            const redisTtl = await redisClient.ttl(key);
            if (redisTtl > 0) {
              ttl = redisTtl;
            }
          } catch (_) {
            // Use windowSec as fallback
          }
          res.setHeader('Retry-After', ttl);
          return next(new RateLimitError());
        }
        return next();
      }
    } catch (err) {
      logger.warn('Redis rate limiter unreachable, using memory fallback', { error: err.message });
    }

    // In-memory fallback
    const now = Date.now();
    const bucket = memoryBuckets.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    memoryBuckets.set(key, bucket);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));

    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', retryAfterSec);
      return next(new RateLimitError());
    }

    return next();
  };
}

/**
 * Clearly defined rate limiter security tiers for administrative surfaces:
 *
 * 1. General Admin API traffic (default: 300 req / 15 min or env configured)
 * 2. Auth-related endpoints (10 req / 15 min to prevent brute force)
 * 3. Sensitive operations (30 req / 15 min for permissions, settings, payouts)
 * 4. Expensive read-heavy endpoints (20 req / 1 min for reporting/bulk queries)
 */
const adminApiLimiter = createRateLimiter({
  max: env.RATE_LIMIT_MAX_REQUESTS || 300,
  windowMs: env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
  prefix: 'rl:admin:general',
});

const authLimiter = createRateLimiter({
  max: 10,
  windowMs: 15 * 60 * 1000, // 15 minutes
  prefix: 'rl:admin:auth',
});

// Google sign-in: one login touches start, callback and exchange, so it gets its own bucket.
const oauthLimiter = createRateLimiter({
  max: 30,
  windowMs: 15 * 60 * 1000, // 15 minutes
  prefix: 'rl:admin:oauth',
});

const sensitiveOpLimiter = createRateLimiter({
  max: 30,
  windowMs: 15 * 60 * 1000, // 15 minutes
  prefix: 'rl:admin:sensitive',
});

const expensiveQueryLimiter = createRateLimiter({
  max: 20,
  windowMs: 60 * 1000, // 1 minute
  prefix: 'rl:admin:expensive',
});

async function resetRateLimits() {
  memoryBuckets.clear();
  try {
    if (redisClient && typeof redisClient.flushall === 'function') {
      await redisClient.flushall();
    }
  } catch (_) {
    // ignore
  }
}

module.exports = {
  createRateLimiter,
  getClientIp,
  adminApiLimiter,
  normalQueryLimiter: adminApiLimiter,
  authLimiter,
  oauthLimiter,
  sensitiveOpLimiter,
  expensiveQueryLimiter,
  resetRateLimits,
};
