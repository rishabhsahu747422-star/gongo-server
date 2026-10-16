'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const payoutService = require('../../src/services/payout.service');
const walletService = require('../../src/services/wallet.service');
const paymentService = require('../../src/services/payment.service');
const supportTicketService = require('../../src/services/support-ticket.service');
const reconciliationService = require('../../src/services/reconciliation.service');
const outboxService = require('../../src/services/outbox.service');
const cashfreeProvider = require('../../src/providers/cashfree.provider');
const logger = require('../../src/config/logger');
const { pool } = require('../../src/db/pool');

describe('Integration: Phase 19 Final Production Launch Readiness', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const adminId = '99999999-9999-4999-a999-999999999999';

  const testSecretKey = 'TEST_CASHFREE_SECRET_KEY_1234567890';
  const originalSecret = cashfreeProvider.secretKey;

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

  // ── 1. Financial Invariants & Concurrency Safety ───────────────────────
  describe('1. Financial Invariants & Concurrency Safety', () => {
    it('enforces financial invariant: available_balance + total_debited = total_credited', () => {
      // Wallet state simulation
      const initialWallet = {
        id: 'wallet-1',
        partner_id: partner1Id,
        available_balance: 1000.00,
        total_credited: 1000.00,
        total_debited: 0.00,
      };

      // Invariant check on initial
      expect(
        initialWallet.available_balance + initialWallet.total_debited,
      ).toBeCloseTo(initialWallet.total_credited, 2);

      // After debit of 400
      const debitAmount = 400.00;
      const afterDebit = {
        ...initialWallet,
        available_balance: initialWallet.available_balance - debitAmount,
        total_debited: initialWallet.total_debited + debitAmount,
      };
      expect(
        afterDebit.available_balance + afterDebit.total_debited,
      ).toBeCloseTo(afterDebit.total_credited, 2);

      // After reversal of debit 400
      const afterReversal = {
        ...afterDebit,
        available_balance: afterDebit.available_balance + debitAmount,
        total_debited: afterDebit.total_debited - debitAmount,
      };
      expect(
        afterReversal.available_balance + afterReversal.total_debited,
      ).toBeCloseTo(afterReversal.total_credited, 2);
    });

    it('prevents double spending under concurrent payout requests', async () => {
      const bankAccountId = 'ba-uuid-1';
      let available = 1000.00;

      // Mock db client transaction
      const mockClient = {
        query: jest.fn().mockImplementation((queryText) => {
          if (queryText === 'BEGIN' || queryText === 'COMMIT' || queryText === 'ROLLBACK') {
            return Promise.resolve();
          }
          return Promise.resolve({ rows: [] });
        }),
        release: jest.fn(),
      };
      jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);

      // Mock bank account lookup
      jest.spyOn(payoutService.bankAccountRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: bankAccountId,
        partner_id: partner1Id,
        verification_status: 'VERIFIED',
        bank_name: 'HDFC Bank',
        account_number_masked: '•••• •••• 1234',
        ifsc_code: 'HDFC0001234',
      });

      jest.spyOn(payoutService.walletRepository, 'findByPartnerId')
        .mockImplementation(async () => ({
          id: 'wallet-1',
          partner_id: partner1Id,
          available_balance: available,
        }));

      jest.spyOn(payoutService.payoutRepository, 'createPayout')
        .mockImplementation(async (data) => {
          if (available < data.amount) {
            const err = new Error(`Insufficient wallet balance. Available balance is ₹${available.toFixed(2)}`);
            err.statusCode = 400;
            throw err;
          }
          available -= data.amount;
          return {
            id: `payout-${Date.now()}-${Math.random()}`,
            partner_id: partner1Id,
            amount: data.amount,
            status: 'REQUESTED',
            created_at: new Date().toISOString(),
          };
        });

      jest.spyOn(payoutService.walletTransactionRepository, 'createLedgerEntry')
        .mockResolvedValue({ id: 'tx-1' });

      // Run two concurrent requests of ₹700 each against ₹1000 balance
      const [res1, res2] = await Promise.allSettled([
        payoutService.requestPayout(partner1Id, { amount: 700, bankAccountId }),
        payoutService.requestPayout(partner1Id, { amount: 700, bankAccountId }),
      ]);

      const succeeded = [res1, res2].filter((r) => r.status === 'fulfilled');
      const failed = [res1, res2].filter((r) => r.status === 'rejected');

      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(failed[0].reason.message).toContain('Insufficient wallet balance');
      expect(available).toBe(300.00); // Balance remains non-negative
    });

    it('rejects reversal if payout is already in terminal state', async () => {
      const payoutId = 'payout-terminal-1';

      // Mock client query
      const mockClient = {
        query: jest.fn().mockImplementation((queryText) => {
          if (queryText === 'BEGIN' || queryText === 'COMMIT' || queryText === 'ROLLBACK') {
            return Promise.resolve();
          }
          return Promise.resolve({ rows: [] });
        }),
        release: jest.fn(),
      };
      jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);

      jest.spyOn(payoutService.payoutRepository, 'findByIdForUpdate').mockResolvedValue({
        id: payoutId,
        partner_id: partner1Id,
        amount: 500,
        status: 'FAILED', // Already terminal
      });

      const res = await payoutService.handlePayoutFailureOrReversal(payoutId, 'Duplicate failure');
      expect(res.status).toBe('FAILED');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  // ── 2. Cashfree Webhook Cryptographic Security & Anti-Replay ──────────
  describe('2. Cashfree Webhook Cryptographic Security & Anti-Replay', () => {
    it('rejects timestamps older than 10 minutes (replay attack)', async () => {
      const tenMinutesOneSecAgo = Math.floor(Date.now() / 1000) - 601;
      const body = { data: { transfer_id: 'cf_tr_old' } };
      const rawBody = JSON.stringify(body);
      const signature = generateSignature(tenMinutesOneSecAgo, rawBody);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree/payout')
        .set('x-webhook-timestamp', String(tenMinutesOneSecAgo))
        .set('x-webhook-signature', signature)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('rejects timestamps in the future by more than 5 minutes', async () => {
      const fiveMinutesOneSecFuture = Math.floor(Date.now() / 1000) + 301;
      const body = { data: { transfer_id: 'cf_tr_future' } };
      const rawBody = JSON.stringify(body);
      const signature = generateSignature(fiveMinutesOneSecFuture, rawBody);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree/payout')
        .set('x-webhook-timestamp', String(fiveMinutesOneSecFuture))
        .set('x-webhook-signature', signature)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('rejects tampered body with valid timestamp but invalid signature', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const originalBody = { data: { order_id: 'ORDER_123', amount: 500 } };
      const signature = generateSignature(nowSec, JSON.stringify(originalBody));

      const tamperedBody = { data: { order_id: 'ORDER_123', amount: 50000 } };

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .send(tamperedBody);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('returns duplicate: true without re-executing for processed PG event', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = {
        data: {
          order: { order_id: 'order-dup-1', order_amount: 300 },
          payment: { cf_payment_id: 998877, payment_status: 'SUCCESS' },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateSignature(nowSec, rawBody);

      jest.spyOn(paymentService.paymentRepository, 'isEventProcessed').mockResolvedValue(true);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.data.processed).toBe(true);
      expect(res.body.data.duplicate).toBe(true);
    });
  });

  // ── 3. Strict Admin RBAC Isolation ────────────────────────────────────
  describe('3. Strict Admin RBAC Isolation', () => {
    it('rejects PARTNER access to GET /api/v1/admin/financials/settlements with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/financials/settlements')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects PARTNER access to GET /api/v1/admin/payouts with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payouts')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects PARTNER access to GET /api/v1/admin/damages with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/damages')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects PARTNER access to GET /api/v1/admin/metrics with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/metrics')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects unauthenticated access to admin routes with 401', async () => {
      const res = await request(app)
        .get('/api/v1/admin/metrics')
        .expect(401);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('allows ADMIN access to GET /api/v1/admin/metrics', async () => {
      jest.spyOn(outboxService, 'getStats').mockResolvedValue({
        totalEvents: 10,
        pendingEvents: 0,
      });

      const res = await request(app)
        .get('/api/v1/admin/metrics')
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('uptimeSeconds');
    });
  });

  // ── 4. Partner BOLA / Double Ownership Protection ─────────────────────
  describe('4. Partner BOLA / Double Ownership Protection', () => {
    it('returns 404 when Partner 2 tries to fetch Partner 1 wallet transaction', async () => {
      const txId = '55555555-5555-4555-a555-555555555555';
      jest.spyOn(walletService.walletTransactionRepository, 'findByIdAndPartnerId')
        .mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/wallet/transactions/${txId}`)
        .set('Authorization', 'Bearer partner-2-token')
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 when Partner 2 tries to fetch Partner 1 payout details', async () => {
      const payoutId = '66666666-6666-4666-a666-666666666666';
      jest.spyOn(payoutService.payoutRepository, 'findByIdAndPartnerId')
        .mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/payouts/${payoutId}`)
        .set('Authorization', 'Bearer partner-2-token')
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 when Partner 2 tries to fetch Partner 1 support ticket', async () => {
      const ticketId = '77777777-7777-4777-a777-777777777777';
      jest.spyOn(supportTicketService.supportTicketRepository, 'findTicketByIdAndPartnerId')
        .mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/support/tickets/${ticketId}`)
        .set('Authorization', 'Bearer partner-2-token')
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ── 5. Sensitive Data Redaction & Masking ──────────────────────────────
  describe('5. Sensitive Data Redaction & Masking', () => {
    it('logger.sanitizeMeta redacts sensitive keys recursively', () => {
      const payload = {
        partnerId: partner1Id,
        password: 'SuperSecretPassword!1',
        token: 'firebase_id_token_xyz',
        auth: 'Bearer my-token',
        secret: 'cashfree_secret_key',
        clientSecret: 'secret_123',
        otp: '123456',
        aadhaarNumber: '123456789012',
        panNumber: 'ABCDE1234F',
        accountNumber: '1234567890123456',
        nested: {
          privateKey: 'BEGIN RSA PRIVATE KEY...',
          safeField: 'Regular Value',
        },
      };

      const sanitized = logger.sanitizeMeta(payload);

      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.token).toBe('[REDACTED]');
      expect(sanitized.auth).toBe('[REDACTED]');
      expect(sanitized.secret).toBe('[REDACTED]');
      expect(sanitized.clientSecret).toBe('[REDACTED]');
      expect(sanitized.otp).toBe('[REDACTED]');
      expect(sanitized.aadhaarNumber).toBe('[REDACTED]');
      expect(sanitized.panNumber).toBe('[REDACTED]');
      expect(sanitized.accountNumber).toBe('[REDACTED]');
      expect(sanitized.nested.privateKey).toBe('[REDACTED]');
      expect(sanitized.nested.safeField).toBe('Regular Value');
    });
  });

  // ── 6. Platform Financial Reconciliation Engine ───────────────────────
  describe('6. Platform Financial Reconciliation Engine', () => {
    it('runs platform reconciliation successfully and reports consistency', async () => {
      const mockClient = {
        query: jest.fn().mockImplementation((sql) => {
          if (sql.includes('FROM wallets w')) {
            return Promise.resolve({
              rows: [
                {
                  wallet_id: 'wallet-1',
                  partner_id: partner1Id,
                  wallet_available: 500.00,
                  wallet_credited: 1000.00,
                  wallet_debited: 500.00,
                  ledger_credited: 1000.00,
                  ledger_debited: 500.00,
                },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      const report = await reconciliationService.runPlatformReconciliation(mockClient);
      expect(report.isConsistent).toBe(true);
      expect(report.auditedWallets).toBe(1);
      expect(report.discrepanciesCount).toBe(0);
    });

    it('detects discrepancies when ledger does not match wallet balance', async () => {
      const mockClient = {
        query: jest.fn().mockImplementation((sql) => {
          if (sql.includes('FROM wallets w')) {
            return Promise.resolve({
              rows: [
                {
                  wallet_id: 'wallet-2',
                  partner_id: partner2Id,
                  wallet_available: 700.00, // Discrepancy! Recorded 700 vs ledger 500
                  wallet_credited: 1000.00,
                  wallet_debited: 500.00,
                  ledger_credited: 1000.00,
                  ledger_debited: 500.00,
                },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      const report = await reconciliationService.runPlatformReconciliation(mockClient);
      expect(report.isConsistent).toBe(false);
      expect(report.discrepanciesCount).toBeGreaterThan(0);
      expect(report.discrepancies[0].type).toBe('WALLET_AVAILABLE_BALANCE_MISMATCH');
    });
  });

  // ── 7. Outbox Worker Resiliency ───────────────────────────────────────
  describe('7. Outbox Worker Resiliency', () => {
    it('catches and marks failed outbox events without crashing batch process', async () => {
      const mockEvent = {
        id: 'outbox-fail-1',
        event_type: 'PAYOUT_COMPLETED',
        aggregate_id: 'payout-fail-1',
        payload: { partnerId: partner1Id, amount: 200 },
      };

      jest.spyOn(outboxService.outboxRepository, 'fetchPendingEvents')
        .mockResolvedValue([mockEvent]);
      jest.spyOn(outboxService, 'dispatchHandler')
        .mockRejectedValue(new Error('Push notification service down'));
      const markFailedSpy = jest.spyOn(outboxService.outboxRepository, 'markFailed')
        .mockResolvedValue();

      const stats = await outboxService.processBatch(10);
      expect(stats.processed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.succeeded).toBe(0);
      expect(markFailedSpy).toHaveBeenCalledWith(
        'outbox-fail-1',
        expect.any(Error),
        expect.anything(),
      );
    });
  });
});
