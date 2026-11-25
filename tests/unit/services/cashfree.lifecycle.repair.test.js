'use strict';

const request = require('supertest');
const { CashfreeProvider } = require('../../../src/services/payment/providers/cashfree.provider');
const { PaymentService } = require('../../../src/services/payment.service');
const { BadRequestError } = require('../../../src/errors');
const { createApp } = require('../../../src/app');
const app = createApp();

describe('Cashfree Lifecycle Repair & Verification Suite', () => {
  const secretKey = 'cfsk_ma_prod_test_secret_for_repair_tests';
  const appId = 'prod_app_id_test';

  describe('A. Return URL Resolution & Sanitization (Error A Fix)', () => {
    it('substitutes {order_id} in a valid HTTPS return URL', () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
        returnUrl: 'https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return?order_id={order_id}',
      });

      const resolved = provider.resolveReturnUrl('cf_order_abc123');
      expect(resolved).toBe('https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return?order_id=cf_order_abc123');
    });

    it('preserves additional query parameters in the configured return URL', () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
        returnUrl: 'https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return?source=app&order_id={order_id}&env=prod',
      });

      const resolved = provider.resolveReturnUrl('cf_order_xyz789');
      expect(resolved).toBe('https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return?source=app&order_id=cf_order_xyz789&env=prod');
    });

    it('appends order_id query parameter if placeholder is omitted in configured return URL', () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
        returnUrl: 'https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return',
      });

      const resolved = provider.resolveReturnUrl('cf_order_append1');
      expect(resolved).toBe('https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return?order_id=cf_order_append1');
    });

    it('rejects custom scheme gongo:// and falls back to configured HTTPS return URL', () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
        returnUrl: 'https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return?order_id={order_id}',
      });

      const callerOverride = 'gongo://payment/result?order_id=cf_order_malformed';
      const resolved = provider.resolveReturnUrl('cf_order_fallback', callerOverride);
      expect(resolved).toBe('https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return?order_id=cf_order_fallback');
    });

    it('rejects malformed https://gongo:// combination and falls back to configured HTTPS return URL', () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
        returnUrl: 'https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return?order_id={order_id}',
      });

      const callerOverride = 'https://gongo://payment/result?order_id=cf4f25abf67d3a438a_183c4368';
      const resolved = provider.resolveReturnUrl('cf4f25abf67d3a438a_183c4368', callerOverride);
      expect(resolved).toBe('https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return?order_id=cf4f25abf67d3a438a_183c4368');
    });

    it('accepts valid caller-provided HTTPS return URL', () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
        returnUrl: 'https://gongo-server-myqf.onrender.com/api/v1/customer/payments/cashfree/return?order_id={order_id}',
      });

      const callerOverride = 'https://checkout.gongo.in/returns?session_id=123&order_id={order_id}';
      const resolved = provider.resolveReturnUrl('order_custom_1', callerOverride);
      expect(resolved).toBe('https://checkout.gongo.in/returns?session_id=123&order_id=order_custom_1');
    });

    it('throws BadRequestError if neither caller nor configured URL is a valid HTTP/HTTPS URL', () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
        returnUrl: '',
      });

      expect(() => {
        provider.resolveReturnUrl('cf_order_err', 'invalid-non-url');
      }).toThrow(BadRequestError);
    });
  });

  describe('B. Route Registration & Mount Aliases (Error B Fix)', () => {
    const sampleBookingId = 'ec69bfc5-9274-4a48-92e1-c281c7f1d7ef';

    it('POST /api/v1/customer/bookings/:id/decline-payment is registered and protected (returns 401 unauthenticated, NOT 404)', async () => {
      const res = await request(app)
        .post(`/api/v1/customer/bookings/${sampleBookingId}/decline-payment`)
        .send({ reason: 'Checkout abandoned' });

      // If route was missing, res.status would be 404. 401 proves route is mounted and auth middleware executed.
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('AUTH_MISSING_CREDENTIAL');
    });

    it('POST /api/v1/bookings/:id/decline-payment is registered and protected (returns 401 unauthenticated, NOT 404)', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${sampleBookingId}/decline-payment`)
        .send({ reason: 'Checkout abandoned' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('AUTH_MISSING_CREDENTIAL');
    });

    it('GET /api/v1/customer/payments/cashfree/return returns HTML return bridge page', async () => {
      const res = await request(app)
        .get('/api/v1/customer/payments/cashfree/return?order_id=cf_test_ord_1')
        .set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.text).toContain('<!DOCTYPE html>');
      expect(res.text).toContain('GONGO');
      expect(res.text).toContain('gongo://payment/result?order_id=cf_test_ord_1');
    });

    it('GET /api/v1/customer/bookings/:bookingId/payment-status returns HTML return bridge page', async () => {
      const res = await request(app)
        .get(`/api/v1/customer/bookings/${sampleBookingId}/payment-status`)
        .set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.text).toContain('<!DOCTYPE html>');
      expect(res.text).toContain('GONGO');
    });

    it('GET /api/v1/customer/payments/cashfree/return returns 400 when order_id is missing', async () => {
      const res = await request(app)
        .get('/api/v1/customer/payments/cashfree/return')
        .set('Accept', 'application/json');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('order_id');
    });
  });

  describe('C. Double-Charge Prevention in Payment Initiation', () => {
    let mockPaymentRepo;
    let mockBookingRepo;
    let mockDocumentRepo;
    let mockProvider;
    let service;

    beforeEach(() => {
      mockProvider = {
        name: 'cashfree',
        createOrder: jest.fn(),
        getOrderStatus: jest.fn(),
      };
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [{ status: 'PENDING' }] }),
      };
      mockPaymentRepo = {
        findActiveByBookingId: jest.fn(),
        findByProviderOrderId: jest.fn(),
        transaction: jest.fn((cb) => cb(mockClient)),
        lockByProviderOrderId: jest.fn(),
        updateStatus: jest.fn(),
        create: jest.fn(),
        query: jest.fn(),
      };
      mockBookingRepo = {
        findByIdAndCustomerId: jest.fn(),
        updateStatus: jest.fn(),
      };
      mockDocumentRepo = {
        findLatestByUserAndType: jest.fn().mockResolvedValue({ status: 'VERIFIED' }),
      };

      service = new PaymentService({
        paymentRepository: mockPaymentRepo,
        bookingRepository: mockBookingRepo,
        documentRepository: mockDocumentRepo,
        provider: mockProvider,
      });
    });

    it('rejects new payment initiation if existing payment record is already PAID', async () => {
      const customerId = 'cust-123';
      const bookingId = 'ec69bfc5-9274-4a48-92e1-c281c7f1d7ef';

      mockBookingRepo.findByIdAndCustomerId.mockResolvedValue({
        id: bookingId,
        customerId,
        totalAmount: 1505.00,
        status: 'CONFIRMED',
      });

      mockPaymentRepo.findActiveByBookingId.mockResolvedValue({
        id: 'pay-existing-1',
        bookingId,
        providerOrderId: 'cf_ord_already_paid',
        status: 'PAID',
        amount: 1505.00,
      });

      await expect(
        service.initiatePayment(customerId, bookingId)
      ).rejects.toThrow(BadRequestError);

      expect(mockProvider.createOrder).not.toHaveBeenCalled();
    });

    it('reconciles with Cashfree and prevents duplicate charge if existing payment is pending locally but PAID on Cashfree', async () => {
      const customerId = 'cust-123';
      const bookingId = 'ec69bfc5-9274-4a48-92e1-c281c7f1d7ef';

      mockBookingRepo.findByIdAndCustomerId.mockResolvedValue({
        id: bookingId,
        customerId,
        totalAmount: 1505.00,
        status: 'PENDING',
      });

      mockPaymentRepo.findActiveByBookingId.mockResolvedValue({
        id: 'pay-pending-1',
        bookingId,
        providerOrderId: 'cf_ord_paid_remotely',
        status: 'PENDING',
        amount: 1505.00,
      });

      mockProvider.getOrderStatus.mockResolvedValue({
        providerOrderId: 'cf_ord_paid_remotely',
        orderStatus: 'PAID',
        orderAmount: 1505.00,
        paymentId: 'cf_pay_tx_123',
      });

      mockPaymentRepo.lockByProviderOrderId.mockResolvedValue({
        id: 'pay-pending-1',
        bookingId,
        providerOrderId: 'cf_ord_paid_remotely',
        status: 'pending',
        amount: 1505.00,
      });

      await expect(
        service.initiatePayment(customerId, bookingId)
      ).rejects.toThrow(BadRequestError);

      // Verify that provider.createOrder was NOT called (no second charge created)
      expect(mockProvider.createOrder).not.toHaveBeenCalled();
      // Verify that getOrderStatus was called to reconcile with Cashfree
      expect(mockProvider.getOrderStatus).toHaveBeenCalledWith('cf_ord_paid_remotely', {
        bookingId,
        paymentId: 'pay-pending-1',
      });
    });
  });

  describe('D. Cashfree Provider Refund Capabilities', () => {
    it('creates refund via Cashfree PG API', async () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          refund_id: 'ref_1001',
          cf_refund_id: 'cf_ref_555',
          order_id: 'cf_ord_ref_test',
          refund_amount: 500,
          refund_currency: 'INR',
          refund_status: 'SUCCESS',
          refund_note: 'Cancellation refund',
        }),
      });

      try {
        const result = await provider.createRefund({
          orderId: 'cf_ord_ref_test',
          refundAmount: 500,
          refundId: 'ref_1001',
          refundNote: 'Cancellation refund',
        });

        expect(result.providerRefundId).toBe('cf_ref_555');
        expect(result.cfRefundId).toBe('cf_ref_555');
        expect(result.refundId).toBe('ref_1001');
        expect(result.refundAmount).toBe(500);
        expect(result.refundStatus).toBe('SUCCESS');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('queries refund status via Cashfree PG API', async () => {
      const provider = new CashfreeProvider({
        appId,
        secretKey,
        env: 'PRODUCTION',
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          refund_id: 'ref_1001',
          cf_refund_id: 'cf_ref_555',
          order_id: 'cf_ord_ref_test',
          refund_amount: 500,
          refund_status: 'SUCCESS',
        }),
      });

      try {
        const result = await provider.getRefundStatus('cf_ord_ref_test', 'ref_1001');
        expect(result.refundStatus).toBe('SUCCESS');
        expect(result.providerRefundId).toBe('cf_ref_555');
        expect(result.refundId).toBe('ref_1001');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
