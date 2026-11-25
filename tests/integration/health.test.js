'use strict';

const request = require('supertest');
const { Pool } = require('pg');

// Mock the pg Pool BEFORE requiring app — this prevents real DB connections in tests
jest.mock('pg', () => {
  const mClient = {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
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

describe('GET /api/v1/health', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('should return 200 with healthy status when DB is reachable', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('OK');
    expect(res.body.data).toMatchObject({
      status: 'healthy',
      environment: 'test',
      services: { database: 'connected' },
    });
    expect(res.body.data.timestamp).toBeDefined();
    expect(res.body.requestId).toBeDefined();
  });

  it('should include X-Request-ID header', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('should return 503 when DB is unreachable', async () => {
    // Override the mock to simulate a DB failure for this test
    const mockPool = new Pool();
    mockPool.connect.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await request(app).get('/api/v1/health');

    // The response should be 503 with no SQL/connection details
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Service temporarily unavailable');
    // Must NOT contain any internal details
    expect(JSON.stringify(res.body)).not.toContain('Connection refused');
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('should not expose internal server details in the body', async () => {
    const res = await request(app).get('/api/v1/health');
    const bodyStr = JSON.stringify(res.body);

    expect(bodyStr).not.toContain('node_modules');
    expect(bodyStr).not.toContain('at Object');
    expect(bodyStr).not.toContain('password');
  });

  it('should return 200 for liveness probe GET /api/v1/health/live and GET /health/live', async () => {
    const res1 = await request(app).get('/api/v1/health/live');
    expect(res1.status).toBe(200);
    expect(res1.body.data.status).toBe('alive');

    const res2 = await request(app).get('/health/live');
    expect(res2.status).toBe(200);
    expect(res2.body.data.status).toBe('alive');
  });

  it('should return 200 for readiness probe GET /api/v1/health/ready and GET /health/ready', async () => {
    const res1 = await request(app).get('/api/v1/health/ready');
    expect(res1.status).toBe(200);
    expect(res1.body.data.status).toBe('ready');
    expect(res1.body.data.services.database).toBe('connected');

    const res2 = await request(app).get('/health/ready');
    expect(res2.status).toBe(200);
    expect(res2.body.data.status).toBe('ready');
  });
});

describe('404 handler', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('should return 404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBeDefined();
  });

  it('should return 404 for completely unknown base paths', async () => {
    const res = await request(app).get('/completely/unknown/path');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
