'use strict';

/**
 * Unified infrastructure lifecycle.
 *
 * The Customer, Partner, and Admin sub-apps each own their own PostgreSQL pool,
 * Redis client, and background workers. Their standalone server.js files connect,
 * start workers, and close these resources; when the sub-apps are mounted inside the
 * unified process, this module performs the same duties exactly once.
 *
 * All modules are required lazily so that requiring this file never opens connections.
 */

/* eslint-disable global-require */
function loadModules() {
  const customerConfig = require('../Customer/src/config');
  const partnerPool = require('../Partner/src/db/pool');
  const partnerRedis = require('../Partner/src/providers/redis');
  const adminPool = require('../Admin/src/db/pool');
  const adminRedis = require('../Admin/src/providers/redis');

  return {
    customer: {
      connectDatabase: customerConfig.connectDatabase,
      disconnectDatabase: customerConfig.disconnectDatabase,
      connectRedis: customerConfig.connectRedis,
      disconnectRedis: customerConfig.disconnectRedis,
      checkDb: async () => {
        await customerConfig.pool.query('SELECT 1');
      },
      checkRedis: async () => {
        await customerConfig.redisClient.ping();
      },
    },
    partner: {
      connectDatabase: partnerPool.connectDatabase,
      disconnectDatabase: partnerPool.disconnectDatabase,
      connectRedis: partnerRedis.connectRedis,
      disconnectRedis: partnerRedis.disconnectRedis,
      checkDb: async () => {
        const res = await partnerPool.checkDbHealth();
        if (res.status !== 'UP') throw new Error('Database unreachable');
      },
      checkRedis: async () => {
        const res = await partnerRedis.checkRedisHealth();
        if (res.status !== 'UP') throw new Error('Redis unreachable');
      },
    },
    admin: {
      connectDatabase: adminPool.connectDatabase,
      disconnectDatabase: adminPool.disconnectDatabase,
      connectRedis: adminRedis.connectRedis,
      disconnectRedis: adminRedis.disconnectRedis,
      checkDb: async () => {
        const res = await adminPool.checkDbHealth();
        if (res.status !== 'UP') throw new Error('Database unreachable');
      },
      checkRedis: async () => {
        const res = await adminRedis.checkRedisHealth();
        if (res.status !== 'UP') throw new Error('Redis unreachable');
      },
    },
  };
}

function loadWorkers() {
  const noShowService = require('../Customer/src/services/no-show-cancellation.service');
  const paymentTimeoutService = require('../Customer/src/services/payment-timeout.service');
  const partnerOutbox = require('../Partner/src/services/outbox.service');
  const { defaultWorker: adminOutboxWorker } = require('../Admin/src/jobs/outbox.worker');

  return [
    {
      name: 'customer:no-show-cancellation',
      start: () => noShowService.startScheduler(),
      stop: () => noShowService.stopScheduler(),
    },
    {
      name: 'customer:payment-timeout',
      start: () => paymentTimeoutService.startScheduler(),
      stop: () => paymentTimeoutService.stopScheduler(),
    },
    {
      name: 'partner:outbox',
      start: () => partnerOutbox.startWorker(),
      stop: () => partnerOutbox.stopWorker(),
    },
    {
      name: 'admin:outbox',
      start: () => adminOutboxWorker.start(),
      stop: () => adminOutboxWorker.stop(),
    },
  ];
}
/* eslint-enable global-require */

let workersStarted = false;
let isAppReady = false;

function isReady() {
  return isAppReady;
}

function setReady(ready) {
  isAppReady = Boolean(ready);
}

/**
 * Verifies database and Redis connectivity for every sub-app.
 * Each sub-app's connect functions throw in production when a dependency is unreachable,
 * so this rejects and the caller must abort startup.
 */
async function connectAll() {
  const modules = loadModules();
  for (const [name, m] of Object.entries(modules)) {
    try {
      await m.connectDatabase();
      await m.connectRedis();
    } catch (err) {
      throw new Error(`[${name}] ${err.message}`);
    }
  }
  isAppReady = true;
}

