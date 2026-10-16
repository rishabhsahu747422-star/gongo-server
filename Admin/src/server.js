'use strict';

require('dotenv').config();

const env = require('./config/env');
const logger = require('./config/logger');
const { createApp } = require('./app');
const { connectDatabase, disconnectDatabase } = require('./db/pool');
const { connectRedis, disconnectRedis } = require('./providers/redis');
const { defaultWorker } = require('./jobs/outbox.worker');

let server = null;
let isShuttingDown = false;

/**
 * Graceful shutdown procedure.
 * Stops accepting new traffic, drains active connections, closes DB & Redis pools, and exits.
 *
 * @param {string} signal Triggering signal or error event
 * @param {boolean} [shouldExit=true] Whether to call process.exit (false during automated tests)
 */
async function gracefulShutdown(signal, shouldExit = true) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.info(`Initiating graceful shutdown on signal: ${signal}`);

  let shutdownTimeout = null;
  if (shouldExit) {
    shutdownTimeout = setTimeout(() => {
      logger.error('Shutdown timed out after 10s, forcing exit');
      process.stderr.write('[SHUTDOWN] Timed out after 10s, forcing exit\n');
      process.exit(1);
    }, 10000);
    shutdownTimeout.unref();
  }

  try {
    // 0. Stop outbox background worker cleanly and release any active leases
    try {
      await defaultWorker.stop();
    } catch (workerErr) {
      logger.error('Error stopping outbox worker during shutdown', { error: workerErr.message });
    }

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

    // 2. Disconnect Redis
    await disconnectRedis();

    // 3. Disconnect PostgreSQL connection pool
    await disconnectDatabase();

    logger.info('Graceful shutdown completed cleanly');
    if (shutdownTimeout) clearTimeout(shutdownTimeout);

    if (shouldExit) {
      process.exit(0);
    }
  } catch (err) {
    logger.error('Error during graceful shutdown', { error: err.message });
    process.stderr.write(`[SHUTDOWN ERROR] ${err.message}\n`);
    if (shouldExit) {
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Application bootstrapper.
 */
async function startServer() {
  try {
    // 0. Log environment configuration status safely (never print actual secrets)
    logger.info(`SUPABASE_URL: ${env.SUPABASE_URL ? 'configured' : 'missing'}`);
    logger.info(`SUPABASE_SERVICE_ROLE_KEY: ${env.SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'missing'}`);
    logger.info(`DATABASE_URL: ${env.DATABASE_URL ? 'configured' : 'missing'}`);

    // 1. Initialize Supabase client
    const { initSupabase } = require('./config/supabase');
    initSupabase();

    // 2. Connect to database and verify probe
    await connectDatabase();

    // 3. Connect to Redis
    await connectRedis();

    // 4. Build Express application
    const app = createApp();

    // 5. Start HTTP server
    server = app.listen(env.PORT, () => {
      logger.info(`GONGO Admin Backend listening on port ${env.PORT} [${env.NODE_ENV}]`);
    });

    // 6. Start background outbox worker (only after database is confirmed healthy)
    if (env.NODE_ENV !== 'test' && env.ENABLE_OUTBOX_WORKER !== 'false') {
      defaultWorker.start();
    }

    // 4. Register process lifecycle listeners
    process.on('SIGTERM', () => {
      process.stderr.write('[SIGNAL] SIGTERM received\n');
      gracefulShutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      process.stderr.write('[SIGNAL] SIGINT received\n');
      gracefulShutdown('SIGINT');
    });

    process.on('unhandledRejection', (reason) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      process.stderr.write(`[UNHANDLED REJECTION] ${msg}\n${stack || ''}\n`);
      logger.error('Unhandled Promise Rejection', { message: msg, stack });
      gracefulShutdown('unhandledRejection');
    });

    process.on('uncaughtException', (err) => {
      process.stderr.write(`[UNCAUGHT EXCEPTION] ${err.message}\n${err.stack || ''}\n`);
      logger.error('Uncaught Exception', { message: err.message, stack: err.stack });
      gracefulShutdown('uncaughtException');
    });

    return server;
  } catch (err) {
    logger.error('Failed to start GONGO Admin Backend server', {
      name: err.name,
      message: err.message,
      stack: err.stack,
    });
    process.stderr.write(`[FATAL] Startup failure: ${err.message}\n`);
    process.exit(1);
  }
}

// Start server when executed directly
if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  gracefulShutdown,
  get server() {
    return server;
  },
};
