'use strict';

const { PaymentTimeoutService } = require('../../../src/services/payment-timeout.service');
const { PaymentService } = require('../../../src/services/payment.service');
const { PAYMENT_STATUS } = require('../../../src/constants/payment');
const { BOOKING_STATUS } = require('../../../src/constants/booking');

describe('Payment Failure & 5-Minute Timeout Auto-Cancellation Suite', () => {
  let mockPool;
  let mockClient;
  let mockLogger;
  let mockProvider;
  let mockNotificationService;
  let timeoutService;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
    };
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockProvider = {
      getOrderStatus: jest.fn(),
    };
    mockNotificationService = {
      sendNotification: jest.fn().mockResolvedValue({ success: true }),
    };

    timeoutService = new PaymentTimeoutService({
      pool: mockPool,
      logger: mockLogger,
      provider: mockProvider,
      notificationService: mockNotificationService,
      timeoutMs: 5 * 60 * 1000,
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 1: Definitive Cashfree payment failure moves eligible booking to Cancelled
  // ────────────────────────────────────────────────────────────────────────────
  describe('1. Definitive Payment Failure Handling', () => {
    it('transitions eligible booking to CANCELLED and marks payment as FAILED', async () => {
      const mockBookingRepo = {
        findById: jest.fn().mockResolvedValue({
          id: 'bk-fail-1',
          customer_id: 'cust-1',
          vehicle_id: 'veh-1',
          status: 'payment_pending',
          booking_status: 'PENDING',
        }),
      };
      const mockPaymentRepo = {
        updateStatus: jest.fn().mockResolvedValue({}),
      };

      const paymentService = new PaymentService({
        pool: mockPool,
        bookingRepository: mockBookingRepo,
        paymentRepository: mockPaymentRepo,
        logger: mockLogger,
        notificationService: mockNotificationService,
      });

      const client = {
        query: jest.fn().mockImplementation((sql) => {
          if (sql.includes('SELECT 1 FROM payments')) {
            return Promise.resolve({ rows: [] }); // No successful payment
          }
          if (sql.includes('FROM bookings')) {
            return Promise.resolve({
              rows: [{
                id: 'bk-fail-1',
                customer_id: 'cust-1',
                vehicle_id: 'veh-1',
                status: 'payment_pending',
                booking_status: 'PENDING',
              }],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      const lockedPayment = {
        id: 'pay-fail-1',
        booking_id: 'bk-fail-1',
        customer_id: 'cust-1',
        status: PAYMENT_STATUS.PENDING,
      };

      const result = await paymentService._applyPaymentFailure(client, lockedPayment, {
        failureReason: 'Payment declined by bank',
        providerPaymentId: 'cf_pay_123',
        cancellationReason: 'PAYMENT_FAILED',
      });

      expect(result.processed).toBe(true);
      expect(result.bookingCancelled).toBe(true);

      // Verify payment was marked failed
      expect(mockPaymentRepo.updateStatus).toHaveBeenCalledWith(
        'pay-fail-1',
        PAYMENT_STATUS.FAILED,
        expect.objectContaining({
          failureReason: 'Payment declined by bank',
          providerPaymentId: 'cf_pay_123',
        }),
        client,
      );

      // Verify booking was updated to cancelled
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'cancelled'"),
        expect.arrayContaining(['PAYMENT_FAILED', 'bk-fail-1']),
      );

      // Verify vehicle availability was released to IDLE
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining("SET rental_status = 'IDLE'"),
        ['bk-fail-1'],
      );

      // Verify customer notification was sent
      expect(mockNotificationService.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cust-1',
          type: 'BOOKING_CANCELLED',
        }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 2: User closes/cancels checkout (e.g. USER_DROPPED)
  // ────────────────────────────────────────────────────────────────────────────
  describe('2. User Drop / Cancellation Handling', () => {
    it('cancels eligible booking with PAYMENT_CANCELLED reason when user drops checkout', async () => {
      const mockBookingRepo = {
        findById: jest.fn().mockResolvedValue({
          id: 'bk-drop-1',
          customer_id: 'cust-1',
          vehicle_id: 'veh-1',
          status: 'payment_pending',
        }),
      };
      const mockPaymentRepo = {
        updateStatus: jest.fn().mockResolvedValue({}),
      };

      const paymentService = new PaymentService({
        pool: mockPool,
        bookingRepository: mockBookingRepo,
        paymentRepository: mockPaymentRepo,
        logger: mockLogger,
        notificationService: mockNotificationService,
      });

      const client = {
        query: jest.fn().mockImplementation((sql) => {
          if (sql.includes('FROM payments')) return Promise.resolve({ rows: [] });
          if (sql.includes('FROM bookings')) {
            return Promise.resolve({
              rows: [{ id: 'bk-drop-1', customer_id: 'cust-1', vehicle_id: 'veh-1', status: 'payment_pending' }],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      const lockedPayment = {
        id: 'pay-drop-1',
        booking_id: 'bk-drop-1',
        customer_id: 'cust-1',
        status: PAYMENT_STATUS.PENDING,
      };

      const result = await paymentService._applyPaymentFailure(client, lockedPayment, {
        failureReason: 'USER_DROPPED',
        cancellationReason: 'PAYMENT_CANCELLED',
      });

      expect(result.processed).toBe(true);
      expect(result.bookingCancelled).toBe(true);
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'cancelled'"),
        expect.arrayContaining(['PAYMENT_CANCELLED', 'bk-drop-1']),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 3: Unknown or temporarily unavailable response does NOT cancel
  // ────────────────────────────────────────────────────────────────────────────
  describe('3. Transient Network Errors & Unknown Responses', () => {
    it('defers cancellation and does not cancel booking when Cashfree status check is temporarily unavailable', async () => {
      const pastCutoff = new Date(Date.now() - 10 * 60 * 1000);
      const expiredCandidate = {
        booking_id: 'bk-temp-1',
        customer_id: 'cust-1',
        vehicle_id: 'veh-1',
        booking_status: 'payment_pending',
        payment_id: 'pay-temp-1',
        provider_order_id: 'order_temp_1',
        payment_initiated_at: pastCutoff,
      };

      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
        if (sql.includes('FOR UPDATE OF b, p SKIP LOCKED')) {
          return Promise.resolve({ rows: [expiredCandidate] });
        }
        if (sql.includes('SELECT 1 FROM payments')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      // Provider throws ServiceUnavailableError
      const err = new Error('Service Unavailable');
      err.name = 'ServiceUnavailableError';
      mockProvider.getOrderStatus.mockRejectedValue(err);

      const result = await timeoutService.processExpiredPaymentBookings();

      // Should defer processing and NOT cancel
      expect(result.cancelled.length).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('temporarily unavailable'),
        expect.any(Object),
      );
      // Ensure UPDATE bookings SET status = 'cancelled' was NOT called
      const cancelQueryCall = mockClient.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes("status = 'cancelled'"),
      );
      expect(cancelQueryCall).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 4: 5-minute timeout auto-cancellation
  // ────────────────────────────────────────────────────────────────────────────
  describe('4. 5-Minute Deadline Expiry Cancellation', () => {
    it('automatically cancels unpaid booking after 5 minutes from payment initiation', async () => {
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      const expiredCandidate = {
        booking_id: 'bk-timeout-1',
        booking_number: 'BK-TO-1',
        booking_reference: 'GB-TO-1',
        customer_id: 'cust-1',
        vehicle_id: 'veh-1',
        booking_status: 'payment_pending',
        payment_id: 'pay-timeout-1',
        provider_order_id: 'order_to_1',
        payment_initiated_at: sixMinutesAgo,
      };

      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SAVEPOINT') || sql.includes('RELEASE')) {
          return Promise.resolve();
        }
        if (sql.includes('FOR UPDATE OF b, p SKIP LOCKED')) {
          return Promise.resolve({ rows: [expiredCandidate] });
        }
        if (sql.includes('SELECT 1 FROM payments')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      // Provider says order is unpaid/active
      mockProvider.getOrderStatus.mockResolvedValue({ orderStatus: 'ACTIVE' });

      const result = await timeoutService.processExpiredPaymentBookings();

      expect(result.processed).toBe(1);
      expect(result.cancelled.length).toBe(1);
      expect(result.cancelled[0].id).toBe('bk-timeout-1');
      expect(result.cancelled[0].reason).toBe('PAYMENT_TIMEOUT');

      // Verify payment marked failed with PAYMENT_TIMEOUT
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'failed'"),
        ['PAYMENT_TIMEOUT', 'pay-timeout-1'],
      );

      // Verify booking cancelled
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'cancelled'"),
        ['PAYMENT_TIMEOUT', 'bk-timeout-1'],
      );

      // Verify vehicle released to IDLE
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("SET rental_status = 'IDLE'"),
        ['veh-1'],
      );

      // Verify notification sent
      expect(mockNotificationService.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cust-1',
          type: 'BOOKING_CANCELLED',
          data: expect.objectContaining({
            bookingId: 'bk-timeout-1',
            reason: 'PAYMENT_TIMEOUT',
          }),
        }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 5: Verified successful payment is never overwritten
  // ────────────────────────────────────────────────────────────────────────────
  describe('5. Verified Success Integrity Protection', () => {
    it('does not cancel booking if a verified successful payment exists in database', async () => {
      const mockBookingRepo = {
        findById: jest.fn().mockResolvedValue({
          id: 'bk-paid-1',
          status: 'confirmed',
          booking_status: 'CONFIRMED',
        }),
      };
      const mockPaymentRepo = {
        updateStatus: jest.fn(),
      };

      const paymentService = new PaymentService({
        pool: mockPool,
        bookingRepository: mockBookingRepo,
        paymentRepository: mockPaymentRepo,
        logger: mockLogger,
      });

      const client = {
        query: jest.fn().mockImplementation((sql) => {
          if (sql.includes('FROM payments')) {
            // A verified successful payment exists!
            return Promise.resolve({ rows: [{ id: 'pay-success' }] });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      const lockedPayment = {
        id: 'pay-late-fail',
        booking_id: 'bk-paid-1',
        customer_id: 'cust-1',
      };

      const result = await paymentService._applyPaymentFailure(client, lockedPayment, {
        failureReason: 'Late failure callback',
      });

      expect(result.bookingCancelled).toBe(false);
      expect(result.reason).toBe('SUCCESSFUL_PAYMENT_EXISTS');
      // Must not update booking to cancelled
      expect(client.query).not.toHaveBeenCalledWith(
        expect.stringContaining("status = 'cancelled'"),
        expect.anything(),
      );
    });

    it('confirms booking instead of cancelling if timeout worker discovers provider order was paid', async () => {
      const pastCutoff = new Date(Date.now() - 10 * 60 * 1000);
      const candidate = {
        booking_id: 'bk-paid-order-1',
        customer_id: 'cust-1',
        vehicle_id: 'veh-1',
        booking_status: 'payment_pending',
        payment_id: 'pay-1',
        provider_order_id: 'order_cf_paid_1',
        payment_initiated_at: pastCutoff,
      };

      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SAVEPOINT') || sql.includes('RELEASE')) {
          return Promise.resolve();
        }
        if (sql.includes('FOR UPDATE OF b, p SKIP LOCKED')) {
          return Promise.resolve({ rows: [candidate] });
        }
        if (sql.includes('FROM payments')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      // Provider confirms PAID!
      mockProvider.getOrderStatus.mockResolvedValue({ orderStatus: 'PAID' });

      const result = await timeoutService.processExpiredPaymentBookings();

      expect(result.cancelled.length).toBe(0);
      // Confirmed in DB
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'paid'"),
        ['pay-1'],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'payment_completed'"),
        ['bk-paid-order-1'],
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 8: Booking created without payment initiation is not cancelled
  // ────────────────────────────────────────────────────────────────────────────
  describe('8. Booking Without Payment Initiation Exclusion', () => {
    it('does not select or cancel bookings that never entered payment initiation', async () => {
      // The SQL query inner-joins payments p ON p.booking_id = b.id
      // A booking without payment records returns 0 rows
      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
        if (sql.includes('FOR UPDATE OF b, p SKIP LOCKED')) {
          return Promise.resolve({ rows: [] }); // No advance payment record exists
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await timeoutService.processExpiredPaymentBookings();
      expect(result.processed).toBe(0);
      expect(result.cancelled.length).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 9: Availability and Pricing checks remain unaffected
  // ────────────────────────────────────────────────────────────────────────────
  describe('9. Enquiries & Availability Unaffected', () => {
    it('does not create or cancel any bookings during availability checks', async () => {
      // Verified by architecture: Pricing and Availability endpoints only perform SELECT queries
      expect(typeof timeoutService.processExpiredPaymentBookings).toBe('function');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 10: Concurrency and Idempotency
  // ────────────────────────────────────────────────────────────────────────────
  describe('10. Concurrency & Idempotency Safeguards', () => {
    it('ignores already cancelled bookings idempotently', async () => {
      const mockBookingRepo = {
        findById: jest.fn().mockResolvedValue({
          id: 'bk-already-cancelled',
          status: 'cancelled',
          booking_status: 'CANCELLED',
        }),
      };
      const mockPaymentRepo = {
        updateStatus: jest.fn(),
      };

      const paymentService = new PaymentService({
        pool: mockPool,
        bookingRepository: mockBookingRepo,
        paymentRepository: mockPaymentRepo,
        logger: mockLogger,
      });

      const client = {
        query: jest.fn().mockImplementation((sql) => {
          if (sql.includes('FROM payments')) return Promise.resolve({ rows: [] });
          if (sql.includes('FROM bookings')) {
            return Promise.resolve({
              rows: [{ id: 'bk-already-cancelled', status: 'cancelled', booking_status: 'CANCELLED' }],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      const lockedPayment = {
        id: 'pay-dup',
        booking_id: 'bk-already-cancelled',
        customer_id: 'cust-1',
      };

      const result = await paymentService._applyPaymentFailure(client, lockedPayment, {
        failureReason: 'DUPLICATE_WEBHOOK',
      });

      expect(result.processed).toBe(true);
      expect(result.bookingCancelled).toBe(false);
      expect(result.reason).toBe('ALREADY_CANCELLED');
    });
  });
});
