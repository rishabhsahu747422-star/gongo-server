'use strict';

require('dotenv').config();

const { cleanEnv, str, port, url, num, bool, makeValidator } = require('envalid');

/**
 * Custom validator for comma-separated non-empty strings.
 * Used for CORS_ALLOWED_ORIGINS.
 * Enforces NO wildcards in production environment.
 */
const corsOriginValidator = makeValidator((value) => {
  if (!value || value.trim() === '') {
    throw new Error('CORS_ALLOWED_ORIGINS must be a non-empty comma-separated list of origins');
  }
  const origins = value.split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS must contain at least one valid origin');
  }
  if (process.env.NODE_ENV === 'production') {
    const hasWildcard = origins.some((o) => o === '*' || o.includes('*'));
    if (hasWildcard) {
      throw new Error("Wildcard '*' is strictly forbidden in CORS_ALLOWED_ORIGINS for production");
    }
  }
  return origins;
});

/**
 * Custom validator for Express trust proxy values.
 * Prevents IP spoofing attacks via X-Forwarded-For.
 */
const trustProxyValidator = makeValidator((value) => {
  const trimmed = (value || '').trim();
  if (trimmed === '') return 'false';

  if (trimmed === 'true') {
    throw new Error(
      "TRUST_PROXY='true' blindly trusts all X-Forwarded-For headers and allows IP spoofing. "
      + "Use 'loopback', a hop count (e.g. '1'), or a CIDR range instead.",
    );
  }

  return trimmed;
});

const customReporter = ({ errors }) => {
  const errorKeys = Object.keys(errors);
  if (errorKeys.length > 0) {
    const messages = errorKeys.map((key) => `${key}: ${errors[key].message || errors[key]}`);
    throw new Error(`Invalid environment variables:\n${messages.join('\n')}`);
  }
};

