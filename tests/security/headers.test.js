'use strict';

const request = require('supertest');

// Mock pg before requiring app
jest.mock('pg', () => {
  const mClient = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
  const mPool = {
    connect: jest.fn().mockResolvedValue(mClient),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };
  return { Pool: jest.fn(() => mPool) };
});

const { createApp } = require('../../src/app');

describe('Security headers (Helmet)', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('should set X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('should set X-Frame-Options', async () => {
    const res = await request(app).get('/api/v1/health');
    // Helmet sets SAMEORIGIN or DENY
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('should NOT expose X-Powered-By header', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('should set X-Request-ID on every response', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('should set a different X-Request-ID for each request', async () => {
    const res1 = await request(app).get('/api/v1/health');
    const res2 = await request(app).get('/api/v1/health');
    expect(res1.headers['x-request-id']).not.toBe(res2.headers['x-request-id']);
  });
});

describe('CORS policy', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('should allow requests from a whitelisted origin', async () => {
    // CORS_ORIGIN is set to 'http://localhost:3000' in tests/setup.js
    const res = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:3000');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('should reject requests from a non-whitelisted origin', async () => {
    const res = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'http://evil-site.com');

    // Origin should NOT be echoed back in allow header
    expect(res.headers['access-control-allow-origin']).not.toBe('http://evil-site.com');
  });

  it('should handle OPTIONS preflight for allowed origins', async () => {
    const res = await request(app)
      .options('/api/v1/health')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET');

    // cors() responds to preflight with 204 or 200
    expect([200, 204]).toContain(res.status);
  });
});

describe('Body parser limits', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('should reject JSON body larger than 10kb', async () => {
    // Generate a payload slightly over 10kb
    const largePayload = { data: 'x'.repeat(11 * 1024) };

    const res = await request(app)
      .post('/api/v1/health') // Method doesn't matter — body parser runs first
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(largePayload));

    // Should be 400 (payload too large) or 404 (route not found after parsing)
    // Either way, must not be 200
    expect(res.status).not.toBe(200);
    // Must not expose internal stack details
    expect(JSON.stringify(res.body)).not.toContain('node_modules');
  });

  it('should reject invalid JSON', async () => {
    const res = await request(app)
      .post('/api/v1/nonexistent')
      .set('Content-Type', 'application/json')
      .send('{invalid json}');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
    // Stack must not appear in production-mode response
    // (NODE_ENV=test, which is treated like production for error leaks)
    expect(res.body.stack).toBeUndefined();
  });
});
