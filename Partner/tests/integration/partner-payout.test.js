'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const bankAccountService = require('../../src/services/bank-account.service');
const payoutService = require('../../src/services/payout.service');

describe('Integration: Partner Bank Accounts & Payout System (Phase 12D)', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const bankAccount1Id = '44444444-4444-4444-a444-444444444444';
  const payout1Id = '55555555-5555-4555-a555-555555555555';

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

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

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  describe('Bank Account Endpoints', () => {
    it('POST /api/v1/partner/bank-account creates bank account with masked number', async () => {
      jest.spyOn(bankAccountService, 'addBankAccount').mockResolvedValue({
        id: bankAccount1Id,
        partnerId: partner1Id,
        accountHolderName: 'Rahul Sharma',
        accountNumberMasked: '•••• •••• 9012',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
        isPrimary: true,
        verificationStatus: 'VERIFIED',
      });

      const res = await request(app)
        .post('/api/v1/partner/bank-account')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          accountHolderName: 'Rahul Sharma',
          accountNumber: '123456789012',
          ifscCode: 'HDFC0001234',
          bankName: 'HDFC Bank',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(bankAccount1Id);
      expect(res.body.data.accountNumberMasked).toBe('•••• •••• 9012');
      expect(res.body.data.accountNumber).toBeUndefined();
    });

    it('GET /api/v1/partner/bank-account returns bank accounts list', async () => {
      jest.spyOn(bankAccountService, 'getBankAccounts').mockResolvedValue([
        {
          id: bankAccount1Id,
          partnerId: partner1Id,
          accountHolderName: 'Rahul Sharma',
          accountNumberMasked: '•••• •••• 9012',
          ifscCode: 'HDFC0001234',
          bankName: 'HDFC Bank',
          isPrimary: true,
          verificationStatus: 'VERIFIED',
        },
      ]);

      const res = await request(app)
        .get('/api/v1/partner/bank-account')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].accountNumberMasked).toBe('•••• •••• 9012');
    });

    it('DELETE /api/v1/partner/bank-account/:bankAccountId deletes account', async () => {
      jest.spyOn(bankAccountService, 'deleteBankAccount').mockResolvedValue({ deleted: true });

      const res = await request(app)
        .delete(`/api/v1/partner/bank-account/${bankAccount1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.deleted).toBe(true);
      expect(bankAccountService.deleteBankAccount).toHaveBeenCalledWith(partner1Id, bankAccount1Id);
    });
  });

  describe('Payout Endpoints', () => {
    it('POST /api/v1/partner/payouts creates payout withdrawal', async () => {
      jest.spyOn(payoutService, 'requestPayout').mockResolvedValue({
        id: payout1Id,
        partnerId: partner1Id,
        bankAccountId: bankAccount1Id,
        amount: 500.00,
        status: 'REQUESTED',
        idempotencyKey: 'idem-1',
      });

      const res = await request(app)
        .post('/api/v1/partner/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          amount: 500,
          idempotencyKey: 'idem-1',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(payout1Id);
      expect(res.body.data.amount).toBe(500.00);
      expect(res.body.data.status).toBe('REQUESTED');
    });

    it('GET /api/v1/partner/payouts returns paginated payouts', async () => {
      jest.spyOn(payoutService, 'getPayouts').mockResolvedValue({
        items: [
          {
            id: payout1Id,
            partnerId: partner1Id,
            bankAccountId: bankAccount1Id,
            amount: 500.00,
            status: 'REQUESTED',
          },
        ],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/partner/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].id).toBe(payout1Id);
    });

    it('GET /api/v1/partner/payouts/:payoutId returns single payout details', async () => {
      jest.spyOn(payoutService, 'getPayoutById').mockResolvedValue({
        id: payout1Id,
        partnerId: partner1Id,
        bankAccountId: bankAccount1Id,
        amount: 500.00,
        status: 'REQUESTED',
      });

      const res = await request(app)
        .get(`/api/v1/partner/payouts/${payout1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(payout1Id);
      expect(payoutService.getPayoutById).toHaveBeenCalledWith(partner1Id, payout1Id);
    });

    it('rejects unauthenticated requests to payout endpoints with 401', async () => {
      await request(app)
        .get('/api/v1/partner/payouts')
        .expect(401);
    });
  });
});
