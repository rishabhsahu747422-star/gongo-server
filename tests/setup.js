'use strict';

/**
 * Unified Global Test Environment Setup.
 * Injects safe mock/test environment variables so modules with fail-fast envalid validation
 * load cleanly during automated testing without real network or DB credentials.
 */
module.exports = async function globalSetup() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '8080';
  process.env.API_VERSION = 'v1';
  process.env.LOG_LEVEL = 'error';
  process.env.TRUST_PROXY = 'false';

  // CORS
  process.env.CORS_ORIGIN = 'http://localhost:3000,http://localhost:3001,http://localhost:3002';
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:3001,http://localhost:3002';
  process.env.CORS_ORIGINS = 'http://localhost:3000,http://localhost:3001,http://localhost:3002';

  // Database & Cache
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/gongo_test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.USE_REDIS_MOCK = 'true';

  // Supabase
  process.env.SUPABASE_URL = 'https://mtfljykvxyslhdvpfcil.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'mock-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'gongo-uploads';

  // AWS S3
  process.env.AWS_REGION = 'ap-south-1';
  process.env.AWS_ACCESS_KEY_ID = 'TESTKEY';
  process.env.AWS_SECRET_ACCESS_KEY = 'TESTSECRET';
  process.env.AWS_S3_BUCKET = 'test-bucket';

  // Cashfree
  process.env.CASHFREE_APP_ID = 'test_cashfree_app_id';
  process.env.CASHFREE_SECRET_KEY = 'test_cashfree_secret_key';
  process.env.CASHFREE_ENV = 'SANDBOX';
  process.env.CASHFREE_API_VERSION = '2023-08-01';

  // OTP & SMS
  process.env.RENFLAIR_API_KEY = '';
  process.env.RENFLAIR_BASE_URL = 'https://sms.renflair.in/V1.php';
  process.env.AUTH_OTP_EXPIRY_SECONDS = '300';
  process.env.AUTH_OTP_RESEND_SECONDS = '30';
  process.env.AUTH_OTP_MAX_ATTEMPTS = '5';
};
