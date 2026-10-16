'use strict';

/**
 * Global Jest setup.
 * Runs once before all test suites.
 * Sets environment variables for testing without requiring a real .env file.
 */
module.exports = async function globalSetup() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3001';
  process.env.API_PREFIX = '/api/v1';
  process.env.LOG_LEVEL = 'error';
  process.env.TRUST_PROXY = 'false';
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:8081';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/gongo_partner_test';
  process.env.DB_HOST = 'localhost';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'gongo_partner_test';
  process.env.DB_USER = 'test';
  process.env.DB_PASSWORD = 'test';
  process.env.DB_POOL_MIN = '1';
  process.env.DB_POOL_MAX = '2';
  process.env.DB_IDLE_TIMEOUT_MS = '1000';
  process.env.DB_CONNECTION_TIMEOUT_MS = '2000';
  process.env.DB_SSL = 'false';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.USE_REDIS_MOCK = 'true';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.RATE_LIMIT_MAX_REQUESTS = '100';
  process.env.SUPABASE_URL = 'https://test-supabase.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'mock-anon-key-test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key-test';
  process.env.SUPABASE_STORAGE_BUCKET = 'gongo-partner-documents';
  process.env.CASHFREE_APP_ID = 'TEST_CASHFREE_APP_ID';
  process.env.CASHFREE_SECRET_KEY = 'TEST_CASHFREE_SECRET_KEY_1234567890';
  process.env.CASHFREE_ENV = 'SANDBOX';
  process.env.CASHFREE_API_VERSION = '2023-08-01';
  process.env.PARTNER_DEV_AUTH_ENABLED = 'true';
  process.env.PARTNER_DEV_AUTH_ID = 'dev-partner-auth-id';
};
