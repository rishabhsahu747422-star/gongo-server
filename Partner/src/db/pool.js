'use strict';

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const { performance } = require('perf_hooks');
const { Pool } = require('pg');
const env = require('../config/env');
const logger = require('../config/logger');
const { getContext } = require('../utils/context');

let sslConfig = false;
if (env.DB_SSL || env.NODE_ENV === 'production' || (env.DATABASE_URL && (env.DATABASE_URL.includes('supabase.co') || env.DATABASE_URL.includes('supabase.com')))) {
  sslConfig = { rejectUnauthorized: false };
}

let keepAliveTimer = null;

const poolMin = typeof env.DB_POOL_MIN === 'number' && !Number.isNaN(env.DB_POOL_MIN) ? Math.max(0, env.DB_POOL_MIN) : 0;
const poolMax = typeof env.DB_POOL_MAX === 'number' && !Number.isNaN(env.DB_POOL_MAX) ? Math.max(1, env.DB_POOL_MAX) : 3;
const safeMin = Math.min(poolMin, poolMax);

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  min: safeMin,
  max: poolMax,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS ?? 30000,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS ?? 10000,
  ssl: sslConfig,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('connect', (client) => {
  client.on('error', (err) => {
    logger.warn('PostgreSQL client socket error (non-fatal, auto-reconnected by pool)', {
      code: err.code || 'UNKNOWN',
      message: err.message,
    });
  });
});

pool.on('error', (err) => {
  logger.error('PostgreSQL background pool error', {
    code: err.code || 'UNKNOWN',
    name: err.name,
  });
});

/**
 * Startup connectivity check with lightweight single-connection probe.
 */
async function connectDatabase() {
  if (env.NODE_ENV === 'test') {
    return;
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    logger.info('PostgreSQL connection established successfully', {
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
    });

    // Only keep connections warm in background if min pool size > 0
    if (safeMin > 0 && !keepAliveTimer && env.NODE_ENV !== 'test') {
      keepAliveTimer = setInterval(() => {
        pool.query('SELECT 1').catch(() => {});
      }, 45000);
      if (keepAliveTimer.unref) keepAliveTimer.unref();
    }
  } catch (err) {
    logger.error('PostgreSQL connection failed during startup probe', {
      code: err.code || 'UNKNOWN',
      message: err.message,
    });
    process.stderr.write(`[POSTGRES] Startup connection probe failed: ${err.message} (${err.code || 'UNKNOWN'})\n`);
    if (env.isProduction) {
      throw new Error(`Database connection failed (${err.code || err.message}) — check DATABASE_URL and database status`);
    }
    logger.warn('Server starting in degraded state: database is currently unreachable. Dependent endpoints will return 503.');
  } finally {
    if (client) {
      try {
        client.release();
      } catch (_) {}
    }
  }
}

/**
 * Health check probe returning boolean status and response latency.
 */
async function checkDbHealth() {
  let client;
  const start = Date.now();
  try {
    client = await pool.connect();
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
    await pool.end();
    logger.info('PostgreSQL pool closed gracefully');
  } catch (err) {
    logger.error('Error closing PostgreSQL pool', { code: err.code || 'UNKNOWN' });
  }
}

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
async function query(text, params = [], options = {}) {
  const ctx = getContext() || {};
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
    client = await pool.connect();
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
    logger.error('Database query error', {
      requestId: ctx.requestId || null,
      route: ctx.route || null,
      repository: callerMethod,
      'method/queryName': queryName,
      code: err.code || 'UNKNOWN',
      message: err.message,
      connectionWaitMs,
      executionMs,
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
    });
    throw err;
  } finally {
    if (client) {
      const tReleaseStart = performance.now();
      client.release();
      client = null;
      const tReleaseEnd = performance.now();
      releaseMs = Math.round(tReleaseEnd - tReleaseStart);
    }
    const tEnd = performance.now();
    totalMs = Math.round(tEnd - t0);

    if (totalMs > 1000) {
      logger.warn('Slow query detected', {
        requestId: ctx.requestId || null,
        route: ctx.route || null,
        repository: callerMethod,
        'method/queryName': queryName,
        connectionWaitMs,
        executionMs,
        processingMs,
        releaseMs,
        totalMs,
        rowCount,
        poolTotal: pool.totalCount,
        poolIdle: pool.idleCount,
        poolWaiting: pool.waitingCount,
      });
    }
  }
}

/**
 * Executes a transactional block with automatic BEGIN, COMMIT, and ROLLBACK and granular timing.
 */
async function transaction(callback, options = {}) {
  const ctx = getContext() || {};
  const callerMethod = options.method || extractCaller();
  const t0 = performance.now();
  let client;
  let connectionWaitMs = 0;
  let executionMs = 0;
  let releaseMs = 0;
  let totalMs = 0;

  try {
    const tAcquireStart = performance.now();
    client = await pool.connect();
    const tAcquireEnd = performance.now();
    connectionWaitMs = Math.round(tAcquireEnd - tAcquireStart);

    const tExecStart = performance.now();
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    const tExecEnd = performance.now();
    executionMs = Math.round(tExecEnd - tExecStart);

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
      repository: callerMethod,
      code: err.code || 'UNKNOWN',
      message: err.message,
      connectionWaitMs,
      executionMs,
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
    });
    throw err;
  } finally {
    if (client) {
      const tReleaseStart = performance.now();
      client.release();
      client = null;
      const tReleaseEnd = performance.now();
      releaseMs = Math.round(tReleaseEnd - tReleaseStart);
    }
    const tEnd = performance.now();
    totalMs = Math.round(tEnd - t0);

    if (totalMs > 1000) {
      logger.warn('Slow transaction detected', {
        requestId: ctx.requestId || null,
        route: ctx.route || null,
        repository: callerMethod,
        'method/queryName': options.name || 'TRANSACTION',
        connectionWaitMs,
        executionMs,
        releaseMs,
        totalMs,
        poolTotal: pool.totalCount,
        poolIdle: pool.idleCount,
        poolWaiting: pool.waitingCount,
      });
    }
  }
}

module.exports = {
  pool,
  query,
  transaction,
  checkDbHealth,
  connectDatabase,
  disconnectDatabase,
};
