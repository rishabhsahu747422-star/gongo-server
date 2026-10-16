'use strict';

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const { Pool } = require('pg');
const env = require('../config/env');
const logger = require('../config/logger');

let sslConfig = false;
const isSupabase = env.DATABASE_URL && (env.DATABASE_URL.includes('supabase.co') || env.DATABASE_URL.includes('pooler.supabase.com') || env.DATABASE_URL.includes('supabase.com'));
if (env.DB_SSL || isSupabase || env.NODE_ENV === 'production') {
  sslConfig = { rejectUnauthorized: false };
}

let keepAliveTimer = null;

const activePool = new Pool({
  connectionString: env.DATABASE_URL,
  min: env.DB_POOL_MIN || 2,
  max: env.DB_POOL_MAX || 10,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS || 300000,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS || 10000,
  ssl: sslConfig,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

activePool.on('connect', (client) => {
  client.on('error', (err) => {
    logger.warn('PostgreSQL client socket error (non-fatal, auto-reconnected by pool)', {
      code: err.code || 'UNKNOWN',
      message: err.message,
    });
  });
});

activePool.on('error', (err) => {
  process.stderr.write(`[POSTGRES] Pool background error: ${err.message} (${err.code || 'UNKNOWN'})\n`);
  logger.error('PostgreSQL background pool error', {
    code: err.code || 'UNKNOWN',
    name: err.name,
  });
});

let mockPoolInstance = null;

function getPool() {
  return mockPoolInstance || activePool;
}

function setMockPool(mock) {
  mockPoolInstance = mock;
}

function resetMockPool() {
  mockPoolInstance = null;
}

/**
 * Startup connectivity check.
 */
async function connectDatabase() {
  if (env.NODE_ENV === 'test') {
    return;
  }

  const clients = [];
  try {
    const warmCount = Math.max(1, Math.min(env.DB_POOL_MIN || 2, 3));
    for (let i = 0; i < warmCount; i++) {
      clients.push(await getPool().connect());
    }
    await Promise.all(clients.map((c) => c.query('SELECT 1')));
    logger.info('PostgreSQL connection healthy and pool warmed', {
      warmConnections: warmCount,
      poolTotal: getPool().totalCount,
      poolIdle: getPool().idleCount,
    });

    // Keep connections warm to prevent silent middlebox/WAN socket drops
    if (!keepAliveTimer && env.NODE_ENV !== 'test') {
      keepAliveTimer = setInterval(() => {
        getPool().query('SELECT 1').catch(() => {});
      }, 45000);
      if (keepAliveTimer.unref) keepAliveTimer.unref();
    }
  } catch (err) {
    logger.error('PostgreSQL connection failed during startup probe', {
      code: err.code || 'UNKNOWN',
      message: err.message,
    });
    process.stderr.write(`[POSTGRES] Startup connection probe failed: ${err.message} (${err.code || 'UNKNOWN'})\n`);
    if (env.isProduction || !env.ALLOW_DEV_DB_FALLBACK) {
      throw new Error(`Database connection failed (${err.code || err.message}) — check DATABASE_URL and database status`);
    }
    logger.warn('Server starting in development fallback state: database is currently unreachable. Activating dev resolvers.');
    try {
      const { registerDevResolvers } = require('./dev-resolvers');
      registerDevResolvers();
      logger.info('Fallback in-memory development resolvers activated successfully');
    } catch (resolverErr) {
      logger.error('Failed to register dev resolvers', resolverErr);
    }
  } finally {
    clients.forEach((c) => {
      try {
        c.release();
      } catch (_) {}
    });
  }
}

/**
 * Health check probe returning status and response latency.
 */
async function checkDbHealth() {
  let client;
  const start = Date.now();
  try {
    client = await getPool().connect();
    await client.query('SELECT 1');
    return {
      status: 'UP',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      status: 'DOWN',
      latencyMs: Date.now() - start,
      error: 'Database unreachable',
    };
  } finally {
    if (client) client.release();
  }
}

/**
 * Graceful pool closure.
 */
async function disconnectDatabase() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  try {
    await getPool().end();
    logger.info('PostgreSQL pool closed gracefully');
  } catch (err) {
    logger.error('Error closing PostgreSQL pool', { code: err.code || 'UNKNOWN' });
  }
}

const { performance } = require('perf_hooks');
const { getContext } = require('../utils/context');

/**
 * Extracts repository and method name from caller stack without overhead.
 */
function extractCaller() {
  const stack = new Error().stack.split('\n');
  for (let i = 1; i < stack.length; i++) {
    const line = stack[i].trim();
    if (
      !line.includes('src/db/pool.js') &&
      !line.includes('src\\db\\pool.js') &&
      !line.includes('src/db/base.repository.js') &&
      !line.includes('src\\db\\base.repository.js') &&
      !line.includes('node:internal') &&
      !line.includes('extractCaller')
    ) {
      const match = line.match(/at\s+(?:async\s+)?([^\s(]+)\s+\((.+):(\d+):(\d+)\)/) ||
                    line.match(/at\s+(.+):(\d+):(\d+)/);
      if (match) {
        const method = match[1] || 'anonymous';
        const filePart = (match[2] || '').split(/[\\/]/).pop();
        const lineNum = match[3] || '0';
        return `${method} (${filePart}:${lineNum})`;
      }
    }
  }
  return 'unknown';
}

/**
 * Extracts sanitized query identifier without logging sensitive query values.
 */
function extractQueryName(sql) {
  if (!sql || typeof sql !== 'string') return 'UNKNOWN';
  const commentMatch = sql.match(/^\s*\/\*\s*([^*]+?)\s*\*\//);
  if (commentMatch) {
    return commentMatch[1].trim();
  }
  const cleanSql = sql.replace(/\/\*[\s\S]*?\*\/|--.*$/gm, '').trim();
  const cteMatch = cleanSql.match(/^WITH\s+([a-zA-Z0-9_]+)/i);
  if (cteMatch) {
    return `WITH ${cteMatch[1]}`;
  }
  const opMatch = cleanSql.match(/^(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-zA-Z0-9_.]+)/i);
  if (opMatch) {
    return `${opMatch[1].toUpperCase()} ${opMatch[2]}`;
  }
  return cleanSql.slice(0, 50).replace(/\s+/g, ' ');
}

/**
 * Safely executes a parameterized query with granular timing breakdown.
 */
async function query(text, params = [], options = {}, isRetry = false) {
  if (typeof options === 'boolean') {
    isRetry = options;
    options = {};
  }

  const ctx = getContext() || {};
  const poolInstance = getPool();
  const callerMethod = options.method || extractCaller();
  const queryName = options.queryName || extractQueryName(text);

  const t0 = performance.now();
  let client;
  let connectionWaitMs = 0;
  let executionMs = 0;
  let processingMs = 0;
  let releaseMs = 0;
  let totalMs = 0;
  let rowCount = 0;

  try {
    const tAcquireStart = performance.now();
    client = await poolInstance.connect();
    const tAcquireEnd = performance.now();
    connectionWaitMs = Math.round(tAcquireEnd - tAcquireStart);

    const tExecStart = performance.now();
    const res = await client.query(text, params);
    const tExecEnd = performance.now();
    executionMs = Math.round(tExecEnd - tExecStart);

    const tProcStart = performance.now();
    rowCount = res ? (res.rowCount ?? (Array.isArray(res.rows) ? res.rows.length : 0)) : 0;
    const tProcEnd = performance.now();
    processingMs = Math.round(tProcEnd - tProcStart);

    return res;
  } catch (err) {
    executionMs = Math.round(performance.now() - t0 - connectionWaitMs);
    const isConnErr = err.message && (
      err.message.includes('Connection terminated') ||
      err.message.includes('timeout') ||
      err.message.includes('ECONNRESET')
    );
    if (isConnErr && !isRetry) {
      logger.warn('Retrying Admin query after transient connection drop', {
        requestId: ctx.requestId || null,
        route: ctx.route || null,
        message: err.message,
      });
      return query(text, params, options, true);
    }

    logger.error('Database query error', {
      requestId: ctx.requestId || null,
      route: ctx.route || null,
      'repository/method': callerMethod,
      queryName,
      code: err.code || 'UNKNOWN',
      message: err.message,
      connectionWaitMs,
      executionMs,
      poolTotal: poolInstance.totalCount,
      poolIdle: poolInstance.idleCount,
      poolWaiting: poolInstance.waitingCount,
    });
    throw err;
  } finally {
    if (client) {
      const tReleaseStart = performance.now();
      try {
        client.release();
      } catch (_) {}
      client = null;
      releaseMs = Math.round(performance.now() - tReleaseStart);
    }
    const tEnd = performance.now();
    totalMs = Math.round(tEnd - t0);

    if (totalMs > 1000) {
      logger.warn('Slow query detected', {
        requestId: ctx.requestId || null,
        route: ctx.route || null,
        'repository/method': callerMethod,
        queryName,
        connectionWaitMs,
        executionMs,
        processingMs,
        releaseMs,
        totalMs,
        rowCount,
        poolTotal: poolInstance.totalCount,
        poolIdle: poolInstance.idleCount,
        poolWaiting: poolInstance.waitingCount,
      });
    }
  }
}

/**
 * Executes a transactional block with automatic BEGIN, COMMIT, and ROLLBACK.
 */
async function transaction(callback, options = {}) {
  const ctx = getContext() || {};
  const poolInstance = getPool();
  const callerMethod = options.method || extractCaller();

  const t0 = performance.now();
  let client;
  let connectionWaitMs = 0;
  let executionMs = 0;
  let releaseMs = 0;
  let totalMs = 0;

  try {
    const tAcquireStart = performance.now();
    client = await poolInstance.connect();
    connectionWaitMs = Math.round(performance.now() - tAcquireStart);

    // Instrument client.query inside transaction
    const origClientQuery = client.query.bind(client);
    client.query = async function (qText, qParams) {
      const qStart = performance.now();
      try {
        const res = await origClientQuery(qText, qParams);
        const qExec = Math.round(performance.now() - qStart);
        const qRows = res ? (res.rowCount ?? (Array.isArray(res.rows) ? res.rows.length : 0)) : 0;
        if (qExec > 1000) {
          logger.warn('Slow query detected', {
            requestId: ctx.requestId || null,
            route: ctx.route || null,
            'repository/method': callerMethod,
            queryName: extractQueryName(qText),
            connectionWaitMs: 0,
            executionMs: qExec,
            processingMs: 0,
            totalMs: qExec,
            rowCount: qRows,
            poolTotal: poolInstance.totalCount,
            poolIdle: poolInstance.idleCount,
            poolWaiting: poolInstance.waitingCount,
          });
        }
        return res;
      } catch (qErr) {
        throw qErr;
      }
    };

    const tExecStart = performance.now();
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    executionMs = Math.round(performance.now() - tExecStart);
    return result;
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('Transaction rollback failed', { code: rollbackErr.code || 'UNKNOWN' });
      }
    }
    executionMs = Math.round(performance.now() - t0 - connectionWaitMs);
    logger.error('Transaction failed', {
      requestId: ctx.requestId || null,
      route: ctx.route || null,
      'repository/method': callerMethod,
      code: err.code || 'UNKNOWN',
      message: err.message,
      connectionWaitMs,
      executionMs,
      poolTotal: poolInstance.totalCount,
      poolIdle: poolInstance.idleCount,
      poolWaiting: poolInstance.waitingCount,
    });
    throw err;
  } finally {
    if (client) {
      const tReleaseStart = performance.now();
      try {
        client.release();
      } catch (_) {}
      client = null;
      releaseMs = Math.round(performance.now() - tReleaseStart);
    }
    totalMs = Math.round(performance.now() - t0);
    if (totalMs > 1000) {
      logger.warn('Slow transaction detected', {
        requestId: ctx.requestId || null,
        route: ctx.route || null,
        'repository/method': callerMethod,
        'method/queryName': options.name || 'TRANSACTION',
        connectionWaitMs,
        executionMs,
        releaseMs,
        totalMs,
        poolTotal: poolInstance.totalCount,
        poolIdle: poolInstance.idleCount,
        poolWaiting: poolInstance.waitingCount,
      });
    }
  }
}

module.exports = {
  get pool() {
    return getPool();
  },
  query,
  transaction,
  checkDbHealth,
  connectDatabase,
  disconnectDatabase,
  setMockPool,
  resetMockPool,
};
