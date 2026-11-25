'use strict';

const paymentService = require('../../../src/services/payment.service');
const {
  PAYMENT_PROVIDER,
  PAYMENT_STATUS,
  PAYMENT_TYPE,
  PAYMENT_ERROR_CODES,
} = require('../../../src/constants/payment');
const { BOOKING_STATUS } = require('../../../src/constants/booking');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require('../../../src/errors');

describe('Post-Rental Settlement Payment Service Unit Tests', () => {
  const customerId = '11111111-1111-4111-8111-111111111111';
  const bookingId = '77777777-7777-4777-8777-777777777777';

  const completedBooking = {
    id: bookingId,
    customerId,
    status: BOOKING_STATUS.COMPLETED,
    pricingSnapshot: { totalAmount: 1500.00 },
  };

  const customerUser = {
    id: customerId,
    name: 'Alice Customer',
    email: 'alice@example.com',
    phone: '9870000001',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Authoritative Settlement Calculation', () => {
    it('calculates total correctly with late fee only', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.paymentRepository, 'findActiveByBookingId')
        .mockResolvedValue(null);
      jest.spyOn(paymentService.bookingRepository, 'findReturnVerificationByBookingId')
        .mockResolvedValue({ late_fee: 150.00, extra_km_fee: 0.00 });
      jest.spyOn(paymentService.userRepository, 'findById')
        .mockResolvedValue(customerUser);

      const mockCreateOrder = jest.spyOn(paymentService.provider, 'createOrder')
        .mockResolvedValue({
          providerOrderId: 'cf_order_settle_1',
          paymentSessionId: 'session_settle_1',
          cfOrderId: 'cf_123',
        });

      const mockCreatePayment = jest.spyOn(paymentService.paymentRepository, 'create')
        .mockResolvedValue({
          id: 'pay-settle-1',
          bookingId,
          customerId,
          amount: 150.00,
          paymentType: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
          status: PAYMENT_STATUS.PENDING,
        });

      const result = await paymentService.initiateSettlementPayment(customerId, bookingId);

      expect(mockCreateOrder).toHaveBeenCalledWith(expect.objectContaining({
        orderAmount: 150.00,
        orderCurrency: 'INR',
      }));
      expect(mockCreatePayment).toHaveBeenCalledWith(expect.objectContaining({
        amount: 150.00,
        paymentType: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        provider: PAYMENT_PROVIDER.CASHFREE,
      }));
      expect(result.payment.amount).toBe(150.00);
      expect(result.isIdempotentReplay).toBe(false);
    });

    it('calculates total correctly with extra KM fee only', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.paymentRepository, 'findActiveByBookingId')
        .mockResolvedValue(null);
      jest.spyOn(paymentService.bookingRepository, 'findReturnVerificationByBookingId')
        .mockResolvedValue({ late_fee: 0.00, extra_km_fee: 250.50 });
      jest.spyOn(paymentService.userRepository, 'findById')
        .mockResolvedValue(customerUser);
      jest.spyOn(paymentService.provider, 'createOrder')
        .mockResolvedValue({
          providerOrderId: 'cf_order_settle_2',
          paymentSessionId: 'session_settle_2',
          cfOrderId: 'cf_124',
        });
      jest.spyOn(paymentService.paymentRepository, 'create')
        .mockImplementation(async (data) => ({ ...data, id: 'pay-settle-2' }));

      const result = await paymentService.initiateSettlementPayment(customerId, bookingId);
      expect(result.payment.amount).toBe(250.50);
    });

    it('calculates total correctly with both late fee and extra KM fee', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.paymentRepository, 'findActiveByBookingId')
        .mockResolvedValue(null);
      jest.spyOn(paymentService.bookingRepository, 'findReturnVerificationByBookingId')
        .mockResolvedValue({ late_fee: 120.40, extra_km_fee: 80.25 });
      jest.spyOn(paymentService.userRepository, 'findById')
        .mockResolvedValue(customerUser);
      jest.spyOn(paymentService.provider, 'createOrder')
        .mockResolvedValue({
          providerOrderId: 'cf_order_settle_3',
          paymentSessionId: 'session_settle_3',
          cfOrderId: 'cf_125',
        });
      jest.spyOn(paymentService.paymentRepository, 'create')
        .mockImplementation(async (data) => ({ ...data, id: 'pay-settle-3' }));

      const result = await paymentService.initiateSettlementPayment(customerId, bookingId);
      expect(result.payment.amount).toBe(200.65);
    });

    it('handles decimal rounding accurately to 2 places', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.paymentRepository, 'findActiveByBookingId')
        .mockResolvedValue(null);
      jest.spyOn(paymentService.bookingRepository, 'findReturnVerificationByBookingId')
        .mockResolvedValue({ late_fee: 10.334, extra_km_fee: 20.666 });
      jest.spyOn(paymentService.userRepository, 'findById')
        .mockResolvedValue(customerUser);
      jest.spyOn(paymentService.provider, 'createOrder')
        .mockResolvedValue({
          providerOrderId: 'cf_order_settle_4',
          paymentSessionId: 'session_settle_4',
          cfOrderId: 'cf_126',
        });
      jest.spyOn(paymentService.paymentRepository, 'create')
        .mockImplementation(async (data) => ({ ...data, id: 'pay-settle-4' }));

      const result = await paymentService.initiateSettlementPayment(customerId, bookingId);
      expect(result.payment.amount).toBe(31.00);
    });

    it('rejects with NO_SETTLEMENT_CHARGES_PAYABLE when amount is zero', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.paymentRepository, 'findActiveByBookingId')
        .mockResolvedValue(null);
      jest.spyOn(paymentService.bookingRepository, 'findReturnVerificationByBookingId')
        .mockResolvedValue({ late_fee: 0, extra_km_fee: 0 });

      await expect(paymentService.initiateSettlementPayment(customerId, bookingId))
        .rejects
        .toThrow(BadRequestError);

      try {
        await paymentService.initiateSettlementPayment(customerId, bookingId);
      } catch (err) {
        expect(err.code).toBe(PAYMENT_ERROR_CODES.NO_SETTLEMENT_CHARGES_PAYABLE);
      }
    });

    it('rejects with NO_SETTLEMENT_CHARGES_PAYABLE when return verification record is missing', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.paymentRepository, 'findActiveByBookingId')
        .mockResolvedValue(null);
      jest.spyOn(paymentService.bookingRepository, 'findReturnVerificationByBookingId')
        .mockResolvedValue(null);

      await expect(paymentService.initiateSettlementPayment(customerId, bookingId))
        .rejects
        .toThrow(BadRequestError);

      try {
        await paymentService.initiateSettlementPayment(customerId, bookingId);
      } catch (err) {
        expect(err.code).toBe(PAYMENT_ERROR_CODES.NO_SETTLEMENT_CHARGES_PAYABLE);
      }
    });
  });

  describe('2. Booking State Validation', () => {
    const invalidStatuses = [
      BOOKING_STATUS.PENDING,
      BOOKING_STATUS.ACCEPTED,
      BOOKING_STATUS.PAYMENT_PENDING,
      BOOKING_STATUS.PAYMENT_COMPLETED,
      BOOKING_STATUS.IN_PROGRESS,
      BOOKING_STATUS.CANCELLED,
    ];

    test.each(invalidStatuses)('rejects when booking status is %s', async (status) => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue({ ...completedBooking, status });

      await expect(paymentService.initiateSettlementPayment(customerId, bookingId))
        .rejects
        .toThrow(BadRequestError);

      try {
        await paymentService.initiateSettlementPayment(customerId, bookingId);
      } catch (err) {
        expect(err.code).toBe(PAYMENT_ERROR_CODES.BOOKING_NOT_COMPLETED);
      }
    });

    it('throws NotFoundError when booking does not belong to customer (IDOR protection)', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(null);

      await expect(paymentService.initiateSettlementPayment(customerId, bookingId))
        .rejects
        .toThrow(NotFoundError);
    });
  });

  describe('3. Idempotency & Reuse Behavior', () => {
    it('throws ConflictError SETTLEMENT_ALREADY_PAID if settlement is already SUCCESS', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.paymentRepository, 'findActiveByBookingId')
        .mockResolvedValue({
          id: 'pay-settle-existing',
          status: PAYMENT_STATUS.SUCCESS,
          amount: 150.00,
          paymentType: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        });

      await expect(paymentService.initiateSettlementPayment(customerId, bookingId))
        .rejects
        .toThrow(ConflictError);

      try {
        await paymentService.initiateSettlementPayment(customerId, bookingId);
      } catch (err) {
        expect(err.code).toBe(PAYMENT_ERROR_CODES.SETTLEMENT_ALREADY_PAID);
      }
    });

    it('safely reuses existing active PENDING settlement payment order', async () => {
      const activePendingPayment = {
        id: 'pay-settle-pending',
        providerOrderId: 'cf_order_active',
        status: PAYMENT_STATUS.PENDING,
        amount: 200.00,
        paymentType: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        metadata: { paymentSessionId: 'session_active' },
      };

      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.paymentRepository, 'findActiveByBookingId')
        .mockResolvedValue(activePendingPayment);

      const result = await paymentService.initiateSettlementPayment(customerId, bookingId);

      expect(result.isIdempotentReplay).toBe(true);
      expect(result.payment.id).toBe('pay-settle-pending');
      expect(result.payment.paymentSessionId).toBe('session_active');
    });
  });

  describe('4. getSettlementDetails API', () => {
    it('returns customer-safe settlement information with UNPAID status when no payment exists', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.bookingRepository, 'findReturnVerificationByBookingId')
        .mockResolvedValue({ late_fee: 100.00, extra_km_fee: 50.00 });
      jest.spyOn(paymentService.paymentRepository, 'findLatestByBookingId')
        .mockResolvedValue(null);

      const details = await paymentService.getSettlementDetails(customerId, bookingId);

      expect(details.bookingId).toBe(bookingId);
      expect(details.bookingStatus).toBe(BOOKING_STATUS.COMPLETED);
      expect(details.lateFee).toBe(100.00);
      expect(details.extraKmFee).toBe(50.00);
      expect(details.totalAmount).toBe(150.00);
      expect(details.paymentStatus).toBe('UNPAID');
    });

    it('returns PAYMENT_PENDING when settlement payment is currently PENDING', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.bookingRepository, 'findReturnVerificationByBookingId')
        .mockResolvedValue({ late_fee: 100.00, extra_km_fee: 50.00 });
      jest.spyOn(paymentService.paymentRepository, 'findLatestByBookingId')
        .mockResolvedValue({ status: PAYMENT_STATUS.PENDING });

      const details = await paymentService.getSettlementDetails(customerId, bookingId);
      expect(details.paymentStatus).toBe('PAYMENT_PENDING');
    });

    it('returns PAID when settlement payment is SUCCESS', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue(completedBooking);
      jest.spyOn(paymentService.bookingRepository, 'findReturnVerificationByBookingId')
        .mockResolvedValue({ late_fee: 100.00, extra_km_fee: 50.00 });
      jest.spyOn(paymentService.paymentRepository, 'findLatestByBookingId')
        .mockResolvedValue({ status: PAYMENT_STATUS.SUCCESS });

      const details = await paymentService.getSettlementDetails(customerId, bookingId);
      expect(details.paymentStatus).toBe('PAID');
    });

    it('rejects getSettlementDetails when booking is not COMPLETED', async () => {
      jest.spyOn(paymentService.bookingRepository, 'findByIdAndCustomerId')
        .mockResolvedValue({ ...completedBooking, status: BOOKING_STATUS.IN_PROGRESS });

      await expect(paymentService.getSettlementDetails(customerId, bookingId))
        .rejects
        .toThrow(BadRequestError);
    });
  });
});
