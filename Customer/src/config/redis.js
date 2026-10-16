'use strict';

const Redis = require('ioredis');
const env = require('./env');
const logger = require('./logger');

/**
 * Creates and configures the Redis client instance.
 *
 * In test environment, if TEST_REDIS_MOCK is set or by default in tests,
 * uses `ioredis-mock` to provide a hermetic, zero-dependency in-memory store.
 * In development and production, connects to the configured REDIS_URL.
 */
function createRedisClient() {
  if (process.env.USE_REDIS_MOCK === 'true' || env.NODE_ENV === 'test') {
    // eslint-disable-next-line global-require
    const RedisMock = require('ioredis-mock');
    const mock = new RedisMock();
    return mock;
  }

  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 10000,
    lazyConnect: true,
    retryStrategy: (times) => {
      const delay = Math.min(times * 200, 2000);
      return delay;
    },
  });

  client.on('error', (err) => {
    logger.error('Redis client error', {
      code: err.code || 'UNKNOWN',
      name: err.name,
    });
  });

  client.on('connect', () => {
    logger.info('Redis connected successfully');
  });

  return client;
}

let redisClient = createRedisClient();

/**
 * Verifies Redis connectivity during application startup.
 *
 * @returns {Promise<void>}
 */
async function connectRedis() {
  if (redisClient.status === 'ready' || redisClient.status === 'connecting') {
    return;
  }

  try {
    if (typeof redisClient.connect === 'function' && redisClient.status === 'wait') {
      await redisClient.connect();
    }
    await redisClient.ping();
    logger.info('Redis connection verified via PING');
  } catch (err) {
    logger.error('Redis connection failed during startup probe', {
      code: err.code || 'UNKNOWN',
    });
    if (env.NODE_ENV === 'production') {
      throw new Error('Redis connection failed — check REDIS_URL and Redis service availability');
    }
    logger.warn('Server starting in degraded state: Redis is unreachable. Falling back to in-memory Redis mock.');
    try {
      // eslint-disable-next-line global-require
      const RedisMock = require('ioredis-mock');
      redisClient = new RedisMock();
    } catch (mockErr) {
      logger.error('Failed to initialize fallback Redis mock', { error: mockErr.message });
    }
  }
}

/**
 * Gracefully terminates the Redis connection pool during shutdown.
 *
 * @returns {Promise<void>}
 */
async function disconnectRedis() {
  try {
    if (typeof redisClient.quit === 'function') {
      await redisClient.quit();
    }
    logger.info('Redis connection closed gracefully');
  } catch (err) {
    logger.error('Error closing Redis connection', { code: err.code || 'UNKNOWN' });
  }
}

module.exports = {
  get redisClient() {
    return redisClient;
  },
  connectRedis,
  disconnectRedis,
};