const env = cleanEnv(
  process.env,
  {
    // Application
    NODE_ENV: str({
      choices: ['development', 'test', 'production'],
      default: 'development',
      docs: 'Runtime environment',
    }),
    PORT: port({
      default: 3002,
      docs: 'HTTP server port',
    }),
    API_PREFIX: str({
      default: '/api/v1',
      docs: 'API prefix path',
    }),
    LOG_LEVEL: str({
      choices: ['error', 'warn', 'info', 'http', 'debug'],
      default: 'info',
      docs: 'Logging level',
    }),
    TRUST_PROXY: trustProxyValidator({
      default: 'false',
      docs: "Express trust proxy setting. Use 'loopback', numeric hop count, or CIDR. Never 'true'.",
    }),

    // CORS
    CORS_ALLOWED_ORIGINS: corsOriginValidator({
      default: 'http://localhost:3000,http://localhost:5173,http://localhost:8080',
      docs: 'Comma-separated list of allowed origins',
    }),

    // PostgreSQL Database (Shared Canonical Database)
    DATABASE_URL: url({
      default: 'postgresql://postgres:postgres@localhost:5432/gongo_partner',
      docs: 'PostgreSQL connection URL',
    }),
    DB_HOST: str({ default: 'localhost', docs: 'Database host' }),
    DB_PORT: port({ default: 5432, docs: 'Database port' }),
    DB_NAME: str({ default: 'gongo_partner', docs: 'Database name' }),
    DB_USER: str({ default: 'postgres', docs: 'Database user' }),
    DB_PASSWORD: str({ default: 'postgres', docs: 'Database password' }),
    DB_POOL_MIN: num({ default: 0, docs: 'Minimum DB connections (0 allows idle scale-down in session pooler mode)' }),
    DB_POOL_MAX: num({ default: 3, docs: 'Maximum DB connections' }),
    DB_IDLE_TIMEOUT_MS: num({ default: 30000, docs: 'Idle connection timeout in ms' }),
    DB_CONNECTION_TIMEOUT_MS: num({ default: 10000, docs: 'Connection timeout in ms' }),
    DB_SSL: bool({ default: false, docs: 'Use SSL for DB connection' }),
    ALLOW_DEV_DB_FALLBACK: bool({ default: false, docs: 'Allow dev database fallback' }),

    // Redis
    REDIS_URL: url({
      default: 'redis://localhost:6379',
      docs: 'Redis connection URL',
    }),
    USE_REDIS_MOCK: bool({
      default: false,
      docs: 'Use mock Redis for tests',
    }),

    // Rate Limiting
    RATE_LIMIT_WINDOW_MS: num({
      default: 60000,
      docs: 'Rate limiting window in milliseconds',
    }),
    RATE_LIMIT_MAX_REQUESTS: num({
      default: 100,
      docs: 'Max requests per window',
    }),

    // Admin Password Login
    ADMIN_LOGIN_MAX_FAILED_ATTEMPTS: num({
      default: 5,
      docs: 'Consecutive wrong passwords before an admin account is temporarily locked',
    }),
    ADMIN_LOGIN_LOCKOUT_SECONDS: num({
      default: 900,
      docs: 'Temporary lock duration after too many failed admin logins',
    }),
    ADMIN_LEGACY_SUPABASE_PASSWORD_MIGRATION: bool({
      default: true,
      docs: 'One-time migration of admins provisioned in Supabase Auth: on first login without a local '
        + 'credential, verify against Supabase (bound to users.auth_id) and store a local hash',
    }),

    // Google OAuth (Admin Portal). All four must be set to enable Google sign-in.
    GOOGLE_CLIENT_ID: str({ default: '', docs: 'Google OAuth 2.0 Web client ID' }),
    GOOGLE_CLIENT_SECRET: str({ default: '', docs: 'Google OAuth 2.0 Web client secret' }),
    GOOGLE_CALLBACK_URL: str({
      default: '',
      docs: 'Exact redirect URI registered in Google Cloud, e.g. https://api.example.com/api/v1/admin/auth/google/callback',
    }),
    ADMIN_OAUTH_REDIRECT_URL: str({
      default: '',
      docs: 'Admin Portal page that receives #ticket=... or #error=... after Google sign-in',
    }),
    GOOGLE_OAUTH_STATE_TTL_SECONDS: num({
      default: 600,
      docs: 'Lifetime of a pending Google OAuth state (seconds)',
    }),
    ADMIN_GOOGLE_REQUIRE_OTP: bool({
      default: false,
      docs: 'Whether Google OAuth sign-in requires secondary SMS OTP verification',
    }),

    // Admin Session Lifecycle
    ADMIN_SESSION_TTL_SECONDS: num({
      default: 86400, // 24 hours
      docs: 'Admin session lifetime in seconds (server policy)',
    }),
    ADMIN_MAX_ACTIVE_SESSIONS: num({
      default: 5,
      docs: 'Maximum concurrent active sessions per admin user (0 for unlimited)',
    }),
    ADMIN_SESSION_ACTIVITY_THROTTLE_SECONDS: num({
      default: 60,
      docs: 'Throttle interval in seconds for last_active_at updates',
    }),

    // Supabase Configuration (Database, Storage, legacy admin password migration)
    SUPABASE_URL: str({
      default: 'https://mtfljykvxyslhdvpfcil.supabase.co',
      docs: 'Supabase project URL',
    }),
    SUPABASE_ANON_KEY: str({
      default: '',
      docs: 'Supabase anonymous public API key',
    }),
    SUPABASE_SERVICE_ROLE_KEY: str({
      default: '',
      docs: 'Supabase privileged service role API key',
    }),
    SUPABASE_STORAGE_BUCKET: str({
      default: 'gongo-uploads',
      docs: 'Supabase Storage bucket name',
    }),
    SUPABASE_S3_ENDPOINT: str({
      default: '',
      docs: 'Optional Supabase S3-compatible storage endpoint URL',
    }),

    // AWS S3 Configuration
    AWS_REGION: str({ default: 'ap-south-1', docs: 'AWS Region' }),
    AWS_ACCESS_KEY_ID: str({ default: '', docs: 'AWS Access Key ID' }),
    AWS_SECRET_ACCESS_KEY: str({ default: '', docs: 'AWS Secret Access Key' }),
    AWS_S3_BUCKET: str({ default: 'gongo-admin-documents', docs: 'AWS S3 Bucket' }),
    AWS_S3_PUBLIC: bool({ default: false, docs: 'Is S3 bucket public (must be false)' }),
    AWS_S3_PRESIGN_UPLOAD_EXPIRES_SECONDS: num({
      default: 900,
      docs: 'Presigned upload URL expiration in seconds (default: 15m)',
    }),
    AWS_S3_PRESIGN_DOWNLOAD_EXPIRES_SECONDS: num({
      default: 300,
      docs: 'Presigned download URL expiration in seconds (default: 5m)',
    }),
    AWS_S3_MAX_UPLOAD_SIZE_BYTES: num({
      default: 10485760,
      docs: 'Maximum allowed upload size in bytes (default: 10MB)',
    }),

    // Cashfree Payment Gateway Configuration
    CASHFREE_APP_ID: str({
      default: 'test_cashfree_app_id',
      docs: 'Cashfree App ID for payment gateway integration',
    }),
    CASHFREE_SECRET_KEY: str({
      default: 'test_cashfree_secret_key',
      docs: 'Cashfree Secret Key for payment gateway integration',
    }),
    CASHFREE_ENV: str({
      choices: ['SANDBOX', 'PRODUCTION'],
      default: 'SANDBOX',
      docs: 'Cashfree environment (SANDBOX or PRODUCTION)',
    }),
    CASHFREE_API_VERSION: str({
      default: '2023-08-01',
      docs: 'Cashfree API Version',
    }),

    // Renflair SMS Gateway Provider (Admin OTP)
    RENFLAIR_API_KEY: str({ default: '', docs: 'Renflair SMS API key for admin OTP delivery' }),
    RENFLAIR_BASE_URL: str({ default: 'https://sms.renflair.in/V1.php', docs: 'Renflair SMS API base URL' }),
    AUTH_OTP_EXPIRY_SECONDS: num({ default: 300, docs: 'Admin OTP validity in seconds (default: 5m)' }),
    AUTH_OTP_RESEND_COOLDOWN_SECONDS: num({ default: 60, docs: 'Admin OTP resend cooldown in seconds (default: 60s)' }),
    AUTH_OTP_MAX_ATTEMPTS: num({ default: 3, docs: 'Maximum failed OTP verification attempts' }),

    // Outbox background worker
    ENABLE_OUTBOX_WORKER: str({
      default: 'true',
      docs: 'Enable background outbox worker',
    }),
  },
  {
    reporter: customReporter,
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

// Production fail-fast checks
if (env.isProduction) {
  if (!process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_URL is strictly required in production');
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is strictly required in production');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is strictly required in production');
  }
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is strictly required in production');
  }
  if (env.USE_REDIS_MOCK) {
    throw new Error('USE_REDIS_MOCK must not be enabled in production');
  }
  // The development auth bypass has been removed; refuse to boot if a deployment still
  // believes it can turn it on, so the stale setting is noticed rather than silently ignored.
  if (['true', '1', 'yes'].includes(String(process.env.ADMIN_DEV_AUTH_ENABLED || '').toLowerCase())) {
    throw new Error('ADMIN_DEV_AUTH_ENABLED is no longer supported and must not be set in production');
  }
  const googleVars = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL', 'ADMIN_OAUTH_REDIRECT_URL'];
  const googleSet = googleVars.filter((key) => env[key]);
  if (googleSet.length > 0 && googleSet.length < googleVars.length) {
    throw new Error(
      `Google OAuth is partially configured; set all of ${googleVars.join(', ')} or none`,
    );
  }
  if (googleSet.length === googleVars.length) {
    ['GOOGLE_CALLBACK_URL', 'ADMIN_OAUTH_REDIRECT_URL'].forEach((key) => {
      if (env[key] && !env[key].startsWith('https://')) {
        throw new Error(`${key} must use https in production`);
      }
    });
  }
  if (env.AWS_S3_PUBLIC) {
    throw new Error('AWS_S3_PUBLIC must strictly be false in production');
  }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are strictly required in production',
    );
  }
  if (!process.env.AWS_S3_BUCKET) {
    throw new Error('AWS_S3_BUCKET is strictly required in production');
  }
  if (env.CASHFREE_ENV === 'PRODUCTION') {
    if (
      !process.env.CASHFREE_APP_ID
      || process.env.CASHFREE_APP_ID === 'test_cashfree_app_id'
      || !process.env.CASHFREE_SECRET_KEY
      || process.env.CASHFREE_SECRET_KEY === 'test_cashfree_secret_key'
    ) {
      throw new Error(
        'Production CASHFREE_APP_ID and CASHFREE_SECRET_KEY are strictly required when CASHFREE_ENV=PRODUCTION',
      );
    }
  }
}

module.exports = env;
