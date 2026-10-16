'use strict';

require('dotenv').config();

const { cleanEnv, str, port, bool } = require('envalid');

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
  },
  {
    strict: false,
  },
);

module.exports = env;
