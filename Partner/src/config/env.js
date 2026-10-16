'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

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
  // If in production, strictly disallow '*'
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
      default: 3001,
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
      default: 'http://localhost:3000,http://localhost:8081,http://localhost:19006',
      docs: 'Comma-separated list of allowed origins',
    }),

    // PostgreSQL Database
    DATABASE_URL: url({
      default: 'postgresql://postgres:postgres@localhost:5432/gongo_partner',
      docs: 'PostgreSQL connection URL',
    }),
    DB_HOST: str({ default: 'localhost', docs: 'Database host' }),
    DB_PORT: port({ default: 5432, docs: 'Database port' }),
    DB_NAME: str({ default: 'gongo_partner', docs: 'Database name' }),
    DB_USER: str({ default: 'postgres', docs: 'Database user' }),
    DB_PASSWORD: str({ default: 'postgres', docs: 'Database password' }),
    DB_POOL_MIN: num({ default: 2, docs: 'Minimum DB connections' }),
    DB_POOL_MAX: num({ default: 10, docs: 'Maximum DB connections' }),
    DB_IDLE_TIMEOUT_MS: num({ default: 300000, docs: 'Idle connection timeout in ms' }),
    DB_CONNECTION_TIMEOUT_MS: num({ default: 10000, docs: 'Connection timeout in ms' }),
    DB_SSL: bool({ default: false, docs: 'Use SSL for DB connection' }),

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

    // Supabase Configuration (Auth & Storage)
    SUPABASE_URL: str({
      default: 'https://mtfljykvxyslhdvpfcil.supabase.co',
      docs: 'Supabase Project URL',
    }),
    SUPABASE_ANON_KEY: str({
      default: 'mock-anon-key',
      docs: 'Supabase Anonymous Key (safe for public clients)',
    }),
    SUPABASE_SERVICE_ROLE_KEY: str({
      default: 'mock-service-role-key',
      docs: 'Supabase Service Role Key (strictly backend-only, bypasses RLS)',
    }),
    SUPABASE_STORAGE_BUCKET: str({
      default: 'gongo-partner-documents',
      docs: 'Supabase Storage Bucket name',
    }),
    SUPABASE_STORAGE_PRESIGN_UPLOAD_EXPIRES_SECONDS: num({
      default: 900,
      docs: 'Presigned upload URL expiration in seconds (default: 15m)',
    }),
    SUPABASE_STORAGE_PRESIGN_DOWNLOAD_EXPIRES_SECONDS: num({
      default: 300,
      docs: 'Presigned download URL expiration in seconds (default: 5m)',
    }),
    SUPABASE_STORAGE_MAX_UPLOAD_SIZE_BYTES: num({
      default: 10485760,
      docs: 'Maximum allowed upload size in bytes (default: 10MB)',
    }),

    // Legacy S3 compatibility flags (optional)
    AWS_S3_PRESIGN_UPLOAD_EXPIRES_SECONDS: num({
      default: 900,
      docs: 'Presigned upload URL expiration in seconds (default: 15m)',
    }),
    AWS_S3_PRESIGN_DOWNLOAD_EXPIRES_SECONDS: num({
      default: 300,
      docs: 'Presigned download URL expiration in seconds (default: 5m)',
    }),

    // Renflair SMS Gateway
    RENFLAIR_API_KEY: str({ default: '', docs: 'Renflair SMS Gateway API Key' }),
    RENFLAIR_BASE_URL: str({ default: 'https://sms.renflair.in/V1.php', docs: 'Renflair SMS Gateway API URL' }),
    AUTH_OTP_EXPIRY_SECONDS: num({ default: 300, docs: 'OTP expiration in seconds (default: 5m)' }),
    AUTH_OTP_RESEND_COOLDOWN_SECONDS: num({ default: 60, docs: 'OTP resend cooldown in seconds (default: 60s)' }),
    AUTH_OTP_MAX_ATTEMPTS: num({ default: 3, docs: 'Maximum OTP verification attempts before lockout' }),
    OTP_RESEND_COOLDOWN_SECONDS: num({ default: 30, docs: 'Partner OTP resend cooldown in seconds (default: 30s)' }),
    OTP_EXPIRY_SECONDS: num({ default: 300, docs: 'Partner OTP expiration in seconds (default: 300s)' }),

    // MSG91 SMS Placeholders (Future Phase)
    MSG91_AUTH_KEY: str({ default: '', docs: 'MSG91 API Auth Key' }),
    MSG91_TEMPLATE_ID: str({ default: '', docs: 'MSG91 Template ID' }),
    MSG91_SENDER_ID: str({ default: 'GONGOI', docs: 'MSG91 Sender ID' }),

    // Cashfree Payment Gateway & Payouts
    CASHFREE_APP_ID: str({ default: '', docs: 'Cashfree App ID' }),
    CASHFREE_SECRET_KEY: str({ default: '', docs: 'Cashfree Secret Key' }),
    CASHFREE_ENV: str({
      choices: ['SANDBOX', 'PRODUCTION', 'sandbox', 'production'],
      default: 'SANDBOX',
      docs: 'Cashfree Environment',
    }),
    CASHFREE_API_VERSION: str({ default: '2023-08-01', docs: 'Cashfree Payment Gateway API Version' }),
    CASHFREE_PAYOUT_API_VERSION: str({ default: '2024-01-01', docs: 'Cashfree Payouts API Version' }),
    CASHFREE_PAYOUT_BASE_URL: str({ default: '', docs: 'Optional custom Cashfree Payouts Base URL' }),

    // Bank Account & Sensitive Data Encryption
    ENCRYPTION_KEY: str({
      default: '',
      docs: '32-byte secret key for AES-256-GCM bank account encryption',
    }),

    // Development-Only Partner Authentication (Strictly non-production)
    PARTNER_DEV_AUTH_ENABLED: bool({
      default: false,
      docs: 'Enable development-only authenticated test mechanism (strictly non-production)',
    }),
    PARTNER_DEV_AUTH_ID: str({
      default: 'dev-partner-auth-id',
      docs: 'Designated development auth ID (maps to users.auth_id)',
    }),
    PARTNER_DEV_LOGIN_ENABLED: bool({
      default: false,
      docs: 'Enable development-only partner login bypass (strictly non-production)',
    }),
    PARTNER_DEV_PHONE: str({
      default: '9999999999',
      docs: 'Partner Dev Login mobile number',
    }),
    PARTNER_DEV_CODE: str({
      default: '123456',
      docs: 'Partner Dev Login verification code',
    }),
  },
  {
    reporter: customReporter,
  },
);

// Production fail-fast checks
if (env.isProduction) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is strictly required in production');
  }
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is strictly required in production');
  }
  if (env.USE_REDIS_MOCK) {
    throw new Error('USE_REDIS_MOCK must not be enabled in production');
  }
  if (!process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_URL is strictly required in production');
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY.includes('mock')) {
    throw new Error('Valid SUPABASE_SERVICE_ROLE_KEY is strictly required in production');
  }
  if (!process.env.SUPABASE_STORAGE_BUCKET) {
    throw new Error('SUPABASE_STORAGE_BUCKET is strictly required in production');
  }
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is strictly required in production');
  }
  if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
    throw new Error('CASHFREE_APP_ID and CASHFREE_SECRET_KEY are strictly required in production');
  }
  if (process.env.PARTNER_DEV_AUTH_ENABLED === 'true' || env.PARTNER_DEV_AUTH_ENABLED) {
    throw new Error('PARTNER_DEV_AUTH_ENABLED must not be enabled in production');
  }
  if (process.env.PARTNER_DEV_LOGIN_ENABLED === 'true' || env.PARTNER_DEV_LOGIN_ENABLED) {
    throw new Error('PARTNER_DEV_LOGIN_ENABLED must not be enabled in production');
  }
}

module.exports = env;
