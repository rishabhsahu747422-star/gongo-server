'use strict';

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const { performance } = require('perf_hooks');
const { Pool } = require('pg');
const env = require('./env');
const logger = require('./logger');
const { getContext } = require('../utils/context');

/**
 * Configure SSL based on environment and explicit DB_SSL flag.
 * In production, rejects unauthorized certificates by default.
 */
let sslConfig = false;
const isSupabase = env.DATABASE_URL && (env.DATABASE_URL.includes('supabase.co') || env.DATABASE_URL.includes('pooler.supabase.com'));
if (env.DB_SSL || isSupabase) {
  sslConfig = { rejectUnauthorized: false };
} else if (env.NODE_ENV === 'production') {
  sslConfig = { rejectUnauthorized: true };
}

let keepAliveTimer = null;

const poolMin = typeof env.DB_POOL_MIN === 'number' && !Number.isNaN(env.DB_POOL_MIN) ? Math.max(0, env.DB_POOL_MIN) : 0;
const poolMax = typeof env.DB_POOL_MAX === 'number' && !Number.isNaN(env.DB_POOL_MAX) ? Math.max(1, env.DB_POOL_MAX) : 3;
const safeMin = Math.min(poolMin, poolMax);

/**
 * PostgreSQL connection pool.
 *
 * Connections are acquired lazily on demand and recycled.
 */
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

/**
 * Log pool-level errors safely without crashing.
 * Credentials and raw connection strings are never logged.
 */
pool.on('error', (err) => {
  logger.error('PostgreSQL pool background error', {
    code: err.code || 'UNKNOWN',
    name: err.name,
  });
});

/**
 * Verifies database connectivity at application startup with a lightweight single-connection probe.
 * Does not pre-allocate or hold multiple connections unnecessarily.
 *
 * @returns {Promise<void>}
 * @throws {Error} If the database is unreachable
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
        pool.query('SELECT 1').catch(() => { });
      }, 45000);
      if (keepAliveTimer.unref) keepAliveTimer.unref();
    }
  } catch (err) {
    logger.error('PostgreSQL connection failed during startup probe', {
      code: err.code || 'UNKNOWN',
      message: err.message,
    });
    throw new Error('Database connection failed — check DATABASE_URL and database service status');
  } finally {
    if (client) {
      try {
        client.release();
      } catch (_) { }
    }
  }
}

/**
 * Gracefully terminates the connection pool.
 * Drains all active clients before resolving.
 *
 * @returns {Promise<void>}
 */
async function disconnectDatabase() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  try {
    await pool.end();
    logger.info('PostgreSQL connection pool drained and closed');
  } catch (err) {
    logger.error('Error during PostgreSQL pool shutdown', { code: err.code || 'UNKNOWN' });
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
      !line.includes('src/config/database.js') &&
      !line.includes('src\\config\\database.js') &&
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
 * Executes a parameterized SQL query against the connection pool with granular timing breakdown.
 *
 * @param {string} text - Parameterized SQL query
 * @param {Array<any>} [params] - Query parameters
 * @param {object} [options] - Optional caller method override or queryName
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params = [], options = {}, isRetry = false) {
  // Support legacy signature query(text, params, isRetry)
  if (typeof options === 'boolean') {
    isRetry = options;
    options = {};
  }

  if (process.env.NODE_ENV === 'test') {
    return pool.query(text, params);
  }

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
    const isConnErr = err.message && (
      err.message.includes('Connection terminated') ||
      err.message.includes('timeout') ||
      err.message.includes('ECONNRESET')
    );
    if (isConnErr && !isRetry) {
      logger.warn('Retrying query after transient connection drop', {
        requestId: ctx.requestId || null,
        route: ctx.route || null,
        message: err.message,
      });
      return query(text, params, options, true);
    }

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
 * Executes a database transaction with automatic BEGIN, COMMIT, and ROLLBACK and granular timing.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} callback
 *   Transaction execution callback
 * @param {object} [options]
 * @returns {Promise<T>}
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
  connectDatabase,
  disconnectDatabase,
};
