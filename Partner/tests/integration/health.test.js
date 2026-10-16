'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');

describe('Integration: Health Endpoints', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('GET /health/live returns process alive status 200', async () => {
    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('UP');
    expect(res.body.data.timestamp).toBeDefined();
  });

  it('GET /health/ready returns readiness probe status 200', async () => {
    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('READY');
    expect(res.body.data.dependencies).toBeDefined();
    expect(res.body.data.dependencies.database.status).toBe('UP');
    expect(res.body.data.dependencies.redis.status).toBe('UP');
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
    expect(res.body.data.service).toBe('gongo-partner-backend');
    expect(res.body.data.apiVersion).toBe('v1');
  });
});
