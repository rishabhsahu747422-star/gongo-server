'use strict';

const express = require('express');
const { pool } = require('../config/database');
const { redisClient } = require('../config/redis');
const env = require('../config/env');
const { sendSuccess } = require('../utils/response');
const { ServiceUnavailableError } = require('../errors');
const { HTTP_STATUS } = require('../constants/http');

const router = express.Router();

/**
 * Checks database connectivity with a lightweight probe.
 * Returns 'connected' or 'disconnected'. Never throws or leaks details.
 *
 * @returns {Promise<string>}
 */
async function checkDatabase() {
  let client;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    return 'connected';
  } catch (_err) {
    return 'disconnected';
  } finally {
    if (client) client.release();
  }
}

/**
 * Checks Redis connectivity with a lightweight PING probe.
 * Returns 'connected' or 'disconnected'. Never throws or leaks details.
 *
 * @returns {Promise<string>}
 */
async function checkRedis() {
  try {
    if (typeof redisClient.ping === 'function') {
      const reply = await redisClient.ping();
      return reply === 'PONG' ? 'connected' : 'disconnected';
    }
    return 'connected';
  } catch (_err) {
    return 'disconnected';
  }
}

/**
 * GET /api/v1/health/live (or /health/live)
 *
 * Kubernetes / Container Liveness Probe.
 * Confirms that the Node.js event loop and process are alive.
 * Performs zero external network or database calls.
 */
router.get('/live', (req, res) => sendSuccess(
  res,
  {
    status: 'alive',
    timestamp: new Date().toISOString(),
  },
  'Service alive',
  HTTP_STATUS.OK,
));

/**
 * GET /api/v1/health/ready (or /health/ready)
 *
 * Kubernetes / Container Readiness Probe.
 * Confirms that all core dependencies (Database and Redis) are available
 * to accept incoming customer requests.
 */
router.get('/ready', async (req, res, next) => {
  const [dbStatus, redisStatus] = await Promise.all([
    checkDatabase(),
    checkRedis(),
  ]);

  const isReady = dbStatus === 'connected' && redisStatus === 'connected';

  if (!isReady) {
    const err = new ServiceUnavailableError('Service not ready to accept traffic');
    err.data = {
      status: 'not_ready',
      services: {
        database: dbStatus,
        redis: redisStatus,
      },
    };
    return next(err);
  }

  return sendSuccess(
    res,
    {
      status: 'ready',
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        redis: redisStatus,
      },
    },
    'Service ready',
    HTTP_STATUS.OK,
  );
});

/**
 * GET /api/v1/health (or /health)
 *
 * Full platform health probe.
 * Backwards-compatible with Phase 0 API contract.
 */
router.get('/', async (req, res, next) => {
  const [dbStatus, redisStatus] = await Promise.all([
    checkDatabase(),
    checkRedis(),
  ]);

  if (dbStatus === 'disconnected') {
    const err = new ServiceUnavailableError('Service temporarily unavailable');
    err.data = {
      status: 'degraded',
      services: {
        database: 'disconnected',
        redis: redisStatus,
      },
    };
    return next(err);
  }

  return sendSuccess(
    res,
    {
      status: 'healthy',
      version: process.env.npm_package_version || '1.0.0',
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        redis: redisStatus,
      },
    },
    'OK',
    HTTP_STATUS.OK,
  );
});

module.exports = router;
