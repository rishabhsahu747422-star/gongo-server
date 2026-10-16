'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const env = require('./config/env');
const logger = require('./config/logger');
const { createApp } = require('./app');
const { connectDatabase, disconnectDatabase } = require('./db/pool');
const { connectRedis, disconnectRedis } = require('./providers/redis');
const outboxService = require('./services/outbox.service');

let server = null;
let isShuttingDown = false;

/**
 * Graceful shutdown procedure.
 * Stops accepting new traffic, drains active requests, stops background workers,
 * closes DB & Redis pools, and exits.
 *
 * @param {string} signal Triggering signal or error event
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.info(`Initiating graceful shutdown on signal: ${signal}`);

  const shutdownTimeout = setTimeout(() => {
    logger.error('Shutdown timed out after 10s, forcing exit');
    process.stderr.write('[SHUTDOWN] Timed out after 10s, forcing exit\n');
    process.exit(1);
  }, 10000);
  shutdownTimeout.unref();

  try {
    // 1. Stop receiving new HTTP requests
    if (server) {
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
      await new Promise((resolve) => {
        server.close((err) => {
          if (err) {
            logger.error('Error closing HTTP server', { error: err.message });
          } else {
            logger.info('HTTP server closed, no longer accepting connections');
          }
          resolve();
        });
      });
    }

    // 2. Stop background outbox worker
    await outboxService.stopWorker();

    // 3. Disconnect Redis
    await disconnectRedis();

    // 4. Disconnect PostgreSQL connection pool
    await disconnectDatabase();

    logger.info('Graceful shutdown completed cleanly');
    process.exit(0);
  } catch (err) {
    logger.error('Error during graceful shutdown', { error: err.message });
    process.stderr.write(`[SHUTDOWN ERROR] ${err.message}\n`);
    process.exit(1);
  }
}

/**
 * Application bootstrapper.
 */
async function startServer() {
  try {
    // 1. Connect to infrastructure
    await connectDatabase();
    await connectRedis();

    // 2. Build Express application
    const app = createApp();

    // 3. Start HTTP server
    server = app.listen(env.PORT, () => {
      logger.info(`GONGO Partner Backend listening on port ${env.PORT} [${env.NODE_ENV}]`);
      if (env.NODE_ENV === 'development') {
        const devAuthStatus = env.PARTNER_DEV_AUTH_ENABLED === true
          ? 'ENABLED (POST /api/v1/auth/dev-login)'
          : 'DISABLED';
        logger.info(`[Startup Diagnostic] Dev Auth: ${devAuthStatus} | Target Auth ID: ${env.PARTNER_DEV_AUTH_ID}`);
      }
    });

    // 4. Start background outbox event worker
    outboxService.startWorker();

    // 5. Register process lifecycle listeners
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      logger.error('Unhandled Promise Rejection', {
        reason: msg,
        stack,
      });
      process.stderr.write(`[UNHANDLED REJECTION] ${msg}\n`);
      if (stack) process.stderr.write(`${stack}\n`);
      gracefulShutdown('unhandledRejection');
    });

    process.on('uncaughtException', (err) => {
      logger.error('Uncaught Exception', {
        error: err.message,
        stack: err.stack,
      });
      process.stderr.write(`[UNCAUGHT EXCEPTION] ${err.message}\n`);
      if (err.stack) process.stderr.write(`${err.stack}\n`);
      gracefulShutdown('uncaughtException');
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message, stack: err.stack });
    process.stderr.write(`[FATAL STARTUP ERROR] Failed to start server: ${err.message}\n`);
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, gracefulShutdown };
