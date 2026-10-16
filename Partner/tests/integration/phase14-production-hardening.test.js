'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const payoutService = require('../../src/services/payout.service');
const adminFinancialService = require('../../src/services/admin-financial.service');
const paymentService = require('../../src/services/payment.service');
const notificationService = require('../../src/services/notification.service');
const cashfreeProvider = require('../../src/providers/cashfree.provider');
const { encrypt, decrypt } = require('../../src/utils/crypto');
const { pool } = require('../../src/db/pool');

describe('Integration: Phase 14 Production Hardening & Security Audit', () => {
  let app;
  let mockAuth;
  const testSecretKey = 'HARDENED_TEST_SECRET_KEY_1234567890';
  const originalSecret = cashfreeProvider.secretKey;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const adminId = '99999999-9999-4999-a999-999999999999';

  beforeAll(() => {
    cashfreeProvider.secretKey = testSecretKey;
    app = createApp();
  });

  afterAll(() => {
    cashfreeProvider.secretKey = originalSecret;
    PartnerRepository.setMockPartnerResolver(null);
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
        if (token === 'admin-token') {
          return { uid: 'uid-admin', phone_number: '+919876543299' };
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
      if (idOrAuth === 'uid-admin' || idOrAuth === adminId) {
        return {
          id: adminId,
          partnerId: adminId,
          userId: 'user-admin',
          auth_id: 'uid-admin',
          role: 'ADMIN',
          is_active: true,
        };
      }
      return null;
    });
  });

  function generateSignature(timestamp, rawBody, key = testSecretKey) {
    const dataToSign = `${timestamp}${rawBody}`;
    return crypto.createHmac('sha256', key).update(dataToSign).digest('base64');
  }

  describe('1. BOLA / Partner Identity Isolation', () => {
    it('prevents partner from accessing another partner payout with 404', async () => {
      jest.spyOn(payoutService.payoutRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/partner/payouts/55555555-5555-4555-a555-555555555555')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(payoutService.payoutRepository.findByIdAndPartnerId).toHaveBeenCalledWith(
        '55555555-5555-4555-a555-555555555555',
        partner1Id,
      );
    });

    it('prevents partner from marking another partner notification as read with 404', async () => {
      const otherNotifId = '44444444-4444-4444-a444-444444444444';
      jest.spyOn(notificationService.notificationRepository, 'markAsReadByIdAndPartnerId')
        .mockResolvedValue(null);

      const res = await request(app)
        .patch(`/api/v1/partner/notifications/${otherNotifId}/read`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(notificationService.notificationRepository.markAsReadByIdAndPartnerId)
        .toHaveBeenCalledWith(otherNotifId, partner1Id);
    });
  });

  describe('2. Admin Role & RBAC Hardening', () => {
    it('rejects unauthenticated requests to /api/v1/admin/* with 401', async () => {
      const res = await request(app)
        .get('/api/v1/admin/financials/commissions');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects partner token accessing confidential commissions with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/financials/commissions')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('allows admin role to access admin financials and commissions', async () => {
      jest.spyOn(adminFinancialService.commissionRepository, 'findPaginated').mockResolvedValue({
        rows: [],
        total: 0,
      });

      const res = await request(app)
        .get('/api/v1/admin/financials/commissions')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('3. Payout State Machine Invariants', () => {
    it('rejects moving COMPLETED payout to PROCESSING with 400', async () => {
      jest.spyOn(adminFinancialService.payoutRepository, 'findByIdAdmin').mockResolvedValue({
        id: 'payout-comp',
        status: 'COMPLETED',
        partner_id: partner1Id,
      });

      await expect(
        adminFinancialService.processPayout('payout-comp'),
      ).rejects.toThrow();
    });

    it('rejects completing a FAILED payout with 400', async () => {
      jest.spyOn(adminFinancialService.payoutRepository, 'findByIdAdmin').mockResolvedValue({
        id: 'payout-fail',
        status: 'FAILED',
        partner_id: partner1Id,
      });

      await expect(
        adminFinancialService.completePayout('payout-fail'),
      ).rejects.toThrow();
    });

    it('idempotently handles repeated processPayout when already in PROCESSING', async () => {
      jest.spyOn(adminFinancialService.payoutRepository, 'findByIdAdmin').mockResolvedValue({
        id: 'payout-proc',
        status: 'PROCESSING',
        partner_id: partner1Id,
        amount: '1000.00',
        provider_transfer_id: 'cf_tr_1',
      });

      const res = await adminFinancialService.processPayout('payout-proc', {
        providerTransferId: 'cf_tr_1',
      });

      expect(res.id).toBe('payout-proc');
      expect(res.status).toBe('PROCESSING');
    });
  });

  describe('4. Idempotency Key Conflict Protection', () => {
    it('rejects duplicate idempotencyKey with different amount with 409 Conflict', async () => {
      jest.spyOn(payoutService.payoutRepository, 'findByIdempotencyKey').mockResolvedValue({
        id: 'existing-payout',
        partner_id: partner1Id,
        amount: '1000.00',
        bank_account_id: 'bank-1',
        status: 'REQUESTED',
      });

      await expect(
        payoutService.requestPayout(partner1Id, {
          amount: 2000.00,
          idempotencyKey: 'idem-key-conflict',
        }),
      ).rejects.toThrow();
    });
  });

  describe('5. Bank Account Security & PII Protection', () => {
    it('encrypts and decrypts bank account number with AES-256-GCM successfully', () => {
      const rawAccount = '9876543210123456';
      const encrypted = encrypt(rawAccount);

      expect(encrypted).not.toBe(rawAccount);
      expect(encrypted).toContain(':'); // iv:authTag:cipher

      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(rawAccount);
    });

    it('throws error when attempting to decrypt corrupted cipher text', () => {
      const corrupted = '00112233445566778899aabbccddeeff:112233445566778899aabbccddeeff00:aabbccdd';
      expect(() => decrypt(corrupted)).toThrow('Failed to decrypt data');
    });
  });

  describe('6. Cashfree Payout Webhook Hardening & Atomic Reversal', () => {
    it('handles TRANSFER_REVERSED and restores partner balance via reverseDebitWallet', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = {
        event: 'TRANSFER_REVERSED',
        data: {
          transfer_id: 'cf_tr_rev_999',
          reference_id: 'payout-rev-uuid',
          reason: 'Beneficiary bank technical reversal',
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateSignature(nowSec, rawBody);

      const mockPayout = {
        id: 'payout-rev-uuid',
        partner_id: partner1Id,
        amount: '1500.00',
        status: 'PROCESSING',
      };

      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      };

      jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);
      jest.spyOn(paymentService.paymentRepository, 'isEventProcessed').mockResolvedValue(false);
      jest.spyOn(paymentService.paymentRepository, 'recordEvent').mockResolvedValue({});
      jest.spyOn(paymentService.payoutRepository, 'findByTransferOrReferenceIdForUpdate')
        .mockResolvedValue(mockPayout);
      jest.spyOn(paymentService.walletRepository, 'reverseDebitWallet').mockResolvedValue({
        wallet: { id: 'wallet-1' },
        newAvailable: 4500.00,
        reverseAmount: 1500.00,
      });
      jest.spyOn(paymentService.walletTransactionRepository, 'createLedgerEntry').mockResolvedValue({});
      jest.spyOn(paymentService.payoutRepository, 'updateStatus').mockResolvedValue({});
      jest.spyOn(paymentService.notificationRepository, 'createNotification').mockResolvedValue({});

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree/payout')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('FAILED');
      expect(paymentService.walletRepository.reverseDebitWallet).toHaveBeenCalledWith(
        partner1Id,
        1500.00,
        mockClient,
      );
      expect(paymentService.walletTransactionRepository.createLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: 'PAYOUT_REVERSAL',
          direction: 'CREDIT',
          amount: 1500.00,
        }),
        mockClient,
      );
    });
  });

  describe('7. Wallet Ledger Mathematical Invariant', () => {
    it('verifies that creditWallet adds to available balance and total_credited', async () => {
      const mockClient = {
        query: jest.fn(),
      };

      jest.spyOn(paymentService.walletRepository, 'findByPartnerIdForUpdate').mockResolvedValue({
        id: 'wal-1',
        partner_id: partner1Id,
        available_balance: '1000.00',
        total_credited: '2000.00',
        total_debited: '1000.00',
      });
      jest.spyOn(paymentService.walletRepository, 'updateBalances').mockImplementation(
        async (id, { availableBalance, totalCredited }) => ({
          id,
          available_balance: availableBalance,
          total_credited: totalCredited,
        }),
      );

      const result = await paymentService.walletRepository.creditWallet(
        partner1Id,
        500.00,
        mockClient,
      );
      expect(result.newAvailable).toBe(1500.00);
      expect(result.wallet.total_credited).toBe(2500.00);
    });

    it('verifies that debitWallet subtracts from available balance and adds to total_debited', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{
            id: 'wal-1',
            partner_id: partner1Id,
            available_balance: '500.00',
            total_debited: '1500.00',
          }],
        }),
      };

      jest.spyOn(paymentService.walletRepository, 'findByPartnerIdForUpdate').mockResolvedValue({
        id: 'wal-1',
        partner_id: partner1Id,
        available_balance: '1000.00',
        total_credited: '2000.00',
        total_debited: '1000.00',
      });

      const result = await paymentService.walletRepository.debitWallet(
        partner1Id,
        500.00,
        mockClient,
      );
      expect(result.insufficientBalance).toBe(false);
      expect(result.newAvailable).toBe(500.00);
    });

    it('verifies that debitWallet rejects when available balance is insufficient', async () => {
      const mockClient = { query: jest.fn() };

      jest.spyOn(paymentService.walletRepository, 'findByPartnerIdForUpdate').mockResolvedValue({
        id: 'wal-1',
        partner_id: partner1Id,
        available_balance: '200.00',
        total_credited: '1000.00',
        total_debited: '800.00',
      });

      const result = await paymentService.walletRepository.debitWallet(
        partner1Id,
        500.00,
        mockClient,
      );
      expect(result.insufficientBalance).toBe(true);
      expect(result.previousAvailable).toBe(200.00);
    });
  });
});
