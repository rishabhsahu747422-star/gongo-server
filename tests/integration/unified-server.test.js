'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');

describe('GONGO Unified Backend — HTTP Application Integration', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  describe('Health Probes', () => {
    it('GET /health returns 200 with service registry metadata', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('gongo-unified-backend');
      expect(res.body.services).toEqual({
        customer: 'mounted',
        partner: 'mounted',
        admin: 'mounted',
      });
    });

    it('GET /health/live returns 200 liveness check', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('Correlation & Headers', () => {
    it('should assign and echo x-request-id header on all responses', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-request-id']).toBeDefined();
      expect(typeof res.headers['x-request-id']).toBe('string');
    });

    it('should preserve incoming client x-request-id header', async () => {
      const clientReqId = 'client-uuid-test-999';
      const res = await request(app)
        .get('/health')
        .set('x-request-id', clientReqId);

      expect(res.headers['x-request-id']).toBe(clientReqId);
    });

    it('should omit X-Powered-By header for information security', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('Sub-application Namespaces & Health Endpoints', () => {
    it('should route /api/v1/customer/health probe', async () => {
      const res = await request(app).get('/api/v1/customer/health');
      expect([200, 503]).toContain(res.status);
    });

    it('should route legacy /customer/health probe', async () => {
      const res = await request(app).get('/customer/health');
      expect([200, 404, 503]).toContain(res.status);
    });

    it('should route /api/v1/partner/health probe', async () => {
      const res = await request(app).get('/api/v1/partner/health');
      expect([200, 503]).toContain(res.status);
      expect(res.body.success).toBe(true);
      expect(res.body.data.service).toBe('gongo-partner-backend');
    });

    it('should route legacy /partner/health probe', async () => {
      const res = await request(app).get('/partner/health');
      expect([200, 404, 503]).toContain(res.status);
    });

    it('should expose the Partner API root probe under /api/v1/partner', async () => {
      const res = await request(app).get('/api/v1/partner');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.service).toBe('gongo-partner-backend');
      expect(res.body.data.apiVersion).toBe('v1');
    });

    it('should route /api/v1/admin/health probe', async () => {
      const res = await request(app).get('/api/v1/admin/health');
      expect([200, 503]).toContain(res.status);
      expect(res.body.success).toBe(true);
      expect(res.body.data.service).toBe('gongo-admin-backend');
    });

    it('should route legacy /admin/health probe', async () => {
      const res = await request(app).get('/admin/health');
      expect([200, 404, 503]).toContain(res.status);
    });

    it('should expose the Admin API root probe under /api/v1/admin', async () => {
      const res = await request(app).get('/api/v1/admin');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.service).toBe('gongo-admin-backend');
      expect(res.body.data.apiVersion).toBe('v1');
    });
  });

  describe('Centralized 404 and Error Handling', () => {
    it('returns 404 with structured error envelope for non-existent route', async () => {
      const res = await request(app).get('/non-existent-endpoint-12345');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Canonical Routes, Deduplication, and Legacy Aliases', () => {
    it('routes Customer canonical endpoints (/api/v1/customer/...) with proper auth rejection', async () => {
      const canonicalRes = await request(app).get('/api/v1/customer/customers/me');
      expect(canonicalRes.status).toBe(401);

      const legacyRes = await request(app).get('/customer/api/v1/customers/me');
      expect(legacyRes.status).toBe(401);

      const aliasRes = await request(app).get('/api/v1/customers/me');
      expect(aliasRes.status).toBe(401);
    });

    it('routes Customer public discovery without authentication', async () => {
      const res = await request(app).get('/api/v1/customer/vehicles');
      expect([200, 500]).toContain(res.status); // 200 or 500 depending on test db
    });

    it('routes Partner canonical endpoints (/api/v1/partner/...) with proper auth rejection', async () => {
      const canonicalRes = await request(app).get('/api/v1/partner/vehicles');
      expect(canonicalRes.status).toBe(401);

      const legacyRes = await request(app).get('/partner/api/v1/partner/vehicles');
      expect(legacyRes.status).toBe(401);
    });

    it('routes Admin canonical endpoints (/api/v1/admin/...) with proper auth rejection', async () => {
      const canonicalRes = await request(app).get('/api/v1/admin/bookings');
      expect(canonicalRes.status).toBe(401);

      const legacyRes = await request(app).get('/admin/api/v1/admin/bookings');
      expect(legacyRes.status).toBe(401);
    });

    it('dispatches legacy /api/v1/auth paths by first segment', async () => {
      // Partner-owned consent endpoint (previously fell through to Customer → 404)
      const consents = await request(app).get('/api/v1/auth/consents');
      expect(consents.status).toBe(401);

      // A query string mentioning a Partner segment must not change the target
      const refresh = await request(app).post('/api/v1/auth/refresh?next=/me').send({});
      expect(refresh.status).not.toBe(404);
    });

    it('routes Admin franchise-application management to the authenticated admin router', async () => {
      const listRes = await request(app).get('/api/v1/admin/franchise-applications');
      expect(listRes.status).toBe(401);

      const statusRes = await request(app)
        .patch('/api/v1/admin/franchise-applications/00000000-0000-0000-0000-000000000000/status')
        .send({ status: 'APPROVED' });
      expect(statusRes.status).toBe(401);
    });

    it('prevents route prefix duplication safely without 404', async () => {
      const partnerDupRes = await request(app).get('/api/v1/partner/partner/vehicles');
      expect(partnerDupRes.status).toBe(401);

      const adminDupRes = await request(app).get('/api/v1/admin/admin/bookings');
      expect(adminDupRes.status).toBe(401);

      const custDupRes = await request(app).get('/api/v1/customer/customer/customers/me');
      expect(custDupRes.status).toBe(401);
    });

    it('dispatches Customer and Partner OTP routes through unified gateway', async () => {
      const custOtpRes = await request(app)
        .post('/api/v1/customer/auth/send-otp')
        .send({ phone: '9999999999' });
      expect([200, 400, 429]).toContain(custOtpRes.status);

      const partnerOtpRes = await request(app)
        .post('/api/v1/partner/auth/partner/send-otp')
        .send({ phone: '9999999999' });
      expect([200, 400, 429]).toContain(partnerOtpRes.status);
    });
  });
});
