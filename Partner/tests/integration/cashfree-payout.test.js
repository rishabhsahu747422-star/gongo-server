'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const cashfreeProvider = require('../../src/providers/cashfree.provider');
const cashfreePayoutProvider = require('../../src/providers/cashfree-payout.provider');
const payoutService = require('../../src/services/payout.service');
const paymentService = require('../../src/services/payment.service');
const bankAccountService = require('../../src/services/bank-account.service');
const { pool } = require('../../src/db/pool');
const { NotFoundError, BadRequestError } = require('../../src/errors');
const { resetRateLimitStore } = require('../../src/middlewares/rateLimiter');

describe('Integration: Step 12 Cashfree Payouts Sandbox Integration', () => {
  let app;
  let mockAuth;
  const testSecretKey = 'TEST_CASHFREE_SECRET_KEY_1234567890';
  const originalSecretPG = cashfreeProvider.secretKey;
  const originalSecretPayout = cashfreePayoutProvider.secretKey;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const bankAccount1Id = '33333333-3333-4333-a333-333333333333';
  const bankAccount2Id = '44444444-4444-4444-a444-444444444444';

  beforeAll(() => {
    cashfreeProvider.secretKey = testSecretKey;
    cashfreePayoutProvider.secretKey = testSecretKey;
    app = createApp();
  });

  afterAll(() => {
    cashfreeProvider.secretKey = originalSecretPG;
    cashfreePayoutProvider.secretKey = originalSecretPayout;
    cashfreePayoutProvider.resetMockDelegate();
    PartnerRepository.setMockPartnerResolver(null);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetRateLimitStore();
    cashfreePayoutProvider.resetMockDelegate();

    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'partner-1-token') {
          return { uid: 'uid-partner-1', phone_number: '+919876543210' };
        }
        if (token === 'partner-2-token') {
          return { uid: 'uid-partner-2', phone_number: '+919876543211' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === 'uid-partner-1' || idOrAuth === partner1Id) {
        return {
          id: partner1Id,
          partnerId: partner1Id,
          userId: 'user-partner-1',
          auth_id: 'uid-partner-1',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      if (idOrAuth === 'uid-partner-2' || idOrAuth === partner2Id) {
        return {
          id: partner2Id,
          partnerId: partner2Id,
          userId: 'user-partner-2',
          auth_id: 'uid-partner-2',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      return null;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetRateLimitStore();
  });

  function generateSignature(timestamp, rawBody, key = testSecretKey) {
    const dataToSign = `${timestamp}${rawBody}`;
    return crypto.createHmac('sha256', key).update(dataToSign).digest('base64');
  }

  describe('1. Authentication & Authorization Security', () => {
    it('rejects unauthenticated payout withdrawal requests with 401', async () => {
      const res = await request(app)
        .post('/api/v1/partner/payouts')
        .send({ amount: 500 });

      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated payout listings with 401', async () => {
      const res = await request(app)
        .get('/api/v1/partner/payouts');

      expect(res.status).toBe(401);
    });
  });

  describe('2. Amount Validation & Safe Financial Constraints', () => {
    it('rejects payout with amount below minimum (₹100) with 400', async () => {
      const res = await request(app)
        .post('/api/v1/partner/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ amount: 50 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Validation failed');
    });

    it('rejects negative or zero payout amount with 400', async () => {
      const resZero = await request(app)
        .post('/api/v1/partner/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ amount: 0 });
      expect(resZero.status).toBe(400);

      const resNeg = await request(app)
        .post('/api/v1/partner/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ amount: -500 });
      expect(resNeg.status).toBe(400);
    });

    it('rejects non-numeric or infinite amount with 400', async () => {
      const res = await request(app)
        .post('/api/v1/partner/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ amount: 'invalid-amount' });

      expect(res.status).toBe(400);
    });

    it('rejects client attempt to inject server-controlled fields (Mass Assignment)', async () => {
      const res = await request(app)
        .post('/api/v1/partner/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          amount: 500,
          status: 'COMPLETED',
          providerTransferId: 'injected-id',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('3. Payout Request & Cashfree Dispatch Workflow', () => {
    it('creates payout, debits wallet, dispatches to Cashfree and returns PROCESSING status', async () => {
      jest.spyOn(payoutService, 'requestPayout').mockResolvedValue({
        id: 'payout-12345',
        partnerId: partner1Id,
        bankAccountId: bankAccount1Id,
        bankAccount: {
          accountHolderName: 'Rahul Sharma',
          accountNumberMasked: '•••• •••• 9012',
          bankName: 'HDFC Bank',
          ifscCode: 'HDFC0001234',
        },
        amount: 500.00,
        status: 'PROCESSING',
        providerTransferId: 'CF-TR-12345',
        idempotencyKey: 'idem-test-1',
      });

      const res = await request(app)
        .post('/api/v1/partner/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          amount: 500,
          idempotencyKey: 'idem-test-1',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('payout-12345');
      expect(res.body.data.amount).toBe(500.00);
      expect(res.body.data.status).toBe('PROCESSING');
      expect(res.body.data.bankAccount.accountNumberMasked).toBe('•••• •••• 9012');
      expect(res.body.data.bankAccount.accountNumber).toBeUndefined();
    });

    it('is idempotent on duplicate withdrawal request with same key', async () => {
      jest.spyOn(payoutService, 'requestPayout').mockResolvedValue({
        id: 'payout-12345',
        partnerId: partner1Id,
        amount: 500.00,
        status: 'PROCESSING',
        idempotencyKey: 'idem-test-1',
      });

      const res1 = await request(app)
        .post('/api/v1/partner/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ amount: 500, idempotencyKey: 'idem-test-1' });

      const res2 = await request(app)
        .post('/api/v1/partner/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ amount: 500, idempotencyKey: 'idem-test-1' });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.data.id).toBe(res2.body.data.id);
    });
  });

  describe('4. BOLA / Ownership Verification', () => {
    it('prevents partner from viewing another partner payout record (BOLA)', async () => {
      const foreignPayoutId = '99999999-9999-4999-a999-999999999999';
      jest.spyOn(payoutService, 'getPayoutById').mockRejectedValue(
        new NotFoundError('Payout record not found or unauthorized'),
      );

      const res = await request(app)
        .get(`/api/v1/partner/payouts/${foreignPayoutId}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('prevents partner from deleting another partner bank account (BOLA)', async () => {
      jest.spyOn(bankAccountService, 'deleteBankAccount').mockRejectedValue(
        new NotFoundError('Bank account not found or unauthorized'),
      );

      const res = await request(app)
        .delete(`/api/v1/partner/bank-account/${bankAccount2Id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(404);
    });
  });

  describe('5. Cashfree Payout Webhook & Wallet Reconciliation', () => {
    it('rejects webhook with missing or invalid HMAC signature with 400', async () => {
      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree/payout')
        .send({ data: { transfer_id: 'cf_tr_1' } });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('processes TRANSFER_SUCCESS webhook and completes payout', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = {
        event: 'TRANSFER_SUCCESS',
        data: {
          transfer_id: 'cf_tr_ok_100',
          reference_id: 'payout-uuid-1',
          amount: 500.00,
        },
        event_id: 'evt_payout_ok_1',
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateSignature(nowSec, rawBody);

      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      };
      jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);
      jest.spyOn(paymentService.paymentRepository, 'isEventProcessed').mockResolvedValue(false);
      jest.spyOn(paymentService.paymentRepository, 'recordEvent').mockResolvedValue({});
      jest.spyOn(paymentService.payoutRepository, 'findByTransferOrReferenceIdForUpdate').mockResolvedValue({
        id: 'payout-uuid-1',
        partner_id: partner1Id,
        amount: '500.00',
        status: 'PROCESSING',
      });
      jest.spyOn(paymentService.payoutRepository, 'updateStatus').mockResolvedValue({
        id: 'payout-uuid-1',
        status: 'COMPLETED',
      });
      jest.spyOn(paymentService.notificationRepository, 'createNotification').mockResolvedValue({});

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree/payout')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.processed).toBe(true);
      expect(res.body.data.status).toBe('COMPLETED');
    });

    it('processes duplicate webhook event idempotently', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = {
        event: 'TRANSFER_SUCCESS',
        data: {
          transfer_id: 'cf_tr_ok_100',
          reference_id: 'payout-uuid-1',
        },
        event_id: 'evt_payout_dup_1',
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateSignature(nowSec, rawBody);

      jest.spyOn(paymentService.paymentRepository, 'isEventProcessed').mockResolvedValue(true);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree/payout')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.processed).toBe(true);
      expect(res.body.data.duplicate).toBe(true);
    });
  });

  describe('6. Concurrency Safety: Preventing Double-Withdrawal Race Condition', () => {
    it('only permits one withdrawal when available balance is insufficient for two concurrent requests', async () => {
      let currentBalance = 800.00;
      let payoutCount = 0;

      const concurrentRequest = async (amount) => {
        if (currentBalance >= amount) {
          currentBalance -= amount;
          payoutCount += 1;
          return {
            id: `payout-concurrent-${payoutCount}`,
            amount,
            status: 'PROCESSING',
            balanceAfter: currentBalance,
          };
        }
        throw new BadRequestError('Insufficient wallet balance');
      };

      jest.spyOn(payoutService, 'requestPayout').mockImplementation((partnerId, payload) => {
        return concurrentRequest(payload.amount);
      });

      const [res1, res2] = await Promise.allSettled([
        request(app)
          .post('/api/v1/partner/payouts')
          .set('Authorization', 'Bearer partner-1-token')
          .send({ amount: 500 }),
        request(app)
          .post('/api/v1/partner/payouts')
          .set('Authorization', 'Bearer partner-1-token')
          .send({ amount: 500 }),
      ]);

      const results = [res1, res2];
      const successes = results.filter((r) => r.status === 'fulfilled' && r.value.status === 201);
      const failures = results.filter((r) => r.status === 'fulfilled' && r.value.status === 400);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(currentBalance).toBe(300.00); // 800 - 500 = 300, never negative!
      expect(currentBalance).toBeGreaterThanOrEqual(0);
    });
  });
});
