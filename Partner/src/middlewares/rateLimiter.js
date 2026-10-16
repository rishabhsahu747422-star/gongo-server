'use strict';

const env = require('../config/env');
const logger = require('../config/logger');
const { redisClient } = require('../providers/redis');
const { RateLimitError, InternalError } = require('../errors');

// In-memory store fallback for test mode when Redis is not available
const inMemoryTestStore = new Map();

/**
 * Creates a rate limiting middleware.
 *
 * @param {object} options
 * @param {number} [options.windowMs] Window length in milliseconds (default 60,000ms)
 * @param {number} [options.max] Max allowed requests per window (default 100)
 * @param {string} [options.prefix] Redis key prefix
 * @param {(req: import('express').Request) => string} [options.keyGenerator] Custom key generator
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || env.RATE_LIMIT_WINDOW_MS || 60000;
  const max = options.max || env.RATE_LIMIT_MAX_REQUESTS || 100;
  const prefix = options.prefix || 'rl';
  const keyGenerator = options.keyGenerator || ((req) => (req.user && req.user.partnerId) || req.ip || 'global');

  return async (req, res, next) => {
    const key = keyGenerator(req);
    const windowBucket = Math.floor(Date.now() / windowMs);
    const redisKey = `${prefix}:${key}:${windowBucket}`;

    try {
      let count = 0;
      let ttlMs = windowMs;

      if (env.NODE_ENV === 'test' && (!redisClient || typeof redisClient.incr !== 'function')) {
        // Controlled in-memory adapter strictly for test runner isolation
        const currentData = inMemoryTestStore.get(redisKey) || {
          count: 0,
          expiresAt: Date.now() + windowMs,
        };
        if (Date.now() > currentData.expiresAt) {
          currentData.count = 1;
          currentData.expiresAt = Date.now() + windowMs;
        } else {
          currentData.count += 1;
        }
        inMemoryTestStore.set(redisKey, currentData);
        count = currentData.count;
        ttlMs = Math.max(0, currentData.expiresAt - Date.now());
      } else {
        count = await redisClient.incr(redisKey);
        if (count === 1) {
          await redisClient.pexpire(redisKey, windowMs);
        } else {
          const remainingTtl = await redisClient.pttl(redisKey);
          if (remainingTtl > 0) {
            ttlMs = remainingTtl;
          }
        }
      }

      const remaining = Math.max(0, max - count);
      const resetTime = Math.ceil((Date.now() + ttlMs) / 1000);

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', resetTime);

      if (count > max) {
        res.setHeader('Retry-After', Math.ceil(ttlMs / 1000));
        throw new RateLimitError(`Too many requests. Please retry after ${Math.ceil(ttlMs / 1000)} seconds.`);
      }

      next();
    } catch (err) {
      if (err instanceof RateLimitError) {
        return next(err);
      }

      logger.error('Rate limiting failure', {
        key,
        code: err.code || 'RATE_LIMIT_ERROR',
        message: err.message,
      });

      // Never silently disable rate limiting in production
      if (env.isProduction) {
        return next(new InternalError('Rate limiting verification failed'));
      }

      next();
    }
  };
}

/**
 * Resets the in-memory test store. Used for test runner isolation.
 */
function resetRateLimitStore() {
  inMemoryTestStore.clear();
}

module.exports = { createRateLimiter, resetRateLimitStore };

