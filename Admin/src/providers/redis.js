'use strict';

const Redis = require('ioredis');
const env = require('../config/env');
const logger = require('../config/logger');

let activeRedisClient = null;
let mockRedisInstance = null;

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

activeRedisClient = createRedisClient();

function getRedisClient() {
  return mockRedisInstance || activeRedisClient;
}

function setMockRedisClient(mock) {
  mockRedisInstance = mock;
}

function resetRedisClient() {
  mockRedisInstance = null;
}

async function connectRedis() {
  const client = getRedisClient();
  if (client.status === 'ready' || client.status === 'connecting') {
    return;
  }

  try {
    if (typeof client.connect === 'function' && client.status === 'wait') {
      await client.connect();
    }
    await client.ping();
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
      activeRedisClient = new RedisMock();
    } catch (mockErr) {
      logger.error('Failed to initialize fallback Redis mock', { error: mockErr.message });
    }
  }
}

async function checkRedisHealth() {
  const client = getRedisClient();
  const start = Date.now();
  try {
    const res = await client.ping();
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
  const client = getRedisClient();
  try {
    if (typeof client.quit === 'function') {
      await client.quit();
    }
    logger.info('Redis connection closed gracefully');
  } catch (err) {
    logger.error('Error closing Redis connection', { code: err.code || 'UNKNOWN' });
  }
}

module.exports = {
  get redisClient() {
    return getRedisClient();
  },
  connectRedis,
  checkRedisHealth,
  disconnectRedis,
  setMockRedisClient,
  resetRedisClient,
};
