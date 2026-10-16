'use strict';

/**
 * Central config barrel.
 * Import from here to avoid deep relative paths across the codebase.
 *
 * Note: `env` must be the first import so all downstream modules
 * receive validated configuration.
 */
const env = require('./env');
const logger = require('./logger');
const {
  pool,
  query,
  transaction,
  connectDatabase,
  disconnectDatabase,
} = require('./database');
const {
  redisClient,
  connectRedis,
  disconnectRedis,
} = require('./redis');

module.exports = {
  env,
  logger,
  pool,
  query,
  transaction,
  connectDatabase,
  disconnectDatabase,
  redisClient,
  connectRedis,
  disconnectRedis,
};
