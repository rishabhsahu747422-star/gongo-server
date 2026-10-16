'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Rate Limiter Middleware', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  it('allows requests within limit and sets rate-limit headers', async () => {
    const res = await request(app).get('/api/v1/test/rate-limited');

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('3');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('blocks requests exceeding maximum requests limit with 429', async () => {
    // We already made 1 request above, make 2 more to exhaust max: 3
    await request(app).get('/api/v1/test/rate-limited');
    await request(app).get('/api/v1/test/rate-limited');

    // 4th request must be rejected with 429
    const res = await request(app).get('/api/v1/test/rate-limited');

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
  });
});
