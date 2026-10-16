'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const paymentController = require('../../Customer/src/controllers/payment.controller');

describe('GONGO Unified Backend — webhook raw body preservation', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('exposes the exact raw request body to the Customer Cashfree webhook handler', async () => {
    let capturedRawBody;
    jest.spyOn(paymentController, 'handleCashfreeWebhook').mockImplementation((req, res) => {
      capturedRawBody = req.rawBody;
      res.status(200).json({ success: true });
    });

    // Non-canonical spacing: a re-serialized body would not match the signed payload
    const payload = '{"data": {"order": {"order_id": "ord_1"}},  "type":"PAYMENT_SUCCESS_WEBHOOK"}';

    const res = await request(app)
      .post('/api/v1/customer/payments/webhook/cashfree')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', 'sig')
      .set('x-webhook-timestamp', '1700000000')
      .send(payload);

    expect(res.status).toBe(200);
    expect(capturedRawBody).toBe(payload);
  });
});
