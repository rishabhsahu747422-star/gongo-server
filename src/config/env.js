'use strict';

require('dotenv').config();

const { cleanEnv, str, port, bool, num } = require('envalid');

/**
 * Unified-process configuration only. Each sub-app (Customer, Partner, Admin)
 * validates its own variables (DATABASE_URL, SUPABASE_*, CASHFREE_*, ...) on load.
 */
const env = cleanEnv(
  process.env,
  {
    NODE_ENV: str({
      choices: ['development', 'test', 'production'],
      default: 'development',
      docs: 'Application environment mode',
    }),
    PORT: port({
      default: 8080,
      docs: 'HTTP port for the unified server process',
    }),
    HOST: str({
      default: '0.0.0.0',
      docs: 'Interface to bind the HTTP listener to',
    }),
    CORS_ORIGINS: str({
      default: '',
      devDefault: 'http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:5173,http://localhost:8081,http://localhost:8080',
      docs: 'Allowed browser CORS origins, comma-separated. Merged with the sub-app lists CORS_ORIGIN and CORS_ALLOWED_ORIGINS.',
    }),
    TRUST_PROXY: str({
      default: 'false',
      docs: "Express 'trust proxy' setting for the unified app: false, a hop count (e.g. 1), or a subnet list",
    }),
    ENABLE_WORKERS: bool({
      default: true,
      devDefault: true,
      docs: 'Run background workers (no-show auto-cancellation, partner/admin outbox) in this process. Workers use SKIP LOCKED and are safe on multiple instances.',
    }),
    DB_POOL_MIN: num({
      default: 0,
      docs: 'Minimum PostgreSQL connections per pool (defaults to 0 for Supabase session pooler compatibility)',
    }),
    DB_POOL_MAX: num({
      default: 3,
      docs: 'Maximum PostgreSQL connections per pool (defaults to 3, yielding 9 max across 3 pools)',
    }),
  },
  {
    strict: false,
  },
);

if (env.DB_POOL_MIN < 0) {
  throw new Error('DB_POOL_MIN must be >= 0');
}
if (env.DB_POOL_MAX < 1) {
  throw new Error('DB_POOL_MAX must be >= 1');
}
if (env.DB_POOL_MIN > env.DB_POOL_MAX) {
  throw new Error(`DB_POOL_MIN (${env.DB_POOL_MIN}) must be <= DB_POOL_MAX (${env.DB_POOL_MAX})`);
}

module.exports = env;
