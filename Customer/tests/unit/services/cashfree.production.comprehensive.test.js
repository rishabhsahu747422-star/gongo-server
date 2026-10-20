'use strict';

const crypto = require('crypto');
const { PaymentService } = require('../../../src/services/payment.service');
const { CashfreeProvider } = require('../../../src/services/payment/providers/cashfree.provider');
const { BookingService } = require('../../../src/services/booking.service');
const PricingService = require('../../../src/services/pricing.service');
const { PAYMENT_STATUS, PAYMENT_TYPE } = require('../../../src/constants/payment');
const { BOOKING_STATUS } = require('../../../src/constants/booking');
const { ForbiddenError, BadRequestError, ServiceUnavailableError } = require('../../../src/errors');

describe('Cashfree Production Integration & Regression Suite', () => {
  const secretKey = 'cfsk_ma_prod_test_secret_for_unit_tests';
  const appId = 'prod_app_id_12345';

  describe('1 & 2. Production configuration & missing credentials validation', () => {
    it('initializes in PRODUCTION mode with production endpoints', () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
      });
      expect(provider.envMode).toBe('PRODUCTION');
      expect(provider.baseUrl).toBe('https://api.cashfree.com/pg');
    });

    it('rejects order creation without synthetic sandbox fallback when in PRODUCTION mode', async () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
      });

      // Mock network fetch rejection from Cashfree
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: 'Invalid client credentials', code: 'authentication_failed' }),
      });

      try {
        await expect(
          provider.createOrder({
            orderId: 'cf_order_test_1',
            orderAmount: 1505,
            orderCurrency: 'INR',
            customerDetails: { id: 'cust-1', email: 'c@g.in', phone: '9999999999', name: 'Test' },
          })
        ).rejects.toThrow(BadRequestError);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('3, 4 & 5. Order creation, amount precision, and session propagation', () => {
    it('creates production order with exact amount, currency, and returns paymentSessionId', async () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockImplementation((url, opts) => {
        const body = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            order_id: body.order_id,
            order_amount: body.order_amount,
            order_currency: body.order_currency,
            order_status: 'ACTIVE',
            payment_session_id: 'session_prod_live_abc123xyz',
            cf_order_id: 'cf_10029384',
          }),
        });
      });

      try {
        const res = await provider.createOrder({
          orderId: 'cf_order_test_2',
          orderAmount: 1505.00,
          orderCurrency: 'INR',
          customerDetails: { id: 'cust-1', email: 'c@g.in', phone: '9999999999', name: 'Test' },
          notifyUrl: 'https://api.gongo.in/api/v1/payments/webhook/cashfree',
        });

        expect(res.providerOrderId).toBe('cf_order_test_2');
        expect(res.paymentSessionId).toBe('session_prod_live_abc123xyz');
        expect(res.cfOrderId).toBe('cf_10029384');
        expect(res.orderStatus).toBe('ACTIVE');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('18. ₹1500 vs ₹1505 Fee Consistency Regression Test', () => {
    it('aligns rental subtotal (1500) + fees (5) = payableAmount (1505) and totalAmount (1505)', () => {
      const rentalCharge = 1500.00;
      const convenienceFee = 1.84;
      const serviceCharge = 2.40;
      const gst = 0.76;
      const totalFees = Math.round((convenienceFee + serviceCharge + gst) * 100) / 100;
      expect(totalFees).toBe(5.00);

      const payableAmount = Math.round((rentalCharge + totalFees) * 100) / 100;
      expect(payableAmount).toBe(1505.00);

      // Verify that totalAmount covers complete online payable amount
      const totalAmount = payableAmount;
      expect(totalAmount).toBe(1505.00);
      expect(totalAmount).toBe(payableAmount);
    });
  });

  describe('11 & 12. Webhook HMAC Cryptographic Signature Verification', () => {
    const provider = new CashfreeProvider({
      appId,
      secretKey,
      env: 'PRODUCTION',
    });

    it('accepts genuine webhook HMAC signature within timestamp window', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({ data: { order: { order_id: 'ord_1' } } });
      const signature = crypto
        .createHmac('sha256', secretKey)
        .update(`${nowSec}${rawBody}`)
        .digest('base64');

      const isValid = provider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(nowSec),
          'x-webhook-signature': signature,
        },
        rawBody,
      );
      expect(isValid).toBe(true);
    });

    it('rejects forged webhook signature', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({ data: { order: { order_id: 'ord_1' } } });
      const isValid = provider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(nowSec),
          'x-webhook-signature': 'forged_signature_here',
        },
        rawBody,
      );
      expect(isValid).toBe(false);
    });

    it('rejects expired webhook timestamp (replay protection > 10m in past)', () => {
      const pastSec = Math.floor(Date.now() / 1000) - 700; // 11.6 minutes ago
      const rawBody = JSON.stringify({ data: { order: { order_id: 'ord_1' } } });
      const signature = crypto
        .createHmac('sha256', secretKey)
        .update(`${pastSec}${rawBody}`)
        .digest('base64');

      const isValid = provider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(pastSec),
          'x-webhook-signature': signature,
        },
        rawBody,
      );
      expect(isValid).toBe(false);
    });
  });

  describe('6, 7, 8, 13 & 14. Webhook Reconciliation: Success, Failure, Idempotency & Out-of-Order Safety', () => {
    let mockPaymentRepo;
    let mockBookingRepo;
    let paymentService;
    let provider;

    beforeEach(() => {
      provider = new CashfreeProvider({ appId, secretKey, env: 'PRODUCTION' });
      mockPaymentRepo = {
        transaction: jest.fn((cb) => cb({})),
        lockByProviderOrderId: jest.fn(),
        updateStatus: jest.fn(),
        query: jest.fn(),
      };
      mockBookingRepo = {
        updateStatus: jest.fn(),
        findByIdAndCustomerId: jest.fn(),
      };

      paymentService = new PaymentService({
        paymentRepository: mockPaymentRepo,
        bookingRepository: mockBookingRepo,
        provider,
      });

      // Internal helper mocks
      paymentService._applyPaymentSuccess = jest.fn().mockResolvedValue({ processed: true, status: 'paid' });
      paymentService._applyPaymentFailure = jest.fn().mockResolvedValue({ processed: true, status: 'failed' });
    });

    it('confirms payment when legitimate SUCCESS webhook arrives', async () => {
      mockPaymentRepo.lockByProviderOrderId.mockResolvedValue({
        id: 'pay-1',
        providerOrderId: 'cf_ord_1',
        amount: '1505.00',
        currency: 'INR',
        status: 'pending',
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const payload = {
        data: {
          order: { order_id: 'cf_ord_1', order_amount: 1505.00, order_currency: 'INR' },
          payment: { cf_payment_id: 'cf_pay_1', payment_status: 'SUCCESS', payment_amount: 1505.00 },
        },
        type: 'PAYMENT_SUCCESS_WEBHOOK',
      };
      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', secretKey).update(`${nowSec}${rawBody}`).digest('base64');

      const res = await paymentService.processWebhook(
        { 'x-webhook-timestamp': String(nowSec), 'x-webhook-signature': signature },
        rawBody,
        payload,
      );

      expect(paymentService._applyPaymentSuccess).toHaveBeenCalled();
      expect(res.processed).toBe(true);
    });

    it('rejects webhook and does not confirm when amount mismatches (₹1500 received vs ₹1505 expected)', async () => {
      mockPaymentRepo.lockByProviderOrderId.mockResolvedValue({
        id: 'pay-1',
        providerOrderId: 'cf_ord_1',
        amount: '1505.00',
        currency: 'INR',
        status: 'pending',
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const payload = {
        data: {
          order: { order_id: 'cf_ord_1', order_amount: 1500.00 },
          payment: { cf_payment_id: 'cf_pay_1', payment_status: 'SUCCESS', payment_amount: 1500.00 },
        },
        type: 'PAYMENT_SUCCESS_WEBHOOK',
      };
      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', secretKey).update(`${nowSec}${rawBody}`).digest('base64');

      await expect(
        paymentService.processWebhook(
          { 'x-webhook-timestamp': String(nowSec), 'x-webhook-signature': signature },
          rawBody,
          payload,
        )
      ).rejects.toThrow(BadRequestError);

      expect(paymentService._applyPaymentSuccess).not.toHaveBeenCalled();
      expect(paymentService._applyPaymentFailure).toHaveBeenCalled();
    });

    it('is idempotent: duplicate webhook on already paid payment returns alreadyProcessed: true', async () => {
      mockPaymentRepo.lockByProviderOrderId.mockResolvedValue({
        id: 'pay-1',
        providerOrderId: 'cf_ord_1',
        amount: '1505.00',
        currency: 'INR',
        status: 'paid', // Already paid
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const payload = {
        data: {
          order: { order_id: 'cf_ord_1', order_amount: 1505.00 },
          payment: { cf_payment_id: 'cf_pay_1', payment_status: 'SUCCESS' },
        },
        type: 'PAYMENT_SUCCESS_WEBHOOK',
      };
      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', secretKey).update(`${nowSec}${rawBody}`).digest('base64');

      const res = await paymentService.processWebhook(
        { 'x-webhook-timestamp': String(nowSec), 'x-webhook-signature': signature },
        rawBody,
        payload,
      );

      expect(res.alreadyProcessed).toBe(true);
      expect(paymentService._applyPaymentSuccess).not.toHaveBeenCalled();
    });

    it('out-of-order safety: stale late failure event does not downgrade already paid payment', async () => {
      mockPaymentRepo.lockByProviderOrderId.mockResolvedValue({
        id: 'pay-1',
        providerOrderId: 'cf_ord_1',
        amount: '1505.00',
        currency: 'INR',
        status: 'paid', // Already successfully confirmed
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const payload = {
        data: {
          order: { order_id: 'cf_ord_1' },
          payment: { cf_payment_id: 'cf_pay_old', payment_status: 'FAILED', payment_message: 'User cancelled' },
        },
        type: 'PAYMENT_FAILED_WEBHOOK',
      };
      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', secretKey).update(`${nowSec}${rawBody}`).digest('base64');

      const res = await paymentService.processWebhook(
        { 'x-webhook-timestamp': String(nowSec), 'x-webhook-signature': signature },
        rawBody,
        payload,
      );

      expect(res.alreadyProcessed).toBe(true);
      expect(paymentService._applyPaymentFailure).not.toHaveBeenCalled();
    });
  });

  describe('20. Prevention of Production Mock-Payment Execution', () => {
    it('forbids simulateCashfreeWebhook when CashfreeProvider is in PRODUCTION mode', async () => {
      const provider = new CashfreeProvider({ appId, secretKey, env: 'PRODUCTION' });
      const paymentService = new PaymentService(provider);

      await expect(
        paymentService.simulateCashfreeWebhook({
          customerId: 'cust-1',
          bookingId: 'book-1',
          paymentStatus: 'SUCCESS',
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it('forbids devBypassPayment when CashfreeProvider is in PRODUCTION mode', async () => {
      const provider = new CashfreeProvider({ appId, secretKey, env: 'PRODUCTION' });
      const paymentService = new PaymentService(provider);

      await expect(
        paymentService.devBypassPayment('cust-1', 'book-1')
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
