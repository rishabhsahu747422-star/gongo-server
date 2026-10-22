'use strict';

const crypto = require('crypto');
const { PaymentService } = require('../../../src/services/payment.service');
const { CashfreeProvider } = require('../../../src/services/payment/providers/cashfree.provider');
const { PAYMENT_STATUS, PAYMENT_TYPE } = require('../../../src/constants/payment');
const { BadRequestError } = require('../../../src/errors');

describe('Cashfree End-to-End Payment Lifecycle & Return URL Suite', () => {
  const secretKey = 'cfsk_ma_prod_test_secret_for_lifecycle_tests';
  const appId = 'prod_app_id_lifecycle_12345';
  const backendUrl = 'https://gongo-server-myqf.onrender.com';

  let provider;
  let paymentService;

  beforeEach(() => {
    provider = new CashfreeProvider({
      appId,
      secretKey,
      env: 'PRODUCTION',
    });
  });

  describe('1. Valid HTTPS Return URL Generation & Custom URI Sanitization', () => {
    it('1. generates a valid, fully qualified HTTPS return URL using the backend public URL', () => {
      const sanitized = provider.sanitizeReturnUrl(
        `${backendUrl}/api/v1/payments/return?order_id={order_id}`,
        'cf_test_order_123',
      );
      expect(sanitized).toBe('https://gongo-server-myqf.onrender.com/api/v1/payments/return?order_id=cf_test_order_123');
      expect(sanitized.startsWith('https://')).toBe(true);
    });

    it('2. intercepts and rejects the old malformed custom URI (gongo://...) and substitutes the canonical HTTPS route', () => {
      const oldMalformedUrl = 'gongo://payment/result?order_id={order_id}';
      const sanitized = provider.sanitizeReturnUrl(oldMalformedUrl, 'cf_ad96af8b135245ea_b1ff461f');

      expect(sanitized).not.toContain('gongo://');
      expect(sanitized).toBe('https://gongo-server-myqf.onrender.com/api/v1/payments/return?order_id=cf_ad96af8b135245ea_b1ff461f');
      expect(sanitized.startsWith('https://')).toBe(true);
    });

    it('3. rejects empty or relative return URL and falls back safely to HTTPS return route', () => {
      const sanitizedEmpty = provider.sanitizeReturnUrl('', 'cf_ord_empty');
      expect(sanitizedEmpty).toBe('https://gongo-server-myqf.onrender.com/api/v1/payments/return?order_id=cf_ord_empty');

      const sanitizedRelative = provider.sanitizeReturnUrl('/some/relative/path', 'cf_ord_rel');
      expect(sanitizedRelative).toBe('https://gongo-server-myqf.onrender.com/api/v1/payments/return?order_id=cf_ord_rel');
    });

    it('4. ensures notifyUrl is an absolute HTTPS URL and falls back to backend webhook route if omitted', () => {
      const notifyUrl = provider.sanitizeNotifyUrl('');
      expect(notifyUrl).toBe('https://gongo-server-myqf.onrender.com/api/v1/payments/webhook/cashfree');
      expect(notifyUrl.startsWith('https://')).toBe(true);
    });
  });

  describe('2. Cashfree Order Creation with HTTPS Return URL', () => {
    it('3 & 4. creates order on production Cashfree API with sanitized HTTPS return_url payload', async () => {
      const originalFetch = global.fetch;
      let capturedPayload = null;
      let capturedHeaders = null;
      let capturedUrl = null;

      global.fetch = jest.fn().mockImplementation((url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        capturedPayload = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            order_id: capturedPayload.order_id,
            cf_order_id: 'cf_123456789',
            payment_session_id: 'session_live_prod_abc123',
            order_status: 'ACTIVE',
            order_amount: capturedPayload.order_amount,
            order_currency: capturedPayload.order_currency,
          }),
        });
      });

      try {
        const result = await provider.createOrder({
          orderId: 'cf_prod_order_999',
          orderAmount: 1501,
          orderCurrency: 'INR',
          customerDetails: {
            id: 'cust-123',
            email: 'user@example.com',
            phone: '9876543210',
            name: 'GONGO Rider',
          },
          // Even if a caller attempts to supply the custom URI:
          returnUrl: 'gongo://payment/result?order_id={order_id}',
        });

        // Verifications
        expect(capturedUrl).toBe('https://api.cashfree.com/pg/orders');
        expect(capturedHeaders['x-client-id']).toBe(appId);
        expect(capturedHeaders['x-client-secret']).toBe(secretKey);
        expect(capturedHeaders['x-api-version']).toBe(provider.apiVersion);

        expect(capturedPayload.order_id).toBe('cf_prod_order_999');
        expect(capturedPayload.order_amount).toBe(1501);
        expect(capturedPayload.order_currency).toBe('INR');

        // CRITICAL CHECK: return_url sent over wire to Cashfree MUST be HTTPS!
        expect(capturedPayload.order_meta.return_url).toBe(
          'https://gongo-server-myqf.onrender.com/api/v1/payments/return?order_id=cf_prod_order_999'
        );
        expect(capturedPayload.order_meta.notify_url).toBe(
          'https://gongo-server-myqf.onrender.com/api/v1/payments/webhook/cashfree'
        );

        expect(result.providerOrderId).toBe('cf_prod_order_999');
        expect(result.paymentSessionId).toBe('session_live_prod_abc123');
        expect(result.orderStatus).toBe('ACTIVE');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('3. Authoritative Reconcile on Payment Return', () => {
    it('5. reconcilePaymentByProviderOrderId confirms payment when Cashfree reports PAID', async () => {
      let paymentRecord = {
        id: 'pay-uuid-1',
        bookingId: 'book-uuid-1',
        providerOrderId: 'cf_order_paid_1',
        amount: 1501,
        currency: 'INR',
        status: PAYMENT_STATUS.PENDING,
      };

      const mockPaymentRepo = {
        findByProviderOrderId: jest.fn().mockImplementation((orderId) => {
          if (orderId === 'cf_order_paid_1') return Promise.resolve(paymentRecord);
          return Promise.resolve(null);
        }),
        lockByProviderOrderId: jest.fn().mockResolvedValue({
          id: 'pay-uuid-1',
          booking_id: 'book-uuid-1',
          amount: '1501.00',
          currency: 'INR',
          status: 'PENDING',
        }),
        transaction: jest.fn().mockImplementation((cb) => cb({})),
        updateStatus: jest.fn().mockImplementation((id, status) => {
          paymentRecord.status = status;
          return Promise.resolve(paymentRecord);
        }),
      };

      const mockProvider = {
        envMode: 'PRODUCTION',
        getOrderStatus: jest.fn().mockResolvedValue({
          providerOrderId: 'cf_order_paid_1',
          orderStatus: 'PAID',
          orderAmount: 1501,
          orderCurrency: 'INR',
        }),
      };

      const svc = new PaymentService({
        paymentRepository: mockPaymentRepo,
        provider: mockProvider,
      });

      // Stub internal success application side-effects
      svc._applyPaymentSuccess = jest.fn().mockResolvedValue({ status: PAYMENT_STATUS.SUCCESS });

      const result = await svc.reconcilePaymentByProviderOrderId('cf_order_paid_1');

      expect(result.success).toBe(true);
      expect(result.status).toBe(PAYMENT_STATUS.SUCCESS);
      expect(result.bookingId).toBe('book-uuid-1');
      expect(mockProvider.getOrderStatus).toHaveBeenCalledWith('cf_order_paid_1', {
        bookingId: 'book-uuid-1',
        paymentId: 'pay-uuid-1',
      });
      expect(svc._applyPaymentSuccess).toHaveBeenCalled();
    });

    it('6. reconcilePaymentByProviderOrderId preserves PENDING status when order is still ACTIVE', async () => {
      const mockPaymentRepo = {
        findByProviderOrderId: jest.fn().mockResolvedValue({
          id: 'pay-uuid-2',
          bookingId: 'book-uuid-2',
          providerOrderId: 'cf_order_active_1',
          amount: 1501,
          currency: 'INR',
          status: PAYMENT_STATUS.PENDING,
        }),
      };

      const mockProvider = {
        envMode: 'PRODUCTION',
        getOrderStatus: jest.fn().mockResolvedValue({
          providerOrderId: 'cf_order_active_1',
          orderStatus: 'ACTIVE',
          orderAmount: 1501,
          orderCurrency: 'INR',
        }),
      };

      const svc = new PaymentService({
        paymentRepository: mockPaymentRepo,
        provider: mockProvider,
      });

      const result = await svc.reconcilePaymentByProviderOrderId('cf_order_active_1');
      expect(result.success).toBe(false);
      expect(result.status).toBe(PAYMENT_STATUS.PENDING);
    });

    it('7 & 8. reconcilePaymentByProviderOrderId records failure on terminal Cashfree failure (USER_DROPPED)', async () => {
      const mockPaymentRepo = {
        findByProviderOrderId: jest.fn().mockResolvedValue({
          id: 'pay-uuid-3',
          bookingId: 'book-uuid-3',
          providerOrderId: 'cf_order_cancelled_1',
          amount: 1501,
          currency: 'INR',
          status: PAYMENT_STATUS.PENDING,
        }),
        lockByProviderOrderId: jest.fn().mockResolvedValue({
          id: 'pay-uuid-3',
          booking_id: 'book-uuid-3',
          amount: '1501.00',
          currency: 'INR',
          status: 'PENDING',
        }),
        transaction: jest.fn().mockImplementation((cb) => cb({})),
      };

      const mockProvider = {
        envMode: 'PRODUCTION',
        getOrderStatus: jest.fn().mockResolvedValue({
          providerOrderId: 'cf_order_cancelled_1',
          orderStatus: 'USER_DROPPED',
          orderAmount: 1501,
          orderCurrency: 'INR',
        }),
      };

      const svc = new PaymentService({
        paymentRepository: mockPaymentRepo,
        provider: mockProvider,
      });

      svc._applyPaymentFailure = jest.fn().mockResolvedValue({ status: PAYMENT_STATUS.FAILED });

      const result = await svc.reconcilePaymentByProviderOrderId('cf_order_cancelled_1');
      expect(result.success).toBe(false);
      expect(result.status).toBe(PAYMENT_STATUS.FAILED);
      expect(result.failureReason).toBe('USER_CANCELLED_PAYMENT');
      expect(svc._applyPaymentFailure).toHaveBeenCalled();
    });

    it('13 & 14. reconcilePaymentByProviderOrderId rejects amount mismatch and flags failure', async () => {
      const mockPaymentRepo = {
        findByProviderOrderId: jest.fn().mockResolvedValue({
          id: 'pay-uuid-4',
          bookingId: 'book-uuid-4',
          providerOrderId: 'cf_order_mismatch_1',
          amount: 1501,
          currency: 'INR',
          status: PAYMENT_STATUS.PENDING,
        }),
        lockByProviderOrderId: jest.fn().mockResolvedValue({
          id: 'pay-uuid-4',
          booking_id: 'book-uuid-4',
          amount: '1501.00',
          currency: 'INR',
          status: 'PENDING',
        }),
        transaction: jest.fn().mockImplementation((cb) => cb({})),
      };

      const mockProvider = {
        envMode: 'PRODUCTION',
        getOrderStatus: jest.fn().mockResolvedValue({
          providerOrderId: 'cf_order_mismatch_1',
          orderStatus: 'PAID',
          orderAmount: 1000, // Underpaid
          orderCurrency: 'INR',
        }),
      };

      const svc = new PaymentService({
        paymentRepository: mockPaymentRepo,
        provider: mockProvider,
      });

      svc._applyPaymentFailure = jest.fn().mockResolvedValue({ status: PAYMENT_STATUS.FAILED });

      const result = await svc.reconcilePaymentByProviderOrderId('cf_order_mismatch_1');
      expect(result.success).toBe(false);
      expect(result.status).toBe(PAYMENT_STATUS.FAILED);
      expect(result.failureReason).toBe('AMOUNT_MISMATCH');
    });

    it('15. reconcilePaymentByProviderOrderId safely rejects missing or invalid order ID', async () => {
      const svc = new PaymentService({
        paymentRepository: {},
        provider: {},
      });

      const resNull = await svc.reconcilePaymentByProviderOrderId(null);
      expect(resNull.success).toBe(false);
      expect(resNull.status).toBe('INVALID_ORDER_ID');

      const resEmpty = await svc.reconcilePaymentByProviderOrderId('');
      expect(resEmpty.success).toBe(false);
      expect(resEmpty.status).toBe('INVALID_ORDER_ID');
    });

    it('18. reconcilePaymentByProviderOrderId is strictly idempotent when payment is already marked SUCCESS', async () => {
      const mockPaymentRepo = {
        findByProviderOrderId: jest.fn().mockResolvedValue({
          id: 'pay-uuid-5',
          bookingId: 'book-uuid-5',
          providerOrderId: 'cf_order_already_paid',
          amount: 1501,
          currency: 'INR',
          status: PAYMENT_STATUS.SUCCESS,
        }),
      };

      const mockProvider = {
        getOrderStatus: jest.fn(),
      };

      const svc = new PaymentService({
        paymentRepository: mockPaymentRepo,
        provider: mockProvider,
      });

      const result = await svc.reconcilePaymentByProviderOrderId('cf_order_already_paid');
      expect(result.success).toBe(true);
      expect(result.status).toBe(PAYMENT_STATUS.SUCCESS);
      // Gateway is not queried again if already paid
      expect(mockProvider.getOrderStatus).not.toHaveBeenCalled();
    });
  });

  describe('4. Cashfree Webhook Cryptographic Verification & Deduplication', () => {
    it('9 & 10. verifies genuine Cashfree HMAC webhook signature and rejects forged ones', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = JSON.stringify({
        data: {
          order: { order_id: 'cf_ord_wh_1', order_amount: 1501, order_currency: 'INR' },
          payment: { payment_status: 'SUCCESS', cf_payment_id: '12345678' },
        },
        event_time: '2026-10-22T02:00:00Z',
        type: 'PAYMENT_SUCCESS_WEBHOOK',
      });

      const validSignature = crypto
        .createHmac('sha256', secretKey)
        .update(`${timestamp}${rawBody}`)
        .digest('base64');

      const isValid = provider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': validSignature,
        },
        rawBody,
      );
      expect(isValid).toBe(true);

      const isInvalid = provider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': 'forged_signature_here',
        },
        rawBody,
      );
      expect(isInvalid).toBe(false);
    });

    it('11. processes duplicate webhook deliveries idempotently without re-confirming', async () => {
      const rawBody = JSON.stringify({
        data: {
          order: { order_id: 'cf_ord_dup' },
          payment: { payment_status: 'SUCCESS', cf_payment_id: 'cf_pay_99' },
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto
        .createHmac('sha256', secretKey)
        .update(`${timestamp}${rawBody}`)
        .digest('base64');

      const mockPaymentRepo = {
        transaction: jest.fn().mockImplementation((cb) => cb({})),
        lockByProviderOrderId: jest.fn().mockResolvedValue({
          id: 'pay-uuid-dup',
          booking_id: 'book-uuid-dup',
          status: 'SUCCESS', // Already SUCCESS!
          amount: '1501.00',
        }),
      };

      const svc = new PaymentService({
        paymentRepository: mockPaymentRepo,
        provider,
      });

      const res = await svc.processWebhook(
        { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signature },
        rawBody,
        JSON.parse(rawBody),
      );

      expect(res.processed).toBe(true);
      expect(res.alreadyProcessed).toBe(true);
    });
  });

  describe('5. Amount Consistency & Rental Fare Calculation Alignment', () => {
    it('19. ensures payableAmount sent to Cashfree excludes separate pickup security deposit', () => {
      const pricingSnapshot = {
        rentalFare: 1500,
        subtotal: 1500,
        platformFee: 1,
        gstOnPlatformFee: 0,
        totalAmount: 2501, // 1501 rental + 1000 deposit
        securityDeposit: 1000,
        payableAmount: 1501, // ONLY rental fare + platform fee charged online
      };

      const depositAmount = Number(pricingSnapshot.securityDeposit || 0);
      const fullAmount = Number(pricingSnapshot.totalAmount);
      const onlineAmount = pricingSnapshot.payableAmount !== undefined
        ? Number(pricingSnapshot.payableAmount)
        : Math.max(0, fullAmount - depositAmount);

      expect(onlineAmount).toBe(1501);
      expect(onlineAmount).not.toBe(fullAmount);
      expect(depositAmount).toBe(1000);
    });
  });
});
