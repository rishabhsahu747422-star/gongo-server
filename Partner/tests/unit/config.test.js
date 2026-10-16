'use strict';

describe('Unit: Configuration Safety', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('rejects TRUST_PROXY=true to prevent IP spoofing', () => {
    process.env.NODE_ENV = 'development';
    process.env.TRUST_PROXY = 'true';

    expect(() => {
      // eslint-disable-next-line global-require
      require('../../src/config/env');
    }).toThrow(/TRUST_PROXY='true' blindly trusts/);
  });

  it('rejects wildcard in CORS_ALLOWED_ORIGINS when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000,*';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.SUPABASE_URL = 'https://prod-project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'real-service-role-key';
    process.env.SUPABASE_STORAGE_BUCKET = 'prod-bucket';

    expect(() => {
      // eslint-disable-next-line global-require
      require('../../src/config/env');
    }).toThrow(/Wildcard '\*' is strictly forbidden in CORS_ALLOWED_ORIGINS for production/);
  });

  it('fails fast in production if DATABASE_URL is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = '';
    process.env.CORS_ALLOWED_ORIGINS = 'https://partner.gongo.in';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.USE_REDIS_MOCK = 'false';
    process.env.SUPABASE_URL = 'https://prod-project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'real-service-role-key';
    process.env.SUPABASE_STORAGE_BUCKET = 'prod-bucket';
    process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
    process.env.CASHFREE_APP_ID = 'prod_app_id';
    process.env.CASHFREE_SECRET_KEY = 'prod_secret_key';

    expect(() => {
      // eslint-disable-next-line global-require
      require('../../src/config/env');
    }).toThrow(/DATABASE_URL/);
  });
});
