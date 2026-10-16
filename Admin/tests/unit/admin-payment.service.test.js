'use strict';

const adminPaymentService = require('../../src/services/admin-payment.service');
const adminPaymentRepository = require('../../src/repositories/admin-payment.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const cashfreeProvider = require('../../src/providers/cashfree');
const { BadRequestError, NotFoundError, ConflictError } = require('../../src/errors');

/**
 * Transaction client whose users table contains the authenticated admin (processed_by must
 * resolve to the actual actor — see security/financial-actor). Other queries return no rows.
 */
function actorClient() {
  return {
    query: jest.fn(async (sql, params) => (/FROM users/i.test(sql) ? { rows: [{ id: params[0] }] } : { rows: [] })),
  };
}

describe('Unit: AdminPaymentService', () => {
  const TEST_PAYMENT_ID = 'e1111111-1111-4111-a111-111111111111';
  const TEST_REFUND_ID = 'f1111111-1111-4111-a111-111111111111';
  const TEST_COMMISSION_RULE_ID = 'c1111111-1111-4111-a111-111111111111';

  const MOCK_ADMIN_USER = {
    id: 'a0000001-0000-4000-a000-000000000001',
    role: 'ADMIN',
    email: 'admin@gongo.in',
  };

  const MOCK_AUDIT_META = {
    ipAddress: '192.168.1.100',
    userAgent: 'JestTestAgent',
    requestId: 'req-payment-unit-001',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    cashfreeProvider.resetMockDelegate();
  });

  afterEach(() => {
    cashfreeProvider.resetMockDelegate();
  });

  describe('Validation & Guards', () => {
    it('throws BadRequestError for malformed payment ID', async () => {
      await expect(adminPaymentService.getPaymentById('invalid-uuid')).rejects.toThrow(
        BadRequestError,
      );
    });

    it('throws BadRequestError when startDate > endDate', async () => {
      await expect(
        adminPaymentService.listPayments({
          startDate: '2026-09-10T00:00:00Z',
          endDate: '2026-09-01T00:00:00Z',
        }),
      ).rejects.toThrow(/startDate cannot be after endDate/);
    });

    it('throws BadRequestError when date range exceeds 366 days', async () => {
      await expect(
        adminPaymentService.listPayments({
          startDate: '2025-01-01T00:00:00Z',
          endDate: '2026-02-15T00:00:00Z',
        }),
      ).rejects.toThrow(/Date range cannot exceed 366 days/);
    });

    it('throws NotFoundError when payment record is not found', async () => {
      jest.spyOn(adminPaymentRepository, 'getPaymentById').mockResolvedValue(null);
      await expect(adminPaymentService.getPaymentById(TEST_PAYMENT_ID)).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('Payment Reconciliation with Cashfree', () => {
    it('reconciles PENDING payment to SUCCESS when provider reports PAID', async () => {
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        status: 'PENDING',
        provider_order_id: 'cf_order_999',
        amount: 2500,
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      jest.spyOn(adminPaymentRepository, 'updatePaymentStatus').mockResolvedValue({
        ...mockPayment,
        status: 'SUCCESS',
      });
      jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'action-1' });

      cashfreeProvider.setMockDelegate({
        getOrderStatus: jest.fn().mockResolvedValue({
          providerOrderId: 'cf_order_999',
          orderStatus: 'PAID',
          orderAmount: 2500,
          cfOrderId: 'cf_pg_777',
        }),
      });

      const result = await adminPaymentService.reconcilePayment(
        TEST_PAYMENT_ID,
        MOCK_ADMIN_USER,
        MOCK_AUDIT_META,
      );

      expect(result.reconciled).toBe(true);
      expect(result.currentStatus).toBe('SUCCESS');
      expect(adminPaymentRepository.updatePaymentStatus).toHaveBeenCalled();
    });
  });

  describe('Payment Refund Creation', () => {
    it('rejects refund when payment status is not SUCCESS', async () => {
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        status: 'FAILED',
        amount: 1000,
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);

      await expect(
        adminPaymentService.createPaymentRefund(
          TEST_PAYMENT_ID,
          { amount: 500, reason: 'Valid refund reason' },
          MOCK_ADMIN_USER,
          MOCK_AUDIT_META,
        ),
      ).rejects.toThrow(/Cannot refund payment with status 'FAILED'/);
    });

    it("accepts Customer-recorded 'paid' payments as refundable (passes the status gate)", async () => {
      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue({
        id: TEST_PAYMENT_ID,
        status: 'paid',
        amount: 1000,
      });

      // A later step may still reject (e.g. no stubbed refund totals), but never on status
      await expect(
        adminPaymentService.createPaymentRefund(
          TEST_PAYMENT_ID,
          { amount: 500, reason: 'Valid refund reason' },
          MOCK_ADMIN_USER,
          MOCK_AUDIT_META,
        ),
      ).rejects.not.toThrow(/Cannot refund payment with status/);
    });

    it('rejects refund when amount exceeds remaining refundable balance', async () => {
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        status: 'SUCCESS',
        amount: 1000,
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValue({
        completedRefundAmount: 700,
        pendingRefundAmount: 0,
        totalRefundsCount: 1,
      });

      await expect(
        adminPaymentService.createPaymentRefund(
          TEST_PAYMENT_ID,
          { amount: 500, reason: 'Valid refund reason' },
          MOCK_ADMIN_USER,
          MOCK_AUDIT_META,
        ),
      ).rejects.toThrow(/exceeds remaining refundable amount/);
    });

    it('successfully creates and executes refund via Cashfree', async () => {
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        booking_id: 'b1111111-1111-4111-a111-111111111111',
        customer_id: 'c1111111-1111-4111-a111-111111111111',
        status: 'SUCCESS',
        amount: 2000,
        provider_order_id: 'order_123',
        currency: 'INR',
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValue({
        completedRefundAmount: 0,
        pendingRefundAmount: 0,
        totalRefundsCount: 0,
      });
      jest.spyOn(adminPaymentRepository, 'createRefund').mockResolvedValue({
        id: TEST_REFUND_ID,
        refund_number: 'REF-GG-9999',
        requested_amount: 1000,
        status: 'COMPLETED',
      });
      jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'action-2' });

      cashfreeProvider.setMockDelegate({
        createRefund: jest.fn().mockResolvedValue({
          providerRefundId: 'cf_ref_555',
          refundStatus: 'SUCCESS',
          refundAmount: 1000,
        }),
      });

      const res = await adminPaymentService.createPaymentRefund(
        TEST_PAYMENT_ID,
        { amount: 1000, reason: 'Trip cancellation by customer' },
        MOCK_ADMIN_USER,
        MOCK_AUDIT_META,
      );

      expect(res.idempotentReplay).toBe(false);
      expect(res.refund.id).toBe(TEST_REFUND_ID);
    });
  });

  describe('Refund Approval & Rejection', () => {
    it('approves refund in REQUESTED status and executes gateway refund', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        payment_id: TEST_PAYMENT_ID,
        refund_number: 'REF-GG-0001',
        requested_amount: 500,
        status: 'REQUESTED',
        reason: 'Customer requested cancellation',
      };
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        amount: 1500,
        provider_order_id: 'cf_ord_001',
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValue({
        completedRefundAmount: 0,
        pendingRefundAmount: 500,
        totalRefundsCount: 1,
      });
      jest.spyOn(adminPaymentRepository, 'updateRefundStatus').mockResolvedValue({
        ...mockRefund,
        status: 'COMPLETED',
        refunded_amount: 500,
      });
      jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-3' });

      cashfreeProvider.setMockDelegate({
        createRefund: jest.fn().mockResolvedValue({
          providerRefundId: 'cf_ref_111',
          refundStatus: 'SUCCESS',
          refundAmount: 500,
        }),
      });

      const result = await adminPaymentService.approveRefund(
        TEST_REFUND_ID,
        {},
        MOCK_ADMIN_USER,
        MOCK_AUDIT_META,
      );

      expect(result.status).toBe('COMPLETED');
    });

    it('rejects refund with mandatory reason and updates status to REJECTED', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        status: 'REQUESTED',
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'updateRefundStatus').mockResolvedValue({
        ...mockRefund,
        status: 'REJECTED',
        rejection_reason: 'Violation of cancellation terms',
      });
      jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-4' });

      const result = await adminPaymentService.rejectRefund(
        TEST_REFUND_ID,
        { reason: 'Violation of cancellation terms' },
        MOCK_ADMIN_USER,
        MOCK_AUDIT_META,
      );

      expect(result.status).toBe('REJECTED');
    });

    it('throws ConflictError when attempting to approve already COMPLETED refund', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        status: 'COMPLETED',
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);

      await expect(
        adminPaymentService.approveRefund(TEST_REFUND_ID, {}, MOCK_ADMIN_USER, MOCK_AUDIT_META),
      ).rejects.toThrow(ConflictError);
    });

    it('approves manual refund with valid UTR without calling Cashfree', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        payment_id: TEST_PAYMENT_ID,
        refund_number: 'REF-GG-0002',
        requested_amount: 1200,
        status: 'REQUESTED',
        reason: 'Customer requested cancellation',
      };
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        amount: 2000,
        provider_order_id: 'cf_ord_002',
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValue({
        completedRefundAmount: 0,
        pendingRefundAmount: 1200,
        totalRefundsCount: 1,
      });
      const updateSpy = jest.spyOn(adminPaymentRepository, 'updateRefundStatus').mockResolvedValue({
        ...mockRefund,
        status: 'COMPLETED',
        approved_amount: 1200,
        refunded_amount: 1200,
        utr: 'NEFT1234567890',
        payment_method: 'MANUAL',
      });
      jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-manual' });

      const cfSpy = jest.fn();
      cashfreeProvider.setMockDelegate({ createRefund: cfSpy });

      const result = await adminPaymentService.approveRefund(
        TEST_REFUND_ID,
        {
          refundMethod: 'MANUAL',
          utr: 'NEFT1234567890',
          notes: 'Bank transfer completed',
        },
        MOCK_ADMIN_USER,
        MOCK_AUDIT_META,
      );

      expect(cfSpy).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith(
        expect.anything(),
        TEST_REFUND_ID,
        expect.objectContaining({
          status: 'COMPLETED',
          utr: 'NEFT1234567890',
          paymentMethod: 'MANUAL',
          notes: 'Bank transfer completed',
        }),
      );
      expect(result.status).toBe('COMPLETED');
    });

    it('rejects manual refund when UTR is missing or shorter than 3 characters', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        payment_id: TEST_PAYMENT_ID,
        requested_amount: 1000,
        status: 'REQUESTED',
      };
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        amount: 2000,
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValue({
        completedRefundAmount: 0,
        pendingRefundAmount: 1000,
        totalRefundsCount: 1,
      });

      await expect(
        adminPaymentService.approveRefund(
          TEST_REFUND_ID,
          { refundMethod: 'MANUAL', utr: '' },
          MOCK_ADMIN_USER,
          MOCK_AUDIT_META,
        ),
      ).rejects.toThrow('UTR / transaction reference is mandatory');
    });

    it('rejects approval when approved amount exceeds requested amount', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        payment_id: TEST_PAYMENT_ID,
        requested_amount: 500,
        status: 'REQUESTED',
      };
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        amount: 2000,
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);

      await expect(
        adminPaymentService.approveRefund(
          TEST_REFUND_ID,
          { approvedAmount: 600 },
          MOCK_ADMIN_USER,
          MOCK_AUDIT_META,
        ),
      ).rejects.toThrow(/exceeds requested refundable amount/);
    });

    it('rejects approval when approved amount is 0', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        payment_id: TEST_PAYMENT_ID,
        requested_amount: 500,
        status: 'REQUESTED',
      };
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        amount: 2000,
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);

      await expect(
        adminPaymentService.approveRefund(
          TEST_REFUND_ID,
          { approvedAmount: 0 },
          MOCK_ADMIN_USER,
          MOCK_AUDIT_META,
        ),
      ).rejects.toThrow('Approved amount must be greater than zero');
    });
  });

  describe('Commission Rules', () => {
    it('creates commission rule and records audit trail', async () => {
      const mockRule = {
        id: TEST_COMMISSION_RULE_ID,
        name: 'Standard Category Tier',
        rule_scope: 'category',
        commission_type: 'percentage',
        commission_value: 15.0,
        priority: 15,
      };

      jest.spyOn(adminPaymentRepository, 'createCommissionRule').mockResolvedValue(mockRule);
      jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-5' });

      const rule = await adminPaymentService.createCommissionRule(
        {
          name: 'Standard Category Tier',
          ruleScope: 'category',
          commissionType: 'percentage',
          commissionValue: 15.0,
          priority: 15,
        },
        MOCK_ADMIN_USER,
        MOCK_AUDIT_META,
      );

      expect(rule.name).toBe('Standard Category Tier');
      expect(rule.commission_value).toBe(15.0);
    });

    it('rejects invalid commission rule scope', async () => {
      await expect(
        adminPaymentService.createCommissionRule(
          {
            name: 'Invalid Scope Rule',
            ruleScope: 'unsupported_scope',
            commissionValue: 10,
          },
          MOCK_ADMIN_USER,
          MOCK_AUDIT_META,
        ),
      ).rejects.toThrow(/Invalid ruleScope/);
    });
  });
});
