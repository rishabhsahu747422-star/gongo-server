'use strict';

/**
 * Security regression: the former development auth bypasses and the Admin Supabase
 * mobile-OTP / Supabase-JWT login paths are gone, and cannot be re-enabled by config.
 */

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockSupabaseClient, resetSupabaseClient } = require('../../src/providers/supabase');
const { resetRateLimits } = require('../../src/middlewares/rateLimiter');
const { createAuthHarness } = require('../support/admin-auth-harness');

describe('Security: legacy admin auth bypasses are removed', () => {
  let app;
  let h;
  let adminId;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(async () => {
    await resetRateLimits();
    h = createAuthHarness();
    await h.install();
    adminId = h.addUser({ email: 'ops@gongo.in', phone: '9876543210', role: 'admin' });
  });

  afterEach(() => {
    h.uninstall();
    resetSupabaseClient();
    jest.restoreAllMocks();
  });

  it.each([
    ['POST', '/api/v1/admin/auth/otp/send', { phone: '+919876543210' }],
    ['POST', '/api/v1/admin/auth/otp/verify', { phone: '+919876543210', otp: '123456' }],
    ['POST', '/api/v1/admin/auth/mobile/login', { phone: '9876543210' }],
    ['POST', '/api/admin/auth/otp/verify', { phone: '+919876543210', otp: '123456' }],
  ])('26. %s %s (removed Admin OTP endpoint) is rejected', async (_method, url, body) => {
    const res = await request(app).post(url).send(body);
    // No handler exists; unauthenticated requests stop at the admin auth guard
    expect(res.status).toBe(401);
    expect(res.body.data?.token).toBeUndefined();
    expect(h.sessions.size).toBe(0);
  });

  it('26. POST /api/v1/admin/auth/verify-2fa rejects invalid/missing challengeId', async () => {
    const res = await request(app).post('/api/v1/admin/auth/verify-2fa').send({ sessionId: 'x', otp: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.data?.token).toBeUndefined();
    expect(h.sessions.size).toBe(0);
  });

  it.each([
    ['dev- prefixed session header', { 'x-admin-session': 'dev-anything' }],
    ['dev- prefixed bearer token', { Authorization: 'Bearer dev-admin-token' }],
    ['legacy mock Supabase dev token', { Authorization: 'Bearer sup-dev-token-123' }],
    ['spoofed admin headers without a session', { 'x-admin': 'true', 'x-role': 'SUPER_ADMIN', 'x-user-id': 'adm-001' }],
  ])('26. rejects %s', async (_label, headers) => {
    const res = await request(app).get('/api/v1/admin/auth/me').set(headers);
    expect(res.status).toBe(401);
  });

  it('26. rejects bypass-style query parameters', async () => {
    const res = await request(app).get('/api/v1/admin').query({ bypass: 'true', devAuth: '1', role: 'super_admin' });
    expect(res.status).toBe(401);
  });

  it('26. no longer accepts a valid Supabase JWT in place of an admin session', async () => {
    // A real, verified Supabase user that maps to an existing admin row by email
    setMockSupabaseClient({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'sup-uid', email: 'ops@gongo.in', email_confirmed_at: '2026-01-01T00:00:00Z', user_metadata: { role: 'SUPER_ADMIN' },
            },
          },
          error: null,
        }),
      },
    });

    const me = await request(app).get('/api/v1/admin/auth/me').set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig');
    const login = await request(app).post('/api/v1/admin/auth/login').set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig');
    expect(me.status).toBe(401);
    expect(login.status).toBe(400); // password login requires identifier + password
    expect(h.sessions.size).toBe(0);
    expect(adminId).toBeDefined();
  });

  it('26. password login without a stored credential never falls back to a default/dev profile', async () => {
    const res = await request(app).post('/api/v1/admin/auth/login').send({ identifier: 'ops@gongo.in', password: 'anything' });
    expect(res.status).toBe(401);
    const unknown = await request(app).post('/api/v1/admin/auth/login').send({ identifier: 'admin@gongo.com', password: 'admin' });
    expect(unknown.status).toBe(401);
    expect(h.sessions.size).toBe(0);
  });

  it('26. ADMIN_DEV_AUTH_ENABLED has no effect outside production either', () => {
    // The flag is gone from configuration and no source file reads it any more
    // eslint-disable-next-line global-require
    const env = require('../../src/config/env');
    expect(Object.keys(env)).not.toContain('ADMIN_DEV_AUTH_ENABLED');

    const srcRoot = path.resolve(__dirname, '../../src');
    const offenders = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8');
        // process.env.ADMIN_DEV_AUTH_ENABLED is only read by the production refuse-to-boot guard
        if (/(?<!process\.)env\.ADMIN_DEV_AUTH_ENABLED|isDevAuthAllowed|devSessionsMap|'123456'/.test(text)) {
          offenders.push(full);
        }
      }
    });
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

describe('Security: production configuration cannot enable an auth bypass (27)', () => {
  const originalEnv = process.env;
  const productionEnv = {
    NODE_ENV: 'production',
    USE_REDIS_MOCK: 'false',
    CORS_ALLOWED_ORIGINS: 'https://admin.gongo.in',
    DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
    REDIS_URL: 'redis://cache.example.com:6379',
    SUPABASE_URL: 'https://prod.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'prod-service-role-key',
    AWS_REGION: 'ap-south-1',
    AWS_ACCESS_KEY_ID: 'REAL_AWS_KEY',
    AWS_SECRET_ACCESS_KEY: 'REAL_AWS_SECRET',
    AWS_S3_BUCKET: 'prod-admin-bucket',
  };

  const loadEnv = (extra) => {
    process.env = { ...productionEnv, ...extra };
    let loaded;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      jest.spyOn(require('dotenv'), 'config').mockReturnValue({});
      // eslint-disable-next-line global-require
      loaded = require('../../src/config/env');
    });
    return loaded;
  };

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refuses to boot when the removed ADMIN_DEV_AUTH_ENABLED flag is set', () => {
    expect(() => loadEnv({ ADMIN_DEV_AUTH_ENABLED: 'true' })).toThrow(/ADMIN_DEV_AUTH_ENABLED is no longer supported/);
  });

  it('boots with a clean production configuration', () => {
    expect(() => loadEnv({})).not.toThrow();
  });

  it('refuses partial Google OAuth configuration', () => {
    expect(() => loadEnv({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com' })).toThrow(/partially configured/);
  });

  it('requires https OAuth redirect URLs', () => {
    expect(() => loadEnv({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_CALLBACK_URL: 'http://api.gongo.in/api/v1/admin/auth/google/callback',
      ADMIN_OAUTH_REDIRECT_URL: 'https://admin.gongo.in/auth/google/callback',
    })).toThrow(/GOOGLE_CALLBACK_URL must use https/);
  });
});
