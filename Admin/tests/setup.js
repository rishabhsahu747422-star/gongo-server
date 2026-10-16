'use strict';

/**
 * Global Jest setup.
 * Runs once before all test suites.
 * Configures environment variables for testing without requiring a real .env file.
 */
module.exports = async function globalSetup() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3002';
  process.env.API_PREFIX = '/api/v1';
  process.env.LOG_LEVEL = 'error';
  process.env.TRUST_PROXY = 'false';
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:5173';
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/gongo_partner';
  process.env.DB_HOST = 'localhost';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'gongo_partner';
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_POOL_MIN = '1';
  process.env.DB_POOL_MAX = '2';
  process.env.DB_IDLE_TIMEOUT_MS = '1000';
  process.env.DB_CONNECTION_TIMEOUT_MS = '2000';
  process.env.DB_SSL = 'false';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.USE_REDIS_MOCK = 'true';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.RATE_LIMIT_MAX_REQUESTS = '100';
  process.env.AUTH_OTP_EXPIRY_SECONDS = '300';
  process.env.AUTH_OTP_MAX_ATTEMPTS = '5';
  process.env.AUTH_OTP_RESEND_COOLDOWN_SECONDS = '30';
  process.env.ENFORCE_2FA = 'true';
  process.env.SUPABASE_URL = 'https://test-supabase.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'gongo-test-uploads';
  process.env.AWS_REGION = 'ap-south-1';
  process.env.AWS_ACCESS_KEY_ID = 'TEST_AWS_KEY';
  process.env.AWS_SECRET_ACCESS_KEY = 'TEST_AWS_SECRET';
  process.env.AWS_S3_BUCKET = 'gongo-admin-bucket-test';
  process.env.AWS_S3_PUBLIC = 'false';
};
