'use strict';

const crypto = require('crypto');
const PaymentProvider = require('../../../src/services/payment/providers/payment.provider');
const cashfreeProvider = require('../../../src/services/payment/providers/cashfree.provider');

describe('Payment Provider Unit Tests — Phase 10', () => {
  describe('PaymentProvider (Abstract Class)', () => {
    it('1. throws error when createOrder is called directly on base class', async () => {
      const provider = new PaymentProvider();
      await expect(provider.createOrder({})).rejects.toThrow(
        'PaymentProvider.createOrder must be implemented by subclass',
      );
    });

    it('2. throws error when getOrderStatus is called directly on base class', async () => {
      const provider = new PaymentProvider();
      await expect(provider.getOrderStatus('order-1')).rejects.toThrow(
        'PaymentProvider.getOrderStatus must be implemented by subclass',
      );
    });

    it('3. throws error when verifyWebhookSignature is called directly on base class', () => {
      const provider = new PaymentProvider();
      expect(() => provider.verifyWebhookSignature({}, '')).toThrow(
        'PaymentProvider.verifyWebhookSignature must be implemented by subclass',
      );
    });
  });

  describe('CashfreeProvider', () => {
    const testSecret = 'test_secret_key_12345';
    let originalSecret;

    beforeAll(() => {
      originalSecret = cashfreeProvider.secretKey;
      cashfreeProvider.secretKey = testSecret;
    });

    afterAll(() => {
      cashfreeProvider.secretKey = originalSecret;
    });

    describe('createOrder with mock delegate', () => {
      it('4. delegates createOrder to mockDelegate when present', async () => {
        const mockDelegate = {
          createOrder: jest.fn().mockResolvedValue({
            providerOrderId: 'cf_order_123',
            paymentSessionId: 'session_abc',
            orderStatus: 'ACTIVE',
            cfOrderId: '12345',
          }),
        };

        cashfreeProvider.setMockDelegate(mockDelegate);

        const result = await cashfreeProvider.createOrder({
          orderId: 'cf_order_123',
          orderAmount: 1500.00,
          customerDetails: {
            id: 'cust-1',
            email: 'alice@example.com',
            phone: '9876543210',
            name: 'Alice',
          },
        });

        expect(mockDelegate.createOrder).toHaveBeenCalledWith(
          expect.objectContaining({
            orderId: 'cf_order_123',
            orderAmount: 1500.00,
          }),
        );
        expect(result.providerOrderId).toBe('cf_order_123');
        expect(result.paymentSessionId).toBe('session_abc');

        cashfreeProvider.setMockDelegate(null);
      });
    });

    describe('verifyWebhookSignature', () => {
      it('5. validates genuine webhook signature successfully', () => {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const rawBody = JSON.stringify({
          data: {
            order: { order_id: 'order_101', order_amount: 1000.00 },
            payment: { payment_status: 'SUCCESS', cf_payment_id: '123' },
          },
          type: 'PAYMENT_SUCCESS_WEBHOOK',
        });

        const signatureData = `${timestamp}${rawBody}`;
        const signature = crypto
          .createHmac('sha256', testSecret)
          .update(signatureData)
          .digest('base64');

        const headers = {
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': signature,
        };

        const isValid = cashfreeProvider.verifyWebhookSignature(headers, rawBody);
        expect(isValid).toBe(true);
      });

      it('6. rejects tampered webhook payload body', () => {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const originalBody = JSON.stringify({ order_id: 'order_101', amount: 1000 });
        const tamperedBody = JSON.stringify({ order_id: 'order_101', amount: 1 });

        const signatureData = `${timestamp}${originalBody}`;
        const signature = crypto
          .createHmac('sha256', testSecret)
          .update(signatureData)
          .digest('base64');

        const headers = {
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': signature,
        };

        const isValid = cashfreeProvider.verifyWebhookSignature(headers, tamperedBody);
        expect(isValid).toBe(false);
      });

      it('7. rejects forged webhook signature', () => {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const rawBody = JSON.stringify({ order_id: 'order_101' });

        const headers = {
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': 'FORGED_SIGNATURE==',
        };

        const isValid = cashfreeProvider.verifyWebhookSignature(headers, rawBody);
        expect(isValid).toBe(false);
      });

      it('8. rejects webhook with timestamp outside replay window (> 10 mins)', () => {
        // Timestamp 15 minutes in the past
        const oldTimestamp = String(Math.floor(Date.now() / 1000) - 900);
        const rawBody = JSON.stringify({ order_id: 'order_old' });

        const signatureData = `${oldTimestamp}${rawBody}`;
        const signature = crypto
          .createHmac('sha256', testSecret)
          .update(signatureData)
          .digest('base64');

        const headers = {
          'x-webhook-timestamp': oldTimestamp,
          'x-webhook-signature': signature,
        };

        const isValid = cashfreeProvider.verifyWebhookSignature(headers, rawBody);
        expect(isValid).toBe(false);
      });

      it('9. rejects when signature or timestamp headers are missing', () => {
        expect(cashfreeProvider.verifyWebhookSignature({}, '{}')).toBe(false);
        expect(cashfreeProvider.verifyWebhookSignature({ 'x-webhook-timestamp': '123' }, '{}')).toBe(false);
        expect(cashfreeProvider.verifyWebhookSignature({ 'x-webhook-signature': 'abc' }, '{}')).toBe(false);
      });
    });

    describe('getOrderStatus 404 handling', () => {
      const originalFetch = global.fetch;

      afterEach(() => {
        global.fetch = originalFetch;
      });

      it('10. returns NOT_FOUND object without throwing when Cashfree returns HTTP 404', async () => {
        global.fetch = jest.fn().mockResolvedValue({
          ok: false,
          status: 404,
          json: jest.fn().mockResolvedValue({
            message: 'Order Reference Id does not exist',
            code: 'order_not_found',
            type: 'invalid_request_error',
          }),
        });

        const result = await cashfreeProvider.getOrderStatus('cf_55b4eedf13df435b_6980cbc6', {
          bookingId: 'bk-123',
          paymentId: 'pay-456',
        });

        expect(result).toEqual({
          providerOrderId: 'cf_55b4eedf13df435b_6980cbc6',
          orderStatus: 'NOT_FOUND',
          notFound: true,
          httpStatus: 404,
          orderAmount: null,
          orderCurrency: 'INR',
        });
      });

      it('11. suppresses duplicate 404 log spam for the same provider order reference', async () => {
        global.fetch = jest.fn().mockResolvedValue({
          ok: false,
          status: 404,
          json: jest.fn().mockResolvedValue({ message: 'Order Reference Id does not exist' }),
        });

        const orderId = 'cf_repeat_404_test';
        await cashfreeProvider.getOrderStatus(orderId);
        await cashfreeProvider.getOrderStatus(orderId);

        // Second call should return cleanly without throwing and maintain cached entry
        expect(cashfreeProvider._recent404Orders.has(orderId)).toBe(true);
      });
    });
  });
});
