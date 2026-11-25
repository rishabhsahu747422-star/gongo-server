"use strict";

const path = require("path");
const dotenv = require("dotenv");

// 1. Load canonical root environment
dotenv.config();

// 2. Compatibility fallback: Load server/Admin/.env ONLY for variables not already defined
dotenv.config({
  path: path.resolve(__dirname, "../Admin/.env"),
  override: false,
});

const env = require("./config/env");
const lifecycle = require("./lifecycle");

let server = null;
let isShuttingDown = false;

/* eslint-disable no-console */
const log = (msg) => console.log(`[GONGO UNIFIED BACKEND] ${msg}`);
const logError = (msg) => console.error(`[GONGO UNIFIED BACKEND] ${msg}`);

/**
 * Handles graceful process termination: stop accepting traffic, drain requests,
 * stop workers, close Redis clients and database pools.
 *
 * @param {string} signal
 * @param {number} [exitCode=0]
 */
async function gracefulShutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log(`Received ${signal} — initiating graceful shutdown...`);

  const timeout = setTimeout(() => {
    logError("Shutdown timed out after 10s — forcing exit");
    process.exit(1);
  }, 10000);
  timeout.unref();

  try {
    if (server) {
      if (typeof server.closeIdleConnections === "function") {
        server.closeIdleConnections();
      }
      await new Promise((resolve) => {
        server.close((err) => {
          if (err) {
            logError(`Error closing HTTP server: ${err.message}`);
          } else {
            log("HTTP server closed cleanly");
          }
          resolve();
        });
      });
    }

    await lifecycle.shutdownAll(logError);

    log("All connections drained. Exiting process.");
    process.exit(exitCode);
  } catch (err) {
    logError(`Shutdown error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Bootstraps the unified backend HTTP server.
 * Fails fast (exit 1) if a mandatory dependency is unreachable in production.
 */
async function startServer() {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logError(
      `Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    if (reason instanceof Error && reason.stack) logError(reason.stack);
    gracefulShutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (err) => {
    logError(`Uncaught exception: ${err.message}`);
    if (err.stack) logError(err.stack);
    gracefulShutdown("uncaughtException", 1);
  });

  if (env.NODE_ENV !== "production") {
    // Sub-apps enable development auth/payment shortcuts outside production; make a
    // misconfigured deployment obvious in the logs.
    logError(
      `WARNING: NODE_ENV=${env.NODE_ENV}. Development shortcuts may be active — set NODE_ENV=production on any deployed environment.`,
    );
  }

  let app;
  try {
    // Required here so sub-app configuration errors (thrown while their modules load)
    // are reported as a clean [FATAL] line instead of an uncaught stack trace.
    // eslint-disable-next-line global-require
    const { createApp } = require("./app");
    app = createApp();
  } catch (err) {
    logError(`[FATAL] Startup failed: ${err.message}`);
    process.exit(1);
    return null;
  }

  const port = Number(env.PORT || 8080);

  // 1. Immediately start HTTP server on Cloud Run interface ($PORT and $HOST)
  // This satisfies Cloud Run container startup checks while dependencies initialize.
  try {
    await new Promise((resolve, reject) => {
      server = app.listen(port, env.HOST, () => {
        log(`Listening on http://${env.HOST}:${port} [${env.NODE_ENV}]`);
        log(
          "Mounted sub-apps: /api/v1/customer, /api/v1/partner, /api/v1/admin",
        );
        log("Probes: /health, /health/live, /health/ready");
        resolve();
      });

      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          logError(`[FATAL] Port ${port} is already in use.`);
        } else {
          logError(`[FATAL] Server error: ${err.message}`);
        }
        reject(err);
      });
    });
  } catch (err) {
    process.exit(1);
    return null;
  }

  // 2. Initialize external dependencies with bounded retries and backoff
  try {
    await lifecycle.connectAllWithRetry({
      maxRetries: Number(process.env.DB_CONNECT_RETRIES) || 5,
      initialDelayMs: Number(process.env.DB_CONNECT_RETRY_DELAY_MS) || 2000,
      log,
      logError,
    });
    log("All sub-application database pools and Redis connections verified.");
  } catch (err) {
    if (env.NODE_ENV === "production") {
      logError(`[FATAL] Dependency check failed after retries: ${err.message}`);
      await gracefulShutdown("dependency_failure", 1);
      return null;
    }
    logError(
      `Dependency check failed — starting in degraded mode (non-production only): ${err.message}`,
    );
  }

  // 3. Start background workers ONLY after dependencies are ready
  if (lifecycle.isReady() && env.ENABLE_WORKERS && env.NODE_ENV !== "test") {
    lifecycle.startWorkers(log);
  } else if (!env.ENABLE_WORKERS) {
    log("Background workers disabled (ENABLE_WORKERS=false)");
  }

  // Safe startup diagnostic for Admin Google OAuth
  try {
    // eslint-disable-next-line global-require

    const googleOAuth = require("../Admin/src/providers/google-oauth");
    log(
      `Admin Google OAuth status: ${googleOAuth.isConfigured() ? "CONFIGURED (Ready)" : "NOT CONFIGURED (Endpoints return 503)"}`,
    );
  } catch (_) {
    // Optional diagnostic check only; failures must not block startup
  }

  return server;
}
/* eslint-enable no-console */

if (require.main === module) {
  startServer();
}

module.exports = { startServer, gracefulShutdown };
