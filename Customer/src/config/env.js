'use strict';

const { cleanEnv, str, port, url, num, bool, makeValidator } = require('envalid');

/**
 * Custom validator for comma-separated non-empty strings.
 * Used for CORS_ORIGIN.
 */
const commaSeparatedStr = makeValidator((value) => {
  if (!value || value.trim() === '') {
    throw new Error('Must be a non-empty comma-separated string');
  }
  return value.trim();
});

/**
 * Custom validator for Express trust proxy values.
 *
 * Accepts:
 *   - 'false'              Disable proxy trust (default for local dev)
 *   - 'loopback'           Trust loopback addresses (127.0.0.1, ::1)
 *   - 'linklocal'          Trust link-local addresses (169.254.x.x)
 *   - 'uniquelocal'        Trust unique-local addresses (10.x, 172.16.x, 192.168.x)
 *   - A numeric string     Trust N hops from the front-facing proxy (e.g. '1')
 *   - A CIDR/IP string     Trust a specific IP or CIDR (e.g. '10.0.0.0/8')
 *
 * NEVER set to 'true' in production — this blindly trusts all X-Forwarded-For
 * headers and allows IP rate limit bypass via header spoofing.
 *
 * Production deployment requirement:
 *   Set TRUST_PROXY to the exact CIDR or hop count matching your load balancer
 *   configuration. Example: TRUST_PROXY=loopback (for nginx on same host),
 *   TRUST_PROXY=1 (for a single-hop ALB/GCP LB), TRUST_PROXY=10.0.0.0/8
 *   (for internal VPC load balancer range).
 */
const trustProxyValidator = makeValidator((value) => {
  const trimmed = (value || '').trim();
  if (trimmed === '') return 'false';

  // Reject the unsafe blanket-trust value
  if (trimmed === 'true') {
    throw new Error(
      "TRUST_PROXY='true' blindly trusts all X-Forwarded-For headers and allows IP rate limit bypass. "
      + "Use 'loopback', a hop count (e.g. '1'), or a CIDR range instead.",
    );
  }

  return trimmed;
});

/**
 * Validates and freezes all required environment variables at startup.
 * The application will refuse to start if any variable is missing or malformed.
 *
 * Using `cleanEnv` from envalid so every variable is:
 *   - Presence-checked
 *   - Type-coerced
 *   - Accessible as a frozen typed object
 *
 * This is the single source of truth for env configuration.
 * All other modules must import from here — never process.env directly.
 */
