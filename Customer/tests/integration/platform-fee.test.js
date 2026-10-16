'use strict';

const request = require('supertest');

const supabaseProvider = require('../../src/providers/supabase');
const { UserRepository } = require('../../src/repositories');
const redisService = require('../../src/services/redis.service');
const PlatformFeeRepository = require('../../src/repositories/platform-fee.repository');
const { createApp } = require('../../src/app');

const app = createApp();

describe('Integration: Customer Platform Fee API', () => {
  const CUSTOMER_USER = {
    id: 'c0000001-0000-4000-c000-000000000001',
    role: 'customer',
    name: 'Test Customer',
    phone: '9876543210',
    countryCode: '+91',
    email: 'testcustomer@example.com',
    authId: 'auth-test-cust-1',
    isActive: true,
  };

  const CUSTOMER_UPPERCASE_USER = {
    id: 'c0000002-0000-4000-c000-000000000002',
    role: 'CUSTOMER',
    name: 'Upper Customer',
    phone: '9876543212',
    countryCode: '+91',
    email: 'uppercustomer@example.com',
    authId: 'auth-test-cust-2',
    isActive: true,
  };

  const PARTNER_USER = {
    id: 'p0000001-0000-4000-p000-000000000001',
    role: 'partner',
    name: 'Test Partner',
    phone: '9876543211',
    countryCode: '+91',
    email: 'testpartner@example.com',
    authId: 'auth-test-partner-1',
    isActive: true,
  };

  const TOKENS = {
    customer: 'valid-customer-bearer-token',
    customerUpper: 'valid-customer-uppercase-token',
    partner: 'valid-partner-bearer-token',
  };

  let activeConfig;

  beforeEach(() => {
    jest.clearAllMocks();

    activeConfig = {
      id: 'f3b25efa-1d9f-43e3-9484-b87ce762b6e5',
      feeType: 'fixed',
      feeValue: 50.0,
      currency: 'INR',
      isActive: true,
      createdBy: 'a0000001-0000-4000-a000-000000000001',
      createdAt: new Date('2026-10-08T18:27:11.197Z').toISOString(),
      updatedAt: new Date('2026-10-08T18:27:11.197Z').toISOString(),
    };

    // Supabase auth token verification mock
    jest.spyOn(supabaseProvider, 'verifyIdToken').mockImplementation(async (token) => {
      if (token === TOKENS.customer) {
        return {
          uid: CUSTOMER_USER.authId,
          gongoUserId: CUSTOMER_USER.id,
        };
      }
      if (token === TOKENS.customerUpper) {
        return {
          uid: CUSTOMER_UPPERCASE_USER.authId,
          gongoUserId: CUSTOMER_UPPERCASE_USER.id,
        };
      }
      if (token === TOKENS.partner) {
        return {
          uid: PARTNER_USER.authId,
          gongoUserId: PARTNER_USER.id,
        };
      }
      const err = new Error('Invalid token');
      err.code = 'AUTH_INVALID_CREDENTIAL';
      throw err;
    });

    // User repository mock
    jest.spyOn(UserRepository.prototype, 'findById').mockImplementation(async (id) => {
      if (id === CUSTOMER_USER.id) return CUSTOMER_USER;
      if (id === CUSTOMER_UPPERCASE_USER.id) return CUSTOMER_UPPERCASE_USER;
      if (id === PARTNER_USER.id) return PARTNER_USER;
      return null;
    });

    // Redis session revocation mock (session is active)
    jest.spyOn(redisService, 'isUserSessionRevoked').mockResolvedValue(false);

    // Platform fee repository mock
    jest.spyOn(PlatformFeeRepository.prototype, 'findActive').mockImplementation(async () => activeConfig);
  });

  describe('GET /api/v1/customer/platform-fee', () => {
    it('12. Authenticated customer can get active platform fee', async () => {
      const res = await request(app)
        .get('/api/v1/customer/platform-fee')
        .set('Authorization', `Bearer ${TOKENS.customer}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        feeType: 'fixed',
        feeValue: 50,
        currency: 'INR',
      });
    });

    it('12b. Route alias /api/v1/platform-fee also works', async () => {
      const res = await request(app)
        .get('/api/v1/platform-fee')
        .set('Authorization', `Bearer ${TOKENS.customer}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.feeType).toBe('fixed');
    });

    it('12c. Route alias /customer/platform-fee also works', async () => {
      const res = await request(app)
        .get('/customer/platform-fee')
        .set('Authorization', `Bearer ${TOKENS.customer}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.feeType).toBe('fixed');
    });

    it('12d. Authenticated customer with uppercase role (CUSTOMER) is also authorized', async () => {
      const res = await request(app)
        .get('/api/v1/customer/platform-fee')
        .set('Authorization', `Bearer ${TOKENS.customerUpper}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.feeType).toBe('fixed');
    });

    it('13. Customer cannot modify platform fee (PUT returns 403 Forbidden)', async () => {
      const res = await request(app)
        .put('/api/v1/customer/platform-fee')
        .set('Authorization', `Bearer ${TOKENS.customer}`)
        .send({
          feeType: 'percentage',
          feeValue: 10,
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/cannot modify platform fee/i);
    });

    it('13b. Customer cannot modify platform fee via POST or DELETE', async () => {
      const postRes = await request(app)
        .post('/api/v1/customer/platform-fee')
        .set('Authorization', `Bearer ${TOKENS.customer}`)
        .send({ feeType: 'fixed', feeValue: 0 });

      expect(postRes.status).toBe(403);

      const delRes = await request(app)
        .delete('/api/v1/customer/platform-fee')
        .set('Authorization', `Bearer ${TOKENS.customer}`);

      expect(delRes.status).toBe(403);
    });

    it('14. Customer response does not expose internal fields', async () => {
      const res = await request(app)
        .get('/api/v1/customer/platform-fee')
        .set('Authorization', `Bearer ${TOKENS.customer}`);

      expect(res.status).toBe(200);
      const dataKeys = Object.keys(res.body.data);
      expect(dataKeys).toEqual(['feeType', 'feeValue', 'currency']);

      // Explicitly assert absence of internal columns
      expect(res.body.data.id).toBeUndefined();
      expect(res.body.data.createdBy).toBeUndefined();
      expect(res.body.data.created_by).toBeUndefined();
      expect(res.body.data.createdAt).toBeUndefined();
      expect(res.body.data.created_at).toBeUndefined();
      expect(res.body.data.updatedAt).toBeUndefined();
      expect(res.body.data.updated_at).toBeUndefined();
      expect(res.body.data.isActive).toBeUndefined();
      expect(res.body.data.is_active).toBeUndefined();
    });

    it('Unauthenticated request gets 401 Unauthorized', async () => {
      const res = await request(app).get('/api/v1/customer/platform-fee');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('Non-customer role (partner) gets 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/customer/platform-fee')
        .set('Authorization', `Bearer ${TOKENS.partner}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('Returns 404 when active configuration is not found', async () => {
      activeConfig = null;
      const res = await request(app)
        .get('/api/v1/customer/platform-fee')
        .set('Authorization', `Bearer ${TOKENS.customer}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/not found/i);
    });
  });
});
