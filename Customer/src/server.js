'use strict';

// Load environment variables FIRST before any other module
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();
[
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../../server/.env'),
  path.resolve(__dirname, '../../server/.env'),
  path.resolve(__dirname, '../../.env'),
].forEach((p) => {
  if (fs.existsSync(p)) dotenv.config({ path: p });
});

const { createApp } = require('./app');
const {
  env,
  logger,
  connectDatabase,
  disconnectDatabase,
  connectRedis,
  disconnectRedis,
} = require('./config');
const noShowAutoCancellationService = require('./services/no-show-cancellation.service');
const paymentTimeoutService = require('./services/payment-timeout.service');

/**
 * GONGO Customer Backend — HTTP Server
 *
 * Responsibilities:
 * 1. Connect to database and Redis (fail-fast if unavailable)
 * 2. Start the HTTP server
 * 3. Handle graceful shutdown on SIGTERM / SIGINT
 * 4. Handle uncaught exceptions and unhandled promise rejections
 *
 * This file is intentionally thin — all app configuration lives in app.js,
 * all business logic lives in route handlers and service modules.
 */

let server;

/**
 * Gracefully shuts down the server, database pool, and Redis connection.
 *
 * Shutdown sequence:
 * 1. Stop accepting new connections
 * 2. Wait for in-flight requests to complete (up to 10s)
 * 3. Close database pool
 * 4. Close Redis client
 * 5. Exit process
 *
 * @param {string} signal - The signal that triggered shutdown (for logging)
 */
async function shutdown(signal) {
  logger.info(`Received ${signal} — starting graceful shutdown`);

  // Give in-flight requests up to 10 seconds to complete
  const shutdownTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10000);

  // Don't let the timeout keep the process alive
  shutdownTimeout.unref();

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) return reject(err);
          return resolve();
        });
      });
      logger.info('HTTP server closed');
    }

    await noShowAutoCancellationService.stopScheduler();
    await paymentTimeoutService.stopScheduler();
    await disconnectDatabase();
    await disconnectRedis();

    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { code: err.code || 'UNKNOWN' });
    process.exit(1);
  }
}

/**
 * Bootstraps the application:
 * 1. Validates env (via config/env.js — already done at import)
 * 2. Connects to database and Redis
 * 3. Starts HTTP server
 */
async function start() {
  try {
    // Verify database and Redis connectivity before accepting traffic
    await connectDatabase();
    await connectRedis();

    const app = createApp();

    server = app.listen(env.PORT, '0.0.0.0', () => {
      logger.info('GONGO Customer Backend started', {
        port: env.PORT,
        host: '0.0.0.0',
        environment: env.NODE_ENV,
        apiBase: `/api/${env.API_VERSION}`,
      });
      // Start background schedulers
      noShowAutoCancellationService.startScheduler();
      paymentTimeoutService.startScheduler();
    });

    // Handle server-level errors (e.g. EADDRINUSE)
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`Port ${env.PORT} is already in use`);
      } else {
        logger.error('Server error', { code: err.code || 'UNKNOWN' });
      }
      process.exit(1);
    });
  } catch (err) {
    // Startup errors (DB unreachable, env invalid) → log and exit
    logger.error('Failed to start server', {
      // Safe: only log the message we generated ourselves, not raw system errors
      reason: err.message,
    });
    process.exit(1);
  }
}

// ── Process signal handlers ──────────────────────────────────────────────────

// Graceful shutdown (container orchestrators send SIGTERM before kill)
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Graceful shutdown (Ctrl+C in development)
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Unhandled promise rejection handler.
 *
 * In Node.js >= 15, unhandled rejections crash the process by default.
 * We log it here for context before the process exits.
 * Never swallow the rejection — crashing is safer than running in a broken state.
 */
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection — process will exit', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
  // Let the default handler crash the process
  throw reason;
});

/**
 * Uncaught exception handler.
 *
 * This is the last safety net. Log the error and exit immediately.
 * The process is in an undefined state — do NOT attempt recovery.
 */
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down immediately', {
    name: err.name,
    // Only log name and code, not the full message (may contain secrets)
    code: err.code || 'UNKNOWN',
  });
  process.exit(1);
});

// Boot
start();
