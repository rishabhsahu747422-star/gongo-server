'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const paymentRepository = require('../../src/repositories/payment.repository');
const cashfreeProvider = require('../../src/providers/cashfree.provider');
const { PAYMENT_STATUS, PAYMENT_TYPE } = require('../../src/constants/payment');

describe('Integration: Cashfree Webhook API (PG v2023-08-01)', () => {
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
      .post('/api/v1/payments/webhook/cashfree')
      .send({ some: 'data' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
  });

  it('rejects requests with invalid cryptographic signature with 400', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const body = { data: { order: { order_id: 'cf_ord_001' } } };

    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set('x-webhook-timestamp', String(nowSec))
      .set('x-webhook-signature', 'invalid_signature_base64==')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
  });

  it('processes valid webhook, reconciles amount/currency, and updates payment to SUCCESS', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const providerOrderId = 'cf_settle_booking_123';
    const payload = {
      data: {
        order: {
          order_id: providerOrderId,
          order_amount: 450.00,
          order_currency: 'INR',
        },
        payment: {
          cf_payment_id: 'cf_pay_777888',
          payment_status: 'SUCCESS',
          payment_amount: 450.00,
          payment_currency: 'INR',
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = generateSignature(nowSec, rawBody);

    const lockedPayment = {
      id: 'pay-uuid-1',
      booking_id: 'booking-uuid-1',
      payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
      amount: '450.00',
      currency: 'INR',
      status: PAYMENT_STATUS.PENDING,
      provider_order_id: providerOrderId,
    };

    jest.spyOn(paymentRepository, 'isEventProcessed').mockResolvedValue(false);
    jest.spyOn(paymentRepository, 'withTransaction').mockImplementation(async (cb) => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{ partner_id: 'partner-uuid-1', booking_number: 'BK-999' }],
        }),
      };
      return cb(mockClient);
    });
    jest.spyOn(paymentRepository, 'lockByProviderOrderId').mockResolvedValue(lockedPayment);
    jest.spyOn(paymentRepository, 'recordEvent').mockResolvedValue({ id: 'evt-1' });
    jest.spyOn(paymentRepository, 'updateStatus').mockResolvedValue({
      ...lockedPayment,
      status: PAYMENT_STATUS.SUCCESS,
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
    expect(paymentRepository.updateStatus).toHaveBeenCalledWith(
      'pay-uuid-1',
      PAYMENT_STATUS.SUCCESS,
      expect.objectContaining({ providerPaymentId: 'cf_pay_777888' }),
      expect.anything(),
    );
  });

  it('rejects and marks payment FAILED when amount mismatch is detected', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const providerOrderId = 'cf_mismatch_order';
    const payload = {
      data: {
        order: {
          order_id: providerOrderId,
          order_amount: 100.00, // Gateway amount is 100.00
          order_currency: 'INR',
        },
        payment: {
          cf_payment_id: 'cf_pay_tampered',
          payment_status: 'SUCCESS',
          payment_amount: 100.00,
          payment_currency: 'INR',
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = generateSignature(nowSec, rawBody);

    const lockedPayment = {
      id: 'pay-uuid-mismatch',
      booking_id: 'booking-uuid-1',
      payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
      amount: '500.00', // Expected amount is 500.00!
      currency: 'INR',
      status: PAYMENT_STATUS.PENDING,
      provider_order_id: providerOrderId,
    };

    jest.spyOn(paymentRepository, 'isEventProcessed').mockResolvedValue(false);
    jest.spyOn(paymentRepository, 'withTransaction').mockImplementation(async (cb) => {
      const mockClient = { query: jest.fn() };
      return cb(mockClient);
    });
    jest.spyOn(paymentRepository, 'lockByProviderOrderId').mockResolvedValue(lockedPayment);
    jest.spyOn(paymentRepository, 'recordEvent').mockResolvedValue({ id: 'evt-2' });
    jest.spyOn(paymentRepository, 'updateStatus').mockResolvedValue({
      ...lockedPayment,
      status: PAYMENT_STATUS.FAILED,
    });

    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set('x-webhook-timestamp', String(nowSec))
      .set('x-webhook-signature', signature)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
    expect(paymentRepository.updateStatus).toHaveBeenCalledWith(
      'pay-uuid-mismatch',
      PAYMENT_STATUS.FAILED,
      expect.objectContaining({
        metadata: expect.objectContaining({ failureReason: 'AMOUNT_MISMATCH' }),
      }),
      expect.anything(),
    );
  });

  it('safely deduplicates already processed webhook event via payment_events', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      data: {
        order: { order_id: 'cf_dup_order' },
        payment: { cf_payment_id: 'cf_pay_dup', payment_status: 'SUCCESS' },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = generateSignature(nowSec, rawBody);

    jest.spyOn(paymentRepository, 'isEventProcessed').mockResolvedValue(true);

    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set('x-webhook-timestamp', String(nowSec))
      .set('x-webhook-signature', signature)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.duplicate).toBe(true);
    expect(paymentRepository.lockByProviderOrderId).not.toHaveBeenCalled();
  });
});
