'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const paymentRepository = require('../../src/repositories/payment.repository');
const paymentService = require('../../src/services/payment.service');
const cashfreeProvider = require('../../src/providers/cashfree.provider');
const { PAYMENT_STATUS, PAYMENT_TYPE } = require('../../src/constants/payment');
const {
  WALLET_TRANSACTION_TYPE,
  TRANSACTION_DIRECTION,
  TRANSACTION_STATUS,
  WALLET_REFERENCE_TYPE,
} = require('../../src/constants/wallet');

describe('Integration: Phase 12A — Wallet Credit + Immutable Financial Ledger', () => {
  let app;
  const testSecretKey = 'TEST_SECRET_FOR_SETTLEMENT_CREDIT_KEY_123';
  const originalSecret = cashfreeProvider.secretKey;

  const partnerId = '11111111-1111-4111-a111-111111111111';
  const bookingId = '22222222-2222-4222-a222-222222222222';
  const paymentId = '33333333-3333-4333-a333-333333333333';
  const walletId = '44444444-4444-4444-a444-444444444444';
  const providerOrderId = 'cf_settle_order_12a_001';

  beforeAll(() => {
    cashfreeProvider.secretKey = testSecretKey;
    app = createApp();
  });

  afterAll(() => {
    cashfreeProvider.secretKey = originalSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function generateSignature(timestamp, rawBody, key = testSecretKey) {
    const dataToSign = `${timestamp}${rawBody}`;
    return crypto.createHmac('sha256', key).update(dataToSign).digest('base64');
  }

  describe('Successful Settlement Credit Flow', () => {
    it('credits partner wallet and appends immutable ledger entry on valid settlement payment', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const settlementAmount = 500.00;

      const payload = {
        data: {
          order: {
            order_id: providerOrderId,
            order_amount: settlementAmount,
            order_currency: 'INR',
          },
          payment: {
            cf_payment_id: 'cf_pay_succ_12a',
            payment_status: 'SUCCESS',
            payment_amount: settlementAmount,
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateSignature(nowSec, rawBody);

      const lockedPayment = {
        id: paymentId,
        booking_id: bookingId,
        payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        amount: '500.00',
        currency: 'INR',
        status: PAYMENT_STATUS.PENDING,
        provider_order_id: providerOrderId,
        metadata: { lateFee: 300.00, extraKmFee: 200.00 },
      };

      const initialWallet = {
        id: walletId,
        partner_id: partnerId,
        available_balance: '1000.00',
        pending_balance: '0.00',
        total_credited: '1000.00',
        total_debited: '0.00',
        currency: 'INR',
      };

      let currentWallet = { ...initialWallet };
      const createdLedgerEntries = [];

      jest.spyOn(paymentRepository, 'isEventProcessed').mockResolvedValue(false);
      jest.spyOn(paymentRepository, 'lockByProviderOrderId').mockResolvedValue(lockedPayment);
      jest.spyOn(paymentRepository, 'recordEvent').mockResolvedValue({ id: 'evt-12a-1' });
      jest.spyOn(paymentRepository, 'updateStatus').mockImplementation(async (id, status, fields) => {
        lockedPayment.status = status;
        lockedPayment.provider_payment_id = fields?.providerPaymentId;
        return lockedPayment;
      });

      // Spy on withTransaction and simulate atomic PostgreSQL client
      jest.spyOn(paymentRepository, 'withTransaction').mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn(async (sql) => {
            if (sql.includes('SELECT id, partner_id, booking_number FROM bookings')) {
              return { rows: [{ id: bookingId, partner_id: partnerId, booking_number: 'BK-12A-01' }] };
            }
            if (sql.includes('partner_notifications')) {
              return { rows: [{ id: 'notif-1' }] };
            }
            return { rows: [] };
          }),
        };
        return callback(mockClient);
      });

      // Spy on walletRepository
      jest.spyOn(paymentService.walletRepository, 'findByPartnerIdForUpdate').mockImplementation(
        async (pId) => (pId === partnerId ? currentWallet : null),
      );

      jest.spyOn(paymentService.walletRepository, 'creditWallet').mockImplementation(async (pId, amount) => {
        const prev = Number(currentWallet.available_balance);
        const newAvail = Number((prev + amount).toFixed(2));
        const newTot = Number((Number(currentWallet.total_credited) + amount).toFixed(2));
        currentWallet = {
          ...currentWallet,
          available_balance: String(newAvail),
          total_credited: String(newTot),
        };
        return {
          wallet: currentWallet,
          previousAvailable: prev,
          newAvailable: newAvail,
          creditAmount: amount,
        };
      });

      // Spy on walletTransactionRepository
      jest.spyOn(paymentService.walletTransactionRepository, 'findByReference').mockImplementation(
        async () => createdLedgerEntries.find(
          (e) => (
            e.reference_id === paymentId
            && e.reference_type === WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT
          ),
        ) || null,
      );

      jest.spyOn(paymentService.walletTransactionRepository, 'createLedgerEntry').mockImplementation(async (entry) => {
        const record = {
          id: `tx-${Date.now()}`,
          ...entry,
        };
        createdLedgerEntries.push(record);
        return record;
      });

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(PAYMENT_STATUS.SUCCESS);

      // Verify wallet credit invariant
      expect(Number(currentWallet.available_balance)).toBe(1500.00);
      expect(Number(currentWallet.total_credited)).toBe(1500.00);

      // Verify immutable ledger record
      expect(createdLedgerEntries).toHaveLength(1);
      const ledger = createdLedgerEntries[0];
      expect(ledger.partnerId).toBe(partnerId);
      expect(ledger.walletId).toBe(walletId);
      expect(ledger.transactionType).toBe(WALLET_TRANSACTION_TYPE.SETTLEMENT_PAYMENT);
      expect(ledger.direction).toBe(TRANSACTION_DIRECTION.CREDIT);
      expect(ledger.amount).toBe(500.00);
      expect(ledger.balanceAfter).toBe(1500.00);
      expect(ledger.referenceType).toBe(WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT);
      expect(ledger.referenceId).toBe(paymentId);
      expect(ledger.status).toBe(TRANSACTION_STATUS.COMPLETED);
      expect(ledger.metadata.lateFee).toBe(300.00);
      expect(ledger.metadata.extraKmFee).toBe(200.00);
    });

    it('enforces idempotency: duplicate webhook does not double credit wallet or duplicate ledger', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const settlementAmount = 500.00;

      const payload = {
        data: {
          order: {
            order_id: providerOrderId,
            order_amount: settlementAmount,
            order_currency: 'INR',
          },
          payment: {
            cf_payment_id: 'cf_pay_dup_12a',
            payment_status: 'SUCCESS',
            payment_amount: settlementAmount,
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateSignature(nowSec, rawBody);

      // Payment already SUCCESS
      const alreadySuccessfulPayment = {
        id: paymentId,
        booking_id: bookingId,
        payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        amount: '500.00',
        currency: 'INR',
        status: PAYMENT_STATUS.SUCCESS,
        provider_order_id: providerOrderId,
      };

      const creditWalletSpy = jest.spyOn(paymentService.walletRepository, 'creditWallet');
      const createLedgerSpy = jest.spyOn(paymentService.walletTransactionRepository, 'createLedgerEntry');

      jest.spyOn(paymentRepository, 'isEventProcessed').mockResolvedValue(false);
      jest.spyOn(paymentRepository, 'lockByProviderOrderId').mockResolvedValue(alreadySuccessfulPayment);
      jest.spyOn(paymentRepository, 'withTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.alreadyProcessed).toBe(true);

      // Zero wallet credit calls
      expect(creditWalletSpy).not.toHaveBeenCalled();
      // Zero ledger entries created
      expect(createLedgerSpy).not.toHaveBeenCalled();
    });

    it('enforces idempotency at ledger level if payment was not yet marked success but ledger entry exists', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const settlementAmount = 500.00;

      const payload = {
        data: {
          order: {
            order_id: providerOrderId,
            order_amount: settlementAmount,
            order_currency: 'INR',
          },
          payment: {
            cf_payment_id: 'cf_pay_dup_tx',
            payment_status: 'SUCCESS',
            payment_amount: settlementAmount,
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateSignature(nowSec, rawBody);

      const pendingPayment = {
        id: paymentId,
        booking_id: bookingId,
        payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        amount: '500.00',
        currency: 'INR',
        status: PAYMENT_STATUS.PENDING,
        provider_order_id: providerOrderId,
      };

      jest.spyOn(paymentRepository, 'isEventProcessed').mockResolvedValue(false);
      jest.spyOn(paymentRepository, 'lockByProviderOrderId').mockResolvedValue(pendingPayment);
      jest.spyOn(paymentRepository, 'recordEvent').mockResolvedValue({ id: 'evt-dup-tx' });
      jest.spyOn(paymentRepository, 'updateStatus').mockResolvedValue(pendingPayment);

      jest.spyOn(paymentRepository, 'withTransaction').mockImplementation(async (cb) => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({
            rows: [{ id: bookingId, partner_id: partnerId, booking_number: 'BK-12A-02' }],
          }),
        };
        return cb(mockClient);
      });

      // Existing transaction in ledger
      jest.spyOn(paymentService.walletTransactionRepository, 'findByReference').mockResolvedValue({
        id: 'existing-tx-01',
        reference_id: paymentId,
      });

      const creditWalletSpy = jest.spyOn(paymentService.walletRepository, 'creditWallet');
      const createLedgerSpy = jest.spyOn(paymentService.walletTransactionRepository, 'createLedgerEntry');

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);
      expect(creditWalletSpy).not.toHaveBeenCalled();
      expect(createLedgerSpy).not.toHaveBeenCalled();
    });
  });

  describe('Atomicity & Rollback Guarantees', () => {
    it('rolls back transaction if ledger insertion fails', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const settlementAmount = 500.00;

      const payload = {
        data: {
          order: {
            order_id: providerOrderId,
            order_amount: settlementAmount,
            order_currency: 'INR',
          },
          payment: {
            cf_payment_id: 'cf_pay_rb_1',
            payment_status: 'SUCCESS',
            payment_amount: settlementAmount,
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateSignature(nowSec, rawBody);

      const lockedPayment = {
        id: paymentId,
        booking_id: bookingId,
        payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        amount: '500.00',
        currency: 'INR',
        status: PAYMENT_STATUS.PENDING,
        provider_order_id: providerOrderId,
      };

      jest.spyOn(paymentRepository, 'isEventProcessed').mockResolvedValue(false);
      jest.spyOn(paymentRepository, 'lockByProviderOrderId').mockResolvedValue(lockedPayment);
      jest.spyOn(paymentRepository, 'recordEvent').mockResolvedValue({ id: 'evt-1' });
      jest.spyOn(paymentRepository, 'updateStatus').mockResolvedValue(lockedPayment);

      jest.spyOn(paymentRepository, 'withTransaction').mockImplementation(async (cb) => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({
            rows: [{ id: bookingId, partner_id: partnerId, booking_number: 'BK-12A-RB' }],
          }),
        };
        // Simulated rollback: if cb throws, withTransaction propagates error
        return cb(mockClient);
      });

      jest.spyOn(paymentService.walletTransactionRepository, 'findByReference').mockResolvedValue(null);
      jest.spyOn(paymentService.walletRepository, 'creditWallet').mockResolvedValue({
        wallet: { id: walletId },
        previousAvailable: 1000,
        newAvailable: 1500,
        creditAmount: 500,
      });

      // Force ledger creation failure (e.g. unique constraint or connection crash)
      jest.spyOn(paymentService.walletTransactionRepository, 'createLedgerEntry').mockRejectedValue(
        new Error('Database unique constraint violation: uq_wallet_transactions_settlement_credit'),
      );

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });

    it('rolls back transaction if partner wallet is not found', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const settlementAmount = 500.00;

      const payload = {
        data: {
          order: {
            order_id: providerOrderId,
            order_amount: settlementAmount,
            order_currency: 'INR',
          },
          payment: {
            cf_payment_id: 'cf_pay_rb_2',
            payment_status: 'SUCCESS',
            payment_amount: settlementAmount,
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateSignature(nowSec, rawBody);

      const lockedPayment = {
        id: paymentId,
        booking_id: bookingId,
        payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        amount: '500.00',
        currency: 'INR',
        status: PAYMENT_STATUS.PENDING,
        provider_order_id: providerOrderId,
      };

      jest.spyOn(paymentRepository, 'isEventProcessed').mockResolvedValue(false);
      jest.spyOn(paymentRepository, 'lockByProviderOrderId').mockResolvedValue(lockedPayment);
      jest.spyOn(paymentRepository, 'recordEvent').mockResolvedValue({ id: 'evt-1' });
      jest.spyOn(paymentRepository, 'updateStatus').mockResolvedValue(lockedPayment);

      jest.spyOn(paymentRepository, 'withTransaction').mockImplementation(async (cb) => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({
            rows: [{ id: bookingId, partner_id: partnerId, booking_number: 'BK-12A-NOWAL' }],
          }),
        };
        return cb(mockClient);
      });

      jest.spyOn(paymentService.walletTransactionRepository, 'findByReference').mockResolvedValue(null);
      // Wallet not found
      jest.spyOn(paymentService.walletRepository, 'creditWallet').mockResolvedValue(null);
      const createLedgerSpy = jest.spyOn(paymentService.walletTransactionRepository, 'createLedgerEntry');

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(createLedgerSpy).not.toHaveBeenCalled();
    });
  });

  describe('Non-Settlement Payment Regression', () => {
    it('does NOT trigger settlement wallet credit for normal BOOKING_ADVANCE payment', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const advanceAmount = 2000.00;

      const payload = {
        data: {
          order: {
            order_id: 'cf_adv_order_999',
            order_amount: advanceAmount,
            order_currency: 'INR',
          },
          payment: {
            cf_payment_id: 'cf_pay_adv_999',
            payment_status: 'SUCCESS',
            payment_amount: advanceAmount,
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = generateSignature(nowSec, rawBody);

      const lockedPayment = {
        id: 'pay-advance-01',
        booking_id: bookingId,
        payment_type: PAYMENT_TYPE.BOOKING_ADVANCE, // Advance, NOT settlement!
        amount: '2000.00',
        currency: 'INR',
        status: PAYMENT_STATUS.PENDING,
        provider_order_id: 'cf_adv_order_999',
      };

      jest.spyOn(paymentRepository, 'isEventProcessed').mockResolvedValue(false);
      jest.spyOn(paymentRepository, 'lockByProviderOrderId').mockResolvedValue(lockedPayment);
      jest.spyOn(paymentRepository, 'recordEvent').mockResolvedValue({ id: 'evt-adv' });
      jest.spyOn(paymentRepository, 'updateStatus').mockResolvedValue({
        ...lockedPayment,
        status: PAYMENT_STATUS.SUCCESS,
      });

      jest.spyOn(paymentRepository, 'withTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );

      const creditWalletSpy = jest.spyOn(paymentService.walletRepository, 'creditWallet');
      const createLedgerSpy = jest.spyOn(paymentService.walletTransactionRepository, 'createLedgerEntry');

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set('x-webhook-timestamp', String(nowSec))
        .set('x-webhook-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(PAYMENT_STATUS.SUCCESS);

      // Must NOT credit wallet or create settlement ledger
      expect(creditWalletSpy).not.toHaveBeenCalled();
      expect(createLedgerSpy).not.toHaveBeenCalled();
    });
  });
});
