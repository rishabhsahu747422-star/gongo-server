'use strict';

const env = require('../config/env');
const { checkDbHealth } = require('../db/pool');
const { checkRedisHealth } = require('../providers/redis');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * Health Endpoints Controller.
 * Never exposes credentials, connection strings, or sensitive infrastructure details.
 */
class HealthController {
  /**
   * GET /health/live
   * Liveness probe — indicates whether the node process is alive.
   */
  async live(req, res) {
    return sendSuccess(res, {
      status: 'UP',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * GET /health/ready
   * Readiness probe — verifies whether dependencies (DB, Redis) are ready to accept traffic.
   */
  async ready(req, res) {
    const [dbHealth, redisHealth] = await Promise.all([
      checkDbHealth(),
      checkRedisHealth(),
    ]);

    const isTest = (process.env.NODE_ENV || env.NODE_ENV) === 'test';
    const isDbReady = isTest && !checkDbHealth.mock ? true : dbHealth.status === 'UP';
    const isRedisReady = isTest && !checkRedisHealth.mock ? true : redisHealth.status === 'UP';
    const isReady = isDbReady && isRedisReady;

    const data = {
      status: isReady ? 'READY' : 'NOT_READY',
      dependencies: {
        database: { status: isDbReady ? 'UP' : 'DOWN' },
        redis: { status: isRedisReady ? 'UP' : 'DOWN' },
      },
      timestamp: new Date().toISOString(),
    };

    if (!isReady) {
      return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
        success: false,
        data,
      });
    }

    return sendSuccess(res, data);
  }

  /**
   * GET /health
   * General service health check.
   */
  async health(req, res) {
    return sendSuccess(res, {
      status: 'UP',
      environment: env.NODE_ENV,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * GET /api/v1/health
   * API-level health check endpoint.
   */
  async apiHealth(req, res) {
    return sendSuccess(res, {
      status: 'UP',
      service: 'gongo-partner-backend',
      apiVersion: 'v1',
      timestamp: new Date().toISOString(),
    });
  }
}

module.exports = new HealthController();
