'use strict';

/**
 * Global Jest setup.
 * Runs once before all test suites.
 *
 * Sets environment variables required by config/env.js validation
 * so tests pass without a real .env file.
 *
 * All values here are test-only — no real credentials.
 */
module.exports = async function globalSetup() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3001';
  process.env.API_VERSION = 'v1';
  process.env.LOG_LEVEL = 'error'; // Silence logs during tests
  process.env.CORS_ORIGIN = 'http://localhost:3000';
  process.env.TRUST_PROXY = 'false';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/gongo_test';
  process.env.DB_POOL_MIN = '1';
  process.env.DB_POOL_MAX = '2';
  process.env.DB_IDLE_TIMEOUT_MS = '1000';
  process.env.DB_CONNECTION_TIMEOUT_MS = '2000';
  process.env.DB_SSL = 'false';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.USE_REDIS_MOCK = 'true';
  process.env.FIREBASE_PROJECT_ID = 'test-project';
  process.env.FIREBASE_CLIENT_EMAIL = 'test@test-project.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n';
  process.env.MSG91_AUTH_KEY = 'test-msg91-auth-key';
  process.env.MSG91_TEMPLATE_ID = 'test-template-id';
  process.env.MSG91_SENDER_ID = 'GONGOI';
  process.env.RENFLAIR_API_KEY = '';
  process.env.RENFLAIR_BASE_URL = 'https://sms.renflair.in/V1.php';
  process.env.AUTH_OTP_EXPIRY_SECONDS = '300';
  process.env.AUTH_OTP_RESEND_SECONDS = '30';
  process.env.AUTH_OTP_MAX_ATTEMPTS = '5';
  process.env.AUTH_RATE_LIMIT_PHONE_MAX = '5';
  process.env.AUTH_RATE_LIMIT_IP_MAX = '20';
  process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = '3600';
  process.env.AWS_REGION = 'ap-south-1';
  process.env.AWS_ACCESS_KEY_ID = 'TESTKEY';
  process.env.AWS_SECRET_ACCESS_KEY = 'TESTSECRET';
  process.env.AWS_S3_BUCKET = 'test-bucket';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_TESTKEY';
  process.env.RAZORPAY_KEY_SECRET = 'TESTSECRET';
  process.env.GOOGLE_MAPS_API_KEY = '';
  process.env.CASHFREE_APP_ID = 'test_cashfree_app_id';
  process.env.CASHFREE_SECRET_KEY = 'test_cashfree_secret_key';
  process.env.CASHFREE_ENV = 'SANDBOX';
  process.env.CASHFREE_API_VERSION = '2023-08-01';
  process.env.CASHFREE_RETURN_URL = 'https://app.gongo.in/bookings/{order_id}/payment-status';
};
