'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Application Boot & Pipeline Architecture', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('boots application without throwing exceptions', () => {
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });

  it('strips X-Powered-By header to prevent technology disclosure', async () => {
    const res = await request(app).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('handles unknown routes with standardized 404 response', async () => {
    const res = await request(app).get('/api/v1/non-existent-route-xyz');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    expect(res.body.error.message).toContain('Endpoint not found');
    expect(res.body.requestId).toBeDefined();
  });
});
