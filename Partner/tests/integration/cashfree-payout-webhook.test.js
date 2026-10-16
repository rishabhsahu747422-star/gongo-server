'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const paymentService = require('../../src/services/payment.service');
const cashfreeProvider = require('../../src/providers/cashfree.provider');
const { pool } = require('../../src/db/pool');

describe('Integration: Cashfree Payout Webhook API', () => {
  let app;
  const testSecretKey = 'TEST_CASHFREE_SECRET_KEY_1234567890';
  const originalSecret = cashfreeProvider.secretKey;

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

  it('rejects requests missing webhook authentication headers with 400', async () => {
    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree/payout')
      .send({ some: 'data' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
  });

  it('rejects requests with invalid cryptographic signature with 400', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const body = { data: { transfer_id: 'cf_tr_123' } };

    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree/payout')
      .set('x-webhook-timestamp', String(nowSec))
      .set('x-webhook-signature', 'invalid_signature_base64==')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
  });

  it('handles duplicate/already processed payout events idempotently', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      event: 'TRANSFER_SUCCESS',
      data: {
        transfer_id: 'cf_tr_duplicate',
        reference_id: 'payout-uuid-1',
      },
      event_id: 'evt_dup_123',
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

  it('processes TRANSFER_SUCCESS, marks payout COMPLETED, and notifies partner', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      event: 'TRANSFER_SUCCESS',
      data: {
        transfer_id: 'cf_tr_success_777',
        reference_id: 'payout-uuid-success',
        amount: 2500.00,
      },
      event_id: 'evt_success_777',
    };
    const rawBody = JSON.stringify(payload);
    const signature = generateSignature(nowSec, rawBody);

    const mockPayout = {
      id: 'payout-uuid-success',
      partner_id: 'partner-uuid-1',
      amount: '2500.00',
      status: 'PROCESSING',
      provider_transfer_id: null,
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
    jest.spyOn(paymentService.payoutRepository, 'updateStatus')
      .mockResolvedValue({ ...mockPayout, status: 'COMPLETED' });
    jest.spyOn(paymentService.notificationRepository, 'createNotification')
      .mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree/payout')
      .set('x-webhook-timestamp', String(nowSec))
      .set('x-webhook-signature', signature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.processed).toBe(true);
    expect(res.body.data.status).toBe('COMPLETED');
    expect(paymentService.payoutRepository.updateStatus).toHaveBeenCalledWith(
      'payout-uuid-success',
      expect.objectContaining({
        status: 'COMPLETED',
        providerTransferId: 'cf_tr_success_777',
      }),
      mockClient,
    );
    expect(paymentService.notificationRepository.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        partnerId: 'partner-uuid-1',
        type: 'PAYOUT_COMPLETED',
      }),
    );
  });

  it('processes TRANSFER_FAILED, reverses wallet debit, logs ledger, and notifies partner', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      event: 'TRANSFER_FAILED',
      data: {
        transfer_id: 'cf_tr_fail_888',
        reference_id: 'payout-uuid-failed',
        reason: 'Beneficiary account closed',
      },
      event_id: 'evt_fail_888',
    };
    const rawBody = JSON.stringify(payload);
    const signature = generateSignature(nowSec, rawBody);

    const mockPayout = {
      id: 'payout-uuid-failed',
      partner_id: 'partner-uuid-1',
      amount: '1800.00',
      status: 'PROCESSING',
      provider_transfer_id: null,
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
      wallet: { id: 'wallet-uuid-1' },
      newAvailable: 3800.00,
      reverseAmount: 1800.00,
    });
    jest.spyOn(paymentService.walletTransactionRepository, 'createLedgerEntry').mockResolvedValue({});
    jest.spyOn(paymentService.payoutRepository, 'updateStatus')
      .mockResolvedValue({ ...mockPayout, status: 'FAILED' });
    jest.spyOn(paymentService.notificationRepository, 'createNotification')
      .mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree/payout')
      .set('x-webhook-timestamp', String(nowSec))
      .set('x-webhook-signature', signature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.processed).toBe(true);
    expect(res.body.data.status).toBe('FAILED');
    expect(paymentService.walletRepository.reverseDebitWallet).toHaveBeenCalledWith(
      'partner-uuid-1',
      1800.00,
      mockClient,
    );
    expect(paymentService.walletTransactionRepository.createLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionType: 'PAYOUT_REVERSAL',
        direction: 'CREDIT',
        amount: 1800.00,
        referenceType: 'PAYOUT_REVERSAL',
      }),
      mockClient,
    );
    expect(paymentService.notificationRepository.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        partnerId: 'partner-uuid-1',
        type: 'PAYOUT_FAILED',
      }),
    );
  });

  it('handles unknown payout record gracefully without throwing error', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      event: 'TRANSFER_SUCCESS',
      data: {
        transfer_id: 'cf_unknown_tr',
        reference_id: 'non-existent-payout',
      },
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
    jest.spyOn(paymentService.payoutRepository, 'findByTransferOrReferenceIdForUpdate')
      .mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree/payout')
      .set('x-webhook-timestamp', String(nowSec))
      .set('x-webhook-signature', signature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.processed).toBe(false);
    expect(res.body.data.reason).toBe('PAYOUT_NOT_FOUND');
  });
});
