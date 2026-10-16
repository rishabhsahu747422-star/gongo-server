'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');

const app = createApp();

describe('Integration: HTTP Security Hardening & Method Filtering', () => {
  it('rejects TRACE HTTP method with 405 Method Not Allowed and sets Allow header', async () => {
    const res = await request(app).trace('/health');
    expect(res.status).toBe(405);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
    expect(res.headers.allow).toBeDefined();
    expect(res.headers.allow).toContain('GET');
  });

  it('verifies strict security headers are applied to responses', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);

    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers.pragma).toBe('no-cache');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects requests with oversized bodies (>10kb)', async () => {
    const hugeBody = { data: 'A'.repeat(12 * 1024) };
    const res = await request(app)
      .post('/api/v1/admin')
      .set('Content-Type', 'application/json')
      .send(hugeBody);

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('handles malformed JSON request bodies safely with 400 Bad Request', async () => {
    const res = await request(app)
      .post('/api/v1/admin')
      .set('Content-Type', 'application/json')
      .send('{"malformed": "json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});
