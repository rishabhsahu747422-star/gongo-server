'use strict';

describe('Unit: Configuration Safety & Envalid Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(require('dotenv'), 'config').mockReturnValue({});
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
    process.env.USE_REDIS_MOCK = 'false';
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000,*';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.SUPABASE_URL = 'https://prod.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'prod-service-role-key';
    process.env.AWS_REGION = 'ap-south-1';
    process.env.AWS_ACCESS_KEY_ID = 'REAL_AWS_KEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'REAL_AWS_SECRET';
    process.env.AWS_S3_BUCKET = 'prod-admin-bucket';

    expect(() => {
      // eslint-disable-next-line global-require
      require('../../src/config/env');
    }).toThrow(/Wildcard '\*' is strictly forbidden in CORS_ALLOWED_ORIGINS for production/);
  });

  it('fails fast in production if DATABASE_URL is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.USE_REDIS_MOCK = 'false';
    delete process.env.DATABASE_URL;
    process.env.CORS_ALLOWED_ORIGINS = 'https://admin.gongo.in';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.SUPABASE_URL = 'https://prod.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'prod-service-role-key';
    process.env.AWS_REGION = 'ap-south-1';
    process.env.AWS_ACCESS_KEY_ID = 'REAL_AWS_KEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'REAL_AWS_SECRET';
    process.env.AWS_S3_BUCKET = 'prod-admin-bucket';

    expect(() => {
      // eslint-disable-next-line global-require
      require('../../src/config/env');
    }).toThrow(/DATABASE_URL is strictly required in production/);
  });

  it('fails fast in production if REDIS_URL is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.USE_REDIS_MOCK = 'false';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    delete process.env.REDIS_URL;
    process.env.CORS_ALLOWED_ORIGINS = 'https://admin.gongo.in';
    process.env.SUPABASE_URL = 'https://prod.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'prod-service-role-key';
    process.env.AWS_REGION = 'ap-south-1';
    process.env.AWS_ACCESS_KEY_ID = 'REAL_AWS_KEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'REAL_AWS_SECRET';
    process.env.AWS_S3_BUCKET = 'prod-admin-bucket';

    expect(() => {
      // eslint-disable-next-line global-require
      require('../../src/config/env');
    }).toThrow(/REDIS_URL is strictly required in production/);
  });

  it('fails fast in production if USE_REDIS_MOCK is enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.USE_REDIS_MOCK = 'true';
    process.env.CORS_ALLOWED_ORIGINS = 'https://admin.gongo.in';
    process.env.SUPABASE_URL = 'https://prod.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'prod-service-role-key';
    process.env.AWS_REGION = 'ap-south-1';
    process.env.AWS_ACCESS_KEY_ID = 'REAL_AWS_KEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'REAL_AWS_SECRET';
    process.env.AWS_S3_BUCKET = 'prod-admin-bucket';

    expect(() => {
      // eslint-disable-next-line global-require
      require('../../src/config/env');
    }).toThrow(/USE_REDIS_MOCK must not be enabled in production/);
  });

  it('fails fast in production if AWS S3 credentials are missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.USE_REDIS_MOCK = 'false';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.CORS_ALLOWED_ORIGINS = 'https://admin.gongo.in';
    process.env.SUPABASE_URL = 'https://prod.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'prod-service-role-key';
    delete process.env.AWS_ACCESS_KEY_ID;

    expect(() => {
      // eslint-disable-next-line global-require
      require('../../src/config/env');
    }).toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are strictly required in production/);
  });

  it('fails fast in production if CASHFREE_ENV=PRODUCTION and production credentials are missing or default', () => {
    process.env.NODE_ENV = 'production';
    process.env.USE_REDIS_MOCK = 'false';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.CORS_ALLOWED_ORIGINS = 'https://admin.gongo.in';
    process.env.SUPABASE_URL = 'https://prod.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'prod-service-role-key';
    process.env.AWS_REGION = 'ap-south-1';
    process.env.AWS_ACCESS_KEY_ID = 'REAL_AWS_KEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'REAL_AWS_SECRET';
    process.env.AWS_S3_BUCKET = 'prod-admin-bucket';
    process.env.CASHFREE_ENV = 'PRODUCTION';
    process.env.CASHFREE_APP_ID = 'test_cashfree_app_id';
    process.env.CASHFREE_SECRET_KEY = 'test_cashfree_secret_key';

    expect(() => {
      // eslint-disable-next-line global-require
      require('../../src/config/env');
    }).toThrow(/Production CASHFREE_APP_ID and CASHFREE_SECRET_KEY are strictly required when CASHFREE_ENV=PRODUCTION/);
  });
});