/**
 * Starts background workers once per process.
 */
function startWorkers(log = () => {}) {
  if (workersStarted) return;
  workersStarted = true;
  for (const worker of loadWorkers()) {
    worker.start();
    log(`Background worker started: ${worker.name}`);
  }
}

/**
 * Stops workers (if started), then closes Redis clients and database pools.
 * Never throws — shutdown must always proceed.
 */
async function shutdownAll(log = () => {}) {
  if (workersStarted) {
    for (const worker of loadWorkers()) {
      try {
        await worker.stop();
      } catch (err) {
        log(`Error stopping worker ${worker.name}: ${err.message}`);
      }
    }
    workersStarted = false;
  }

  const modules = loadModules();
  for (const [name, m] of Object.entries(modules)) {
    try {
      await m.disconnectRedis();
      await m.disconnectDatabase();
    } catch (err) {
      log(`Error closing ${name} resources: ${err.message}`);
    }
  }
}

/**
 * Connects all sub-application dependencies with bounded retries,
 * exponential backoff, and randomized jitter.
 *
 * @param {object} [options]
 * @param {number} [options.maxRetries=5]
 * @param {number} [options.initialDelayMs=2000]
 * @param {number} [options.maxDelayMs=10000]
 * @param {Function} [options.log]
 * @param {Function} [options.logError]
 */
async function connectAllWithRetry(options = {}) {
  const {
    maxRetries = 5,
    initialDelayMs = 2000,
    maxDelayMs = 10000,
    log = () => {},
    logError = () => {},
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const modules = loadModules();
      for (const [, m] of Object.entries(modules)) {
        await m.connectDatabase();
        await m.connectRedis();
      }
      isAppReady = true;
      log(`Dependency connection established successfully (attempt ${attempt}/${maxRetries})`);
      return;
    } catch (err) {
      lastError = err;
      isAppReady = false;
      logError(`Dependency connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);

      if (attempt < maxRetries) {
        const exponentialDelay = Math.min(maxDelayMs, initialDelayMs * (2 ** (attempt - 1)));
        const jitter = Math.floor(Math.random() * 500);
        const delay = exponentialDelay + jitter;
        log(`Retrying dependency connection in ${delay}ms...`);
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
      }
    }
  }

  isAppReady = false;
  // Cleanup connections if all retries failed before propagating failure
  try {
    await shutdownAll(logError);
  } catch (cleanupErr) {
    logError(`Error during post-retry cleanup: ${cleanupErr.message}`);
  }

  throw lastError || new Error('Failed to connect to dependencies');
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Readiness probe: checks each sub-app's database and Redis connectivity.
 * Returns only UP/DOWN per dependency — never error messages or configuration.
 *
 * @param {object} [modules] Injectable for tests
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ ready: boolean, checks: Record<string, string> }>}
 */
async function checkReadiness(modules = null, timeoutMs = 3000) {
  const activeModules = modules || loadModules();

  if (!modules && !isAppReady) {
    return {
      ready: false,
      checks: {
        startup: 'INITIALIZING',
      },
    };
  }

  const checks = {};
  const entries = [];
  for (const [name, m] of Object.entries(activeModules)) {
    entries.push([`${name}.database`, m.checkDb]);
    entries.push([`${name}.redis`, m.checkRedis]);
  }

  await Promise.all(entries.map(async ([key, fn]) => {
    try {
      await withTimeout(fn(), timeoutMs);
      checks[key] = 'UP';
    } catch (_) {
      checks[key] = 'DOWN';
    }
  }));

  const ready = Object.values(checks).every((s) => s === 'UP');
  return { ready, checks };
}

module.exports = {
  connectAll,
  connectAllWithRetry,
  startWorkers,
  shutdownAll,
  checkReadiness,
  isReady,
  setReady,
};
