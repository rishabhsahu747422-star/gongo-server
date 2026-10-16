'use strict';

const Redis = require('ioredis');
const env = require('../config/env');
const logger = require('../config/logger');

function createRedisClient() {
  if (env.USE_REDIS_MOCK || env.NODE_ENV === 'test') {
    // eslint-disable-next-line global-require
    const RedisMock = require('ioredis-mock');
    return new RedisMock();
  }

  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 10000,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 200, 2000),
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

async function connectRedis() {
  if (redisClient.status === 'ready' || redisClient.status === 'connecting') {
    return;
  }

  try {
    if (typeof redisClient.connect === 'function' && redisClient.status === 'wait') {
      await redisClient.connect();
    }
    await redisClient.ping();
    logger.info('Redis connection verified');
  } catch (err) {
    logger.error('Redis connection failed', { code: err.code || 'UNKNOWN', message: err.message });
    process.stderr.write(`[REDIS] Startup connection probe failed: ${err.message} (${err.code || 'UNKNOWN'})\n`);
    if (env.isProduction) {
      throw new Error(`Redis connection failed (${err.code || err.message}) — check REDIS_URL and Redis service status`);
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

async function checkRedisHealth() {
  const start = Date.now();
  try {
    const res = await redisClient.ping();
    if (res === 'PONG' || res === 'OK') {
      return {
        status: 'UP',
        latencyMs: Date.now() - start,
      };
    }
    return {
      status: 'DOWN',
      latencyMs: Date.now() - start,
      error: 'Unexpected ping response',
    };
  } catch (err) {
    return {
      status: 'DOWN',
      latencyMs: Date.now() - start,
      error: 'Redis unreachable',
    };
  }
}

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
  checkRedisHealth,
  disconnectRedis,
};
