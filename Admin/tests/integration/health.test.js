'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockPool, resetMockPool } = require('../../src/db/pool');
const { setMockRedisClient, resetRedisClient } = require('../../src/providers/redis');

describe('Integration: Health & Observability Endpoints', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    resetMockPool();
    resetRedisClient();
  });

  it('GET /health/live returns process alive status 200', async () => {
    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('UP');
    expect(res.body.data.timestamp).toBeDefined();
  });

  it('GET /health/ready returns status 200 READY when database and redis are healthy', async () => {
    // Provide a responsive mock pool and mock redis for testing readiness probe
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      release: jest.fn(),
    };
    setMockPool({
      connect: jest.fn().mockResolvedValue(mockClient),
    });

    setMockRedisClient({
      ping: jest.fn().mockResolvedValue('PONG'),
    });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('READY');
    expect(res.body.data.dependencies.database.status).toBe('UP');
    expect(res.body.data.dependencies.redis.status).toBe('UP');
  });

  it('GET /health/ready returns 503 NOT_READY when database is unreachable', async () => {
    setMockPool({
      connect: jest.fn().mockRejectedValue(new Error('Connection refused')),
    });

    setMockRedisClient({
      ping: jest.fn().mockResolvedValue('PONG'),
    });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.data.status).toBe('NOT_READY');
    expect(res.body.data.dependencies.database.status).toBe('DOWN');
    expect(res.body.data.dependencies.redis.status).toBe('UP');
  });

  it('GET /health/ready returns 503 NOT_READY when Redis is unreachable', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      release: jest.fn(),
    };
    setMockPool({
      connect: jest.fn().mockResolvedValue(mockClient),
    });

    setMockRedisClient({
      ping: jest.fn().mockRejectedValue(new Error('Redis connection timeout')),
    });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.data.status).toBe('NOT_READY');
    expect(res.body.data.dependencies.database.status).toBe('UP');
    expect(res.body.data.dependencies.redis.status).toBe('DOWN');
  });

  it('GET /health returns general service health status 200', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('UP');
    expect(res.body.data.environment).toBe('test');
    expect(res.body.data.uptimeSeconds).toBeDefined();
  });

  it('GET /api/v1/health returns API-level health status 200', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('UP');
    expect(res.body.data.service).toBe('gongo-admin-backend');
    expect(res.body.data.apiVersion).toBe('v1');
    expect(res.body.data.timestamp).toBeDefined();
  });
});
