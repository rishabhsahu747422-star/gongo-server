'use strict';

/**
 * Production-mode regression tests for the unified app.
 * Loads the full app with NODE_ENV=production and placeholder configuration
 * (no real credentials; database and Redis point at unreachable local ports).
 */

const ALLOWED_ORIGIN = 'https://admin.example.com';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  USE_REDIS_MOCK: 'false',
  // Override any developer .env values; production refuses to start with these on.
  DEV_DUMMY_PAYMENT_ENABLED: 'false',
  CUSTOMER_DEV_AUTH_ENABLED: 'false',
  PARTNER_DEV_AUTH_ENABLED: 'false',
  PARTNER_DEV_LOGIN_ENABLED: 'false',
  ADMIN_DEV_AUTH_ENABLED: 'false',
  TRUST_PROXY: '1',
  DATABASE_URL: 'postgresql://smoke:smoke@127.0.0.1:59999/smoke',
  DB_SSL: 'false',
  DB_CONNECTION_TIMEOUT_MS: '500',
  REDIS_URL: 'redis://127.0.0.1:59998',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'placeholder-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key-000000000000000000000000',
  SUPABASE_STORAGE_BUCKET: 'smoke-bucket',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  CASHFREE_APP_ID: 'placeholder',
  CASHFREE_SECRET_KEY: 'placeholder',
  CASHFREE_ENV: 'PRODUCTION',
  AWS_S3_PUBLIC: 'false',
  AWS_S3_BUCKET: 'smoke-bucket',
  CORS_ORIGINS: ALLOWED_ORIGIN,
  CORS_ORIGIN: ALLOWED_ORIGIN,
  CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
};

const savedEnv = {};
let app;
let request;

beforeAll(() => {
  for (const [key, value] of Object.entries(PRODUCTION_ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  jest.isolateModules(() => {
    // eslint-disable-next-line global-require
    request = require('supertest');
    // eslint-disable-next-line global-require
    app = require('../../src/app').createApp();
  });
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('GONGO Unified Backend — production mode', () => {
  it('liveness probe responds 200', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
  });

  it('sends HTTPS security headers and trusts exactly one proxy hop', async () => {
    const res = await request(app).get('/health/live');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(app.get('trust proxy')).toBe(1);
  });

  it('readiness probe reports 503 when database and Redis are unreachable', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks['customer.database']).toBe('DOWN');
    // Never exposes connection strings or error details
    expect(JSON.stringify(res.body)).not.toMatch(/postgres|redis:\/\/|59999/);
  }, 20000);

  it('does not grant CORS to an unlisted browser origin on preflight', async () => {
    const res = await request(app)
      .options('/api/v1/customer/bookings')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    ['/api/v1/customer/customers/me'],
    ['/api/v1/partner/vehicles'],
    ['/api/v1/admin/bookings'],
  ])('rejects an actual request from an unlisted origin to %s with 403, not 500', async (path) => {
    const res = await request(app).get(path).set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('grants CORS to a configured origin', async () => {
    const res = await request(app)
      .options('/api/v1/admin/bookings')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('never honors a wildcard origin entry', () => {
    process.env.CORS_ORIGINS = '*';
    let wildcardApp;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      wildcardApp = require('../../src/app').createApp();
    });
    process.env.CORS_ORIGINS = ALLOWED_ORIGIN;
    return request(wildcardApp)
      .options('/api/v1/customer/bookings')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')
      .then((res) => {
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      });
  });

  it('returns a 404 envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it.each([
    ['/api/v1/customer/customers/me'],
    ['/api/v1/partner/vehicles'],
    ['/api/v1/admin/bookings'],
  ])('rejects unauthenticated request to %s with 401', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
  });

  it('rejects a malformed JSON body with 400 and no stack trace', async () => {
    const res = await request(app)
      .post('/api/v1/customer/auth/send-otp')
      .set('Content-Type', 'application/json')
      .send('{"phone":');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js:\d+/);
  });

  it.each([
    ['/api/v1/partner/vehicles', 'dev-partner-token'],
    ['/api/v1/customer/customers/me', 'dev-token-9999999999'],
  ])('rejects development bearer tokens on %s in production', async (path, token) => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it.each([
    ['partner', '../../src/routes/partner.routes', 'partnerApp'],
    ['admin', '../../src/routes/admin.routes', 'adminApp'],
  ])('does not mount the %s sub-app test-only routes (/api/v1/test/*) in production', async (_name, modulePath, key) => {
    // Same isolated module registry as `app`, so this is the production-configured sub-app
    let subApp;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      subApp = require(modulePath)[key];
    });
    const res = await request(subApp).get('/api/v1/test/auth');
    expect(res.status).toBe(404);
  });

  it('refuses the Partner dev-login route in production', async () => {
    const res = await request(app)
      .post('/api/v1/partner/auth/partner/dev-login')
      .send({ phone: '9999999999', code: '123456' });
    expect([400, 403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it.each([
    ['/api/v1/customer/payments/dev-bypass'],
    ['/api/v1/customer/payments/test/simulate-webhook'],
  ])('requires authentication for %s (and the service refuses it in production)', async (path) => {
    const res = await request(app).post(path).send({ bookingId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(401);
  });

  it('keeps Partner dev-login disabled in production', async () => {
    const res = await request(app)
      .post('/api/v1/auth/dev-login')
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });
});