const env = cleanEnv(process.env, {
  // ── Application ──────────────────────────────────────────────
  NODE_ENV: str({
    choices: ['development', 'test', 'production'],
    docs: 'Runtime environment',
  }),
  PORT: port({
    default: 3000,
    docs: 'HTTP server port',
  }),
  API_VERSION: str({
    default: 'v1',
    docs: 'API version prefix (e.g. v1)',
  }),
  LOG_LEVEL: str({
    choices: ['error', 'warn', 'info', 'http', 'debug'],
    default: 'info',
    docs: 'Winston log level',
  }),

  // ── Proxy Trust ───────────────────────────────────────────────
  //
  // Controls Express `trust proxy` setting, which determines how the app
  // resolves the client IP address from X-Forwarded-For headers.
  //
  // SECURITY: An incorrect value can allow clients to spoof their IP address
  // by injecting X-Forwarded-For headers, bypassing per-IP rate limits.
  //
  // Values:
  //   false        - Disable; req.ip = socket address (safe for direct connections)
  //   loopback     - Trust 127.0.0.1/::1 (nginx on same host)
  //   1            - Trust one hop (single ALB/GCP LB)
  //   10.0.0.0/8   - Trust specific CIDR (internal VPC load balancer)
  //
  // NEVER use 'true' in production.
  TRUST_PROXY: trustProxyValidator({
    default: 'false',
    docs: "Express trust proxy value. Use 'loopback', a hop count (e.g. '1'), or CIDR. Never 'true'.",
    example: 'loopback',
  }),

  // ── CORS ─────────────────────────────────────────────────────
  CORS_ORIGIN: commaSeparatedStr({
    docs: 'Comma-separated list of allowed CORS origins. No wildcards in production.',
    example: 'https://app.gongo.in,https://admin.gongo.in',
  }),

  // ── PostgreSQL ────────────────────────────────────────────────
  DATABASE_URL: url({
    docs: 'PostgreSQL connection string. Format: postgresql://user:pass@host:port/db',
  }),
  DB_POOL_MIN: num({
    default: 2,
    docs: 'Minimum pg pool connections',
  }),
  DB_POOL_MAX: num({
    default: 10,
    docs: 'Maximum pg pool connections',
  }),
  DB_IDLE_TIMEOUT_MS: num({
    default: 30000,
    docs: 'Milliseconds before an idle client is closed by the pool',
  }),
  DB_CONNECTION_TIMEOUT_MS: num({
    default: 10000,
    docs: 'Milliseconds to wait before timing out when connecting a new client',
  }),
  DB_SSL: bool({
    default: false,
    docs: 'Force SSL for database connection (defaults to true in production if not explicitly set)',
  }),

  // ── Redis ─────────────────────────────────────────────────────
  REDIS_URL: url({
    docs: 'Redis connection URL for OTP state, rate limiting, and session revocation',
    example: 'redis://localhost:6379',
  }),

  // ── Supabase Configuration (Database, Auth & Storage) ───────
  SUPABASE_URL: str({
    default: 'https://mtfljykvxyslhdvpfcil.supabase.co',
    docs: 'Supabase project URL',
  }),
  SUPABASE_ANON_KEY: str({
    default: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10ZmxqeWt2eHlzbGhkdnBmY2lsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwNDk1OTgsImV4cCI6MjEwNDYyNTU5OH0.8Y1NCYd0F1es5v_5de3lRySsLM1S4dH2jcN3qpIFTYs',
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
  SUPABASE_STORAGE_PRESIGN_UPLOAD_EXPIRES_SECONDS: num({
    default: 900,
    docs: 'Presigned upload URL expiration in seconds (default: 15m)',
  }),
  SUPABASE_STORAGE_PRESIGN_DOWNLOAD_EXPIRES_SECONDS: num({
    default: 3600,
    docs: 'Presigned download URL expiration in seconds (default: 1h)',
  }),

  // ── Firebase Admin SDK (Legacy / Optional) ────────────────────
  FIREBASE_PROJECT_ID: str({
    default: 'gongo-staging',
    docs: 'Firebase project ID.',
  }),
  FIREBASE_CLIENT_EMAIL: str({
    default: 'firebase-adminsdk@gongo-staging.iam.gserviceaccount.com',
    docs: 'Firebase service account client email.',
  }),
  FIREBASE_PRIVATE_KEY: str({
    default: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n-----END PRIVATE KEY-----\n',
    docs: 'Firebase service account private key (with literal \\n for newlines).',
  }),

  // ── MSG91 SMS Provider ────────────────────────────────────────
  MSG91_AUTH_KEY: str({
    default: '',
    docs: 'MSG91 API authentication key',
  }),
  MSG91_TEMPLATE_ID: str({
    default: '',
    docs: 'MSG91 OTP template ID',
  }),
  MSG91_SENDER_ID: str({
    default: 'GONGOI',
    docs: 'MSG91 Sender ID / Header (e.g. GONGOI)',
  }),

  // ── Renflair SMS Gateway Provider ─────────────────────────────
  RENFLAIR_API_KEY: str({
    default: '',
    docs: 'Renflair SMS API key for customer OTP delivery',
  }),
  RENFLAIR_BASE_URL: url({
    default: 'https://sms.renflair.in/V1.php',
    docs: 'Renflair SMS API base URL',
  }),

  // ── Authentication & OTP Configuration ────────────────────────
  AUTH_OTP_EXPIRY_SECONDS: num({
    default: 300,
    docs: 'OTP validity period in seconds (default 300s = 5m)',
  }),
  AUTH_OTP_RESEND_SECONDS: num({
    default: 30,
    docs: 'Minimum cooldown before another OTP can be requested for the same phone',
  }),
  AUTH_OTP_MAX_ATTEMPTS: num({
    default: 5,
    docs: 'Maximum allowed verification attempts before OTP is invalidated',
  }),
  AUTH_RATE_LIMIT_PHONE_MAX: num({
    default: 5,
    docs: 'Maximum send-otp requests allowed per phone number in window',
  }),
  AUTH_RATE_LIMIT_IP_MAX: num({
    default: 20,
    docs: 'Maximum send-otp requests allowed per IP address in window',
  }),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: num({
    default: 3600,
    docs: 'Sliding window duration in seconds for OTP send rate limits',
  }),

  // ── AWS S3 (Storage fallback) ─────────────────────────────────
  AWS_REGION: str({
    default: 'ap-south-1',
    docs: 'AWS region (e.g. ap-south-1).',
  }),
  AWS_ACCESS_KEY_ID: str({
    default: 'test_aws_key',
    docs: 'AWS access key ID.',
  }),
  AWS_SECRET_ACCESS_KEY: str({
    default: 'test_aws_secret',
    docs: 'AWS secret access key.',
  }),
  AWS_S3_BUCKET: str({
    default: 'gongo-uploads',
    docs: 'S3 bucket name for uploads.',
  }),
  AWS_S3_PRESIGN_UPLOAD_EXPIRES_SECONDS: num({
    default: 900,
    docs: 'Presigned upload URL expiry in seconds (default 15 minutes)',
  }),
  AWS_S3_PRESIGN_DOWNLOAD_EXPIRES_SECONDS: num({
    default: 3600,
    docs: 'Presigned download URL expiry in seconds (default 1 hour)',
  }),

  // ── Razorpay ─────────────────────────────────────────────────
  RAZORPAY_KEY_ID: str({
    default: 'rzp_test_placeholder',
    docs: 'Razorpay key ID.',
  }),
  RAZORPAY_KEY_SECRET: str({
    default: 'rzp_secret_placeholder',
    docs: 'Razorpay key secret.',
  }),

  // ── Google Maps ───────────────────────────────────────────────
  //
  // Used server-side ONLY for geocoding and reverse-geocoding via the
  // location provider abstraction (src/services/location/).
  //
  // SECURITY:
  //   - Never expose this key to the client. It is a server-side credential.
  //   - Restrict the key in Google Cloud Console to the APIs you need.
  //   - Optional in Step 5 (no live geocoding calls yet). Set to '' if unused.
  GOOGLE_MAPS_API_KEY: str({
    default: '',
    docs: 'Google Maps API key for server-side geocoding. Never expose to client.',
  }),

  // ── Cashfree Payment Gateway (Phase 10) ──────────────────────
  CASHFREE_APP_ID: str({
    default: 'test_cashfree_app_id',
    docs: 'Cashfree client / application ID for Payment Gateway.',
  }),
  CASHFREE_SECRET_KEY: str({
    default: 'test_cashfree_secret_key',
    docs: 'Cashfree secret key for API authentication and webhook signature verification.',
  }),
  CASHFREE_ENV: str({
    choices: ['SANDBOX', 'PRODUCTION', 'sandbox', 'production'],
    default: 'SANDBOX',
    docs: 'Cashfree environment mode (SANDBOX or PRODUCTION).',
  }),
  CASHFREE_API_VERSION: str({
    default: '2025-01-01',
    docs: 'Cashfree PG API version (Production 2025-01-01).',
  }),
  CASHFREE_RETURN_URL: str({
    default: 'https://app.gongo.in/bookings/{order_id}/payment-status',
    docs: 'Frontend return URL for customer post-payment redirect.',
  }),

  // ── Development Auth Tokens (dev-token-<phone>) ──────────────
  CUSTOMER_DEV_AUTH_ENABLED: bool({
    default: false,
    devDefault: true,
    docs: 'Accept dev-token-<phone> impersonation tokens. Set false on shared staging hosts; never honoured in production.',
  }),

  // ── Development Dummy Payment Guard ──────────────────────────
  DEV_DUMMY_PAYMENT_ENABLED: bool({
    default: false,
    devDefault: true,
    docs: 'Enables development-only dummy payment bypass. Strictly disabled outside development.',
  }),
});

// ── Production fail-closed guards ──────────────────────────────
// Defaults above exist for local development only. In production a missing or
// placeholder Cashfree secret would make webhook signatures forgeable, and dev
// auth/payment shortcuts would allow impersonation and unpaid bookings.
if (env.NODE_ENV === 'production') {
  const problems = [];
  if (!env.CASHFREE_APP_ID || env.CASHFREE_APP_ID === 'test_cashfree_app_id') {
    problems.push('CASHFREE_APP_ID must be set to a real value in production');
  }
  if (!env.CASHFREE_SECRET_KEY || env.CASHFREE_SECRET_KEY === 'test_cashfree_secret_key') {
    problems.push('CASHFREE_SECRET_KEY must be set to a real value in production');
  }
  if (env.CUSTOMER_DEV_AUTH_ENABLED) {
    problems.push('CUSTOMER_DEV_AUTH_ENABLED must not be enabled in production');
  }
  if (env.DEV_DUMMY_PAYMENT_ENABLED) {
    problems.push('DEV_DUMMY_PAYMENT_ENABLED must not be enabled in production');
  }
  if (process.env.USE_REDIS_MOCK === 'true') {
    problems.push('USE_REDIS_MOCK must not be enabled in production');
  }
  // The defaults point at a hardcoded development project; production must name its own.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    problems.push('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set explicitly in production');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid production configuration:\n${problems.join('\n')}`);
  }
}

module.exports = env;
