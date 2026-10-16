'use strict';

const { redisClient } = require('../providers/redis');
const logger = require('../config/logger');
const env = require('../config/env');

const IDEMPOTENCY_PROCESSING_TTL_SECONDS = 120; // 2 minutes lock
const IDEMPOTENCY_COMPLETED_TTL_SECONDS = 86400; // 24 hours retention

class IdempotencyService {
  constructor() {
    this.inMemoryFallback = new Map();
  }

  _getKey(actorId, key) {
    return `idempotency:${actorId}:${key}`;
  }

  /**
   * Retrieves an idempotency record.
   *
   * @param {string} actorId
   * @param {string} key
   * @returns {Promise<object|null>}
   */
  async getRecord(actorId, key) {
    const fullKey = this._getKey(actorId, key);

    try {
      if (env.NODE_ENV === 'test' && (!redisClient || typeof redisClient.get !== 'function')) {
        const item = this.inMemoryFallback.get(fullKey);
        if (!item) return null;
        if (Date.now() > item.expiresAt) {
          this.inMemoryFallback.delete(fullKey);
          return null;
        }
        return item.data;
      }

      const raw = await redisClient.get(fullKey);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      logger.error('Failed to read idempotency record', { actorId, key, error: err.message });
      return null;
    }
  }

  /**
   * Attempts to acquire an idempotency lock for processing.
   *
   * @param {string} actorId
   * @param {string} key
   * @returns {Promise<boolean>} True if lock acquired, false if already exists
   */
  async acquireLock(actorId, key) {
    const fullKey = this._getKey(actorId, key);
    const data = {
      status: 'PROCESSING',
      createdAt: new Date().toISOString(),
    };

    try {
      if (env.NODE_ENV === 'test' && (!redisClient || typeof redisClient.set !== 'function')) {
        if (this.inMemoryFallback.has(fullKey)) {
          const item = this.inMemoryFallback.get(fullKey);
          if (Date.now() <= item.expiresAt) {
            return false;
          }
        }
        this.inMemoryFallback.set(fullKey, {
          data,
          expiresAt: Date.now() + IDEMPOTENCY_PROCESSING_TTL_SECONDS * 1000,
        });
        return true;
      }

      // SET with NX (only set if not exists) and EX (expire in seconds)
      const res = await redisClient.set(
        fullKey,
        JSON.stringify(data),
        'EX',
        IDEMPOTENCY_PROCESSING_TTL_SECONDS,
        'NX',
      );
      return res === 'OK';
    } catch (err) {
      logger.error('Failed to acquire idempotency lock', { actorId, key, error: err.message });
      return false;
    }
  }

  /**
   * Saves the completed response associated with an idempotency key.
   *
   * @param {string} actorId
   * @param {string} key
   * @param {number} statusCode
   * @param {object} responseBody
   */
  async saveResponse(actorId, key, statusCode, responseBody) {
    const fullKey = this._getKey(actorId, key);
    const record = {
      status: 'COMPLETED',
      statusCode,
      body: responseBody,
      completedAt: new Date().toISOString(),
    };

    try {
      if (env.NODE_ENV === 'test' && (!redisClient || typeof redisClient.set !== 'function')) {
        this.inMemoryFallback.set(fullKey, {
          data: record,
          expiresAt: Date.now() + IDEMPOTENCY_COMPLETED_TTL_SECONDS * 1000,
        });
        return;
      }

      await redisClient.set(
        fullKey,
        JSON.stringify(record),
        'EX',
        IDEMPOTENCY_COMPLETED_TTL_SECONDS,
      );
    } catch (err) {
      logger.error('Failed to save idempotency response', { actorId, key, error: err.message });
    }
  }

  /**
   * Releases an idempotency lock if downstream processing failed.
   *
   * @param {string} actorId
   * @param {string} key
   */
  async releaseLock(actorId, key) {
    const fullKey = this._getKey(actorId, key);
    try {
      if (env.NODE_ENV === 'test' && (!redisClient || typeof redisClient.del !== 'function')) {
        this.inMemoryFallback.delete(fullKey);
        return;
      }
      await redisClient.del(fullKey);
    } catch (err) {
      logger.error('Failed to release idempotency lock', { actorId, key, error: err.message });
    }
  }
}

module.exports = new IdempotencyService();
