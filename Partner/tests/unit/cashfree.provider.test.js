'use strict';

const crypto = require('crypto');
const cashfreeProvider = require('../../src/providers/cashfree.provider');
const { ServiceUnavailableError } = require('../../src/errors');

describe('Unit: CashfreeProvider (PG v2023-08-01)', () => {
  const secretKey = 'TEST_CASHFREE_SECRET_KEY_1234567890';
  const originalSecret = cashfreeProvider.secretKey;

  beforeAll(() => {
    cashfreeProvider.secretKey = secretKey;
  });

  afterAll(() => {
    cashfreeProvider.secretKey = originalSecret;
    cashfreeProvider.setMockDelegate(null);
  });

  afterEach(() => {
    cashfreeProvider.setMockDelegate(null);
  });

  describe('verifyWebhookSignature', () => {
    function generateValidSignature(timestamp, rawBody, key = secretKey) {
      const dataToSign = `${timestamp}${rawBody}`;
      return crypto.createHmac('sha256', key).update(dataToSign).digest('base64');
    }

    it('validates a correct HMAC-SHA256 signature and fresh timestamp', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({
        data: {
          order: { order_id: 'cf_order_123', order_amount: 500 },
          payment: { cf_payment_id: '999111', payment_status: 'SUCCESS' },
        },
      });
      const signature = generateValidSignature(nowSec, rawBody);

      const isValid = cashfreeProvider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(nowSec),
          'x-webhook-signature': signature,
        },
        rawBody,
      );

      expect(isValid).toBe(true);
    });

    it('rejects signature when raw body has been tampered with', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const originalBody = JSON.stringify({ amount: 500 });
      const tamperedBody = JSON.stringify({ amount: 100 });
      const signature = generateValidSignature(nowSec, originalBody);

      const isValid = cashfreeProvider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(nowSec),
          'x-webhook-signature': signature,
        },
        tamperedBody,
      );

      expect(isValid).toBe(false);
    });

    it('rejects signature signed with an invalid secret key', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({ amount: 500 });
      const invalidSignature = generateValidSignature(nowSec, rawBody, 'WRONG_SECRET');

      const isValid = cashfreeProvider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(nowSec),
          'x-webhook-signature': invalidSignature,
        },
        rawBody,
      );

      expect(isValid).toBe(false);
    });

    it('rejects timestamp outside acceptable clock skew window (> 600s in past)', () => {
      const pastSec = Math.floor(Date.now() / 1000) - 700; // 700s ago
      const rawBody = JSON.stringify({ amount: 500 });
      const signature = generateValidSignature(pastSec, rawBody);

      const isValid = cashfreeProvider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(pastSec),
          'x-webhook-signature': signature,
        },
        rawBody,
      );

      expect(isValid).toBe(false);
    });

    it('rejects timestamp outside acceptable clock skew window (> 300s in future)', () => {
      const futureSec = Math.floor(Date.now() / 1000) + 400; // 400s in future
      const rawBody = JSON.stringify({ amount: 500 });
      const signature = generateValidSignature(futureSec, rawBody);

      const isValid = cashfreeProvider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(futureSec),
          'x-webhook-signature': signature,
        },
        rawBody,
      );

      expect(isValid).toBe(false);
    });

    it('returns false if headers or rawBody are missing or non-string', () => {
      expect(cashfreeProvider.verifyWebhookSignature(null, '{}')).toBe(false);
      expect(cashfreeProvider.verifyWebhookSignature({}, null)).toBe(false);
      expect(cashfreeProvider.verifyWebhookSignature({}, {})).toBe(false);
      expect(cashfreeProvider.verifyWebhookSignature({}, '')).toBe(false);
    });
  });

  describe('getOrderStatus with mockDelegate', () => {
    it('delegates to mockDelegate when provided', async () => {
      const mockResult = {
        providerOrderId: 'cf_test_1',
        orderStatus: 'PAID',
        orderAmount: 350.00,
        orderCurrency: 'INR',
      };
      cashfreeProvider.setMockDelegate({
        getOrderStatus: jest.fn().mockResolvedValue(mockResult),
      });

      const res = await cashfreeProvider.getOrderStatus('cf_test_1');
      expect(res).toEqual(mockResult);
    });

    it('handles simulated gateway connection error', async () => {
      cashfreeProvider.setMockDelegate({
        getOrderStatus: jest.fn().mockRejectedValue(new ServiceUnavailableError('Gateway down')),
      });

      await expect(cashfreeProvider.getOrderStatus('cf_down')).rejects.toThrow(ServiceUnavailableError);
    });
  });
});
