'use strict';

const request = require('supertest');
const { validate: uuidValidate, v4: uuidv4 } = require('uuid');
const { createApp } = require('../../src/app');

describe('Integration: Request ID & Correlation Tracking', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('generates a valid UUID v4 X-Request-ID when none is provided by client', async () => {
    const res = await request(app).get('/health/live');

    expect(res.headers['x-request-id']).toBeDefined();
    expect(uuidValidate(res.headers['x-request-id'])).toBe(true);
  });

  it('preserves and propagates a valid client-supplied X-Request-ID', async () => {
    const customId = uuidv4();

    const res = await request(app)
      .get('/health/live')
      .set('X-Request-ID', customId);

    expect(res.headers['x-request-id']).toBe(customId);
  });

  it('replaces an invalid / non-UUID X-Request-ID with a freshly generated UUID v4', async () => {
    const invalidId = 'not-a-valid-uuid-injection<script>';

    const res = await request(app)
      .get('/health/live')
      .set('X-Request-ID', invalidId);

    expect(res.headers['x-request-id']).not.toBe(invalidId);
    expect(uuidValidate(res.headers['x-request-id'])).toBe(true);
  });

  it('includes requestId in error responses', async () => {
    const customId = uuidv4();

    const res = await request(app)
      .get('/api/v1/non-existent-endpoint')
      .set('X-Request-ID', customId);

    expect(res.status).toBe(404);
    expect(res.body.requestId).toBe(customId);
  });
});
