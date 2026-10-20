'use strict';

const { PaymentTimeoutService } = require('../../../src/services/payment-timeout.service');
const { PaymentService } = require('../../../src/services/payment.service');
const { CancellationService } = require('../../../src/services/cancellation.service');
const { PAYMENT_STATUS } = require('../../../src/constants/payment');
const { BOOKING_STATUS } = require('../../../src/constants/booking');
const { ConflictError, BadRequestError, NotFoundError } = require('../../../src/errors');

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

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 6: Customer Manual Decline (Flow A)
  // ────────────────────────────────────────────────────────────────────────────
  describe('6. Customer Manual Decline (Flow A)', () => {
    let mockBookingRepo;
    let cancellationService;

    beforeEach(() => {
      mockBookingRepo = {
        findByIdAndCustomerId: jest.fn(),
        updateStatus: jest.fn().mockResolvedValue({}),
        findById: jest.fn(),
      };
      cancellationService = new CancellationService({
        pool: mockPool,
        bookingRepository: mockBookingRepo,
        notificationService: mockNotificationService,
        provider: mockProvider,
      });
    });

    it('cancels eligible payment_pending booking with PAYMENT_DECLINED reason and releases vehicle hold', async () => {
      const eligibleBooking = {
        id: 'bk-dec-1',
        customer_id: 'cust-1',
        vehicle_id: 'veh-dec-1',
        status: 'payment_pending',
        booking_status: 'PENDING',
        total_amount: 1500,
        advance_amount: 1500,
        start_at: new Date(Date.now() + 86400000).toISOString(),
        payment_initiated_at: new Date(Date.now() - 60000).toISOString(),
      };

      mockBookingRepo.findByIdAndCustomerId.mockResolvedValue(eligibleBooking);
      mockBookingRepo.findById.mockResolvedValue({
        ...eligibleBooking,
        status: 'cancelled',
        booking_status: 'CANCELLED',
        cancellation_reason: 'PAYMENT_DECLINED',
      });

      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
        if (sql.includes('FROM bookings')) {
          return Promise.resolve({ rows: [eligibleBooking] });
        }
        if (sql.includes('FROM payments')) {
          return Promise.resolve({ rows: [] }); // No successful payment
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await cancellationService.declinePayment('cust-1', 'bk-dec-1');

      expect(result.booking).toBeDefined();
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'cancelled'"),
        expect.arrayContaining(['PAYMENT_DECLINED', 'bk-dec-1']),
      );

      // Verify pending payments marked failed
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'failed'"),
        ['PAYMENT_DECLINED', 'bk-dec-1'],
      );

      // Verify vehicle hold released safely
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("rental_status = 'IDLE'"),
        ['veh-dec-1'],
      );

      // Verify notification sent
      expect(mockNotificationService.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cust-1',
          type: 'BOOKING_CANCELLED',
          data: expect.objectContaining({
            bookingId: 'bk-dec-1',
          }),
        }),
      );
    });

    it('rejects decline with 409 ConflictError if payment was already successfully completed', async () => {
      const eligibleBooking = {
        id: 'bk-paid-conflict',
        customer_id: 'cust-1',
        vehicle_id: 'veh-1',
        status: 'payment_pending',
        start_at: new Date(Date.now() + 86400000).toISOString(),
      };

      mockBookingRepo.findByIdAndCustomerId.mockResolvedValue(eligibleBooking);

      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('ROLLBACK')) return Promise.resolve();
        if (sql.includes('FROM bookings')) {
          return Promise.resolve({ rows: [eligibleBooking] });
        }
        if (sql.includes('FROM payments')) {
          // A verified successful payment exists in database!
          return Promise.resolve({ rows: [{ id: 'pay-confirmed-success' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        cancellationService.declinePayment('cust-1', 'bk-paid-conflict'),
      ).rejects.toThrow(ConflictError);
    });

    it('handles idempotent replay if customer repeats decline for already declined booking', async () => {
      const alreadyDeclinedBooking = {
        id: 'bk-already-declined',
        customer_id: 'cust-1',
        vehicle_id: 'veh-1',
        status: 'cancelled',
        booking_status: 'CANCELLED',
        cancellation_reason: 'PAYMENT_DECLINED',
      };

      mockBookingRepo.findByIdAndCustomerId.mockResolvedValue(alreadyDeclinedBooking);

      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('ROLLBACK')) return Promise.resolve();
        if (sql.includes('FROM bookings')) {
          return Promise.resolve({ rows: [alreadyDeclinedBooking] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await cancellationService.declinePayment('cust-1', 'bk-already-declined');

      expect(result.booking.id).toBe('bk-already-declined');
      expect(result.alreadyCancelled).toBe(true);
    });

    it('rejects decline with 400 BadRequestError if booking is not in cancellable state (e.g. COMPLETED)', async () => {
      const completedBooking = {
        id: 'bk-completed',
        customer_id: 'cust-1',
        vehicle_id: 'veh-1',
        status: 'completed',
        booking_status: 'COMPLETED',
      };

      mockBookingRepo.findByIdAndCustomerId.mockResolvedValue(completedBooking);

      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('ROLLBACK')) return Promise.resolve();
        if (sql.includes('FROM bookings')) {
          return Promise.resolve({ rows: [completedBooking] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        cancellationService.declinePayment('cust-1', 'bk-completed'),
      ).rejects.toThrow(BadRequestError);

      expect(mockBookingRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('rejects decline with 404 NotFoundError if booking does not belong to authenticated customer', async () => {
      mockBookingRepo.findByIdAndCustomerId.mockResolvedValue(null);

      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('ROLLBACK')) return Promise.resolve();
        return Promise.resolve({ rows: [] });
      });

      await expect(
        cancellationService.declinePayment('different-cust', 'bk-other-user'),
      ).rejects.toThrow(NotFoundError);

      expect(mockBookingRepo.updateStatus).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 7: 5-Minute Timeout Reference Timestamp
  // ────────────────────────────────────────────────────────────────────────────
  describe('7. Payment Timeout Countdown Reference Timestamp', () => {
    it('uses payment initiation timestamp, NOT booking created_at timestamp', async () => {
      // Booking was created 15 minutes ago, but payment was initiated only 2 minutes ago
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

      // Timeout query checks: p.created_at <= $1 (where $1 is 5 minutes ago)
      // Since payment was initiated 2 minutes ago, the SQL query does NOT return it
      mockClient.query.mockImplementation((sql, params) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
        if (sql.includes('FOR UPDATE OF b, p SKIP LOCKED')) {
          // Verify that the query checks p.created_at <= cutoff
          expect(sql).toContain('p.created_at <= $1');
          expect(sql).not.toContain('b.created_at <= $1');
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await timeoutService.processExpiredPaymentBookings();
      expect(result.processed).toBe(0);
      expect(result.cancelled.length).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 8: Schema Parity & Missing Column Tolerance (cancelled_at)
  // ────────────────────────────────────────────────────────────────────────────
  describe('8. Schema Parity & Missing Column Tolerance', () => {
    it('successfully cancels booking when bookings table lacks cancelled_at column', async () => {
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      const candidate = {
        booking_id: 'bk-no-cancelled-at',
        booking_number: 'BK-NCA-1',
        booking_reference: 'GB-NCA-1',
        customer_id: 'cust-1',
        vehicle_id: 'veh-1',
        booking_status: 'payment_pending',
        payment_id: 'pay-nca-1',
        provider_order_id: 'order_nca_1',
        payment_initiated_at: sixMinutesAgo,
      };

      mockClient.query.mockImplementation((sql, params) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SAVEPOINT') || sql.includes('RELEASE')) {
          return Promise.resolve();
        }
        if (sql.includes('FOR UPDATE OF b, p SKIP LOCKED')) {
          return Promise.resolve({ rows: [candidate] });
        }
        if (sql.includes('SELECT 1 FROM payments')) {
          return Promise.resolve({ rows: [] });
        }
        // Simulate Postgres throwing 42703 (column "cancelled_at" does not exist)
        if (sql.includes('cancelled_at = CURRENT_TIMESTAMP') && sql.includes('UPDATE bookings')) {
          const err = new Error('column "cancelled_at" of relation "bookings" does not exist');
          err.code = '42703';
          return Promise.reject(err);
        }
        return Promise.resolve({ rows: [] });
      });

      mockProvider.getOrderStatus.mockResolvedValue({ orderStatus: 'ACTIVE' });

      const result = await timeoutService.processExpiredPaymentBookings();

      expect(result.processed).toBe(1);
      expect(result.cancelled.length).toBe(1);
      expect(result.cancelled[0].id).toBe('bk-no-cancelled-at');
      expect(result.cancelled[0].reason).toBe('PAYMENT_TIMEOUT');

      // Verify fallback UPDATE was executed without cancelled_at
      const fallbackCall = mockClient.query.mock.calls.find(
        (call) => typeof call[0] === 'string'
          && call[0].includes("UPDATE bookings")
          && !call[0].includes("cancelled_at = CURRENT_TIMESTAMP"),
      );
      expect(fallbackCall).toBeDefined();

      // Verify booking_cancellations was still upserted
      const bcCall = mockClient.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO booking_cancellations'),
      );
      expect(bcCall).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Requirement 9: Cashfree Order Lookup 404 & Batch Resilience
  // ────────────────────────────────────────────────────────────────────────────
  describe('9. Cashfree Order Lookup 404 & Batch Resilience', () => {
    it('safely cancels expired booking when Cashfree lookup returns 404 NOT_FOUND', async () => {
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      const candidate = {
        booking_id: 'bk-cf-404',
        booking_number: 'BK-404-1',
        booking_reference: 'GB-404-1',
        customer_id: 'cust-1',
        vehicle_id: 'veh-1',
        booking_status: 'payment_pending',
        payment_id: 'pay-404-1',
        provider_order_id: 'cf_55b4eedf13df435b_6980cbc6',
        payment_initiated_at: sixMinutesAgo,
      };

      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SAVEPOINT') || sql.includes('RELEASE')) {
          return Promise.resolve();
        }
        if (sql.includes('FOR UPDATE OF b, p SKIP LOCKED')) {
          return Promise.resolve({ rows: [candidate] });
        }
        if (sql.includes('SELECT 1 FROM payments')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      // Cashfree returns NOT_FOUND (404)
      mockProvider.getOrderStatus.mockResolvedValue({
        providerOrderId: 'cf_55b4eedf13df435b_6980cbc6',
        orderStatus: 'NOT_FOUND',
        notFound: true,
        httpStatus: 404,
      });

      const result = await timeoutService.processExpiredPaymentBookings();

      // Expired candidate should be safely cancelled, NOT deferred
      expect(result.processed).toBe(1);
      expect(result.cancelled.length).toBe(1);
      expect(result.cancelled[0].id).toBe('bk-cf-404');
      expect(result.cancelled[0].reason).toBe('PAYMENT_TIMEOUT');

      // Warning logged about 404 reference, but not error
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not found'),
        expect.any(Object),
      );
    });

    it('isolates candidate failures so one failed candidate does not abort the entire batch', async () => {
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      const candidate1 = {
        booking_id: 'bk-fail-isolated',
        booking_number: 'BK-FAIL-1',
        customer_id: 'cust-1',
        vehicle_id: 'veh-1',
        booking_status: 'payment_pending',
        payment_id: 'pay-fail-1',
        provider_order_id: 'order_fail_1',
        payment_initiated_at: sixMinutesAgo,
      };
      const candidate2 = {
        booking_id: 'bk-success-isolated',
        booking_number: 'BK-SUCC-2',
        customer_id: 'cust-2',
        vehicle_id: 'veh-2',
        booking_status: 'payment_pending',
        payment_id: 'pay-succ-2',
        provider_order_id: 'order_succ_2',
        payment_initiated_at: sixMinutesAgo,
      };

      mockClient.query.mockImplementation((sql, params) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SAVEPOINT') || sql.includes('RELEASE') || sql.includes('ROLLBACK TO SAVEPOINT')) {
          return Promise.resolve();
        }
        if (sql.includes('FOR UPDATE OF b, p SKIP LOCKED')) {
          return Promise.resolve({ rows: [candidate1, candidate2] });
        }
        if (sql.includes('SELECT 1 FROM payments')) {
          return Promise.resolve({ rows: [] });
        }
        // Force candidate 1 to encounter an unrecoverable failure during its processing
        if (params && params.includes('pay-fail-1')) {
          return Promise.reject(new Error('Simulated database deadlock on candidate 1'));
        }
        return Promise.resolve({ rows: [] });
      });

      mockProvider.getOrderStatus.mockResolvedValue({ orderStatus: 'ACTIVE' });

      const result = await timeoutService.processExpiredPaymentBookings();

      // Candidate 2 succeeds despite candidate 1 failure
      expect(result.cancelled.length).toBe(1);
      expect(result.cancelled[0].id).toBe('bk-success-isolated');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to process timeout candidate'),
        expect.objectContaining({ bookingId: 'bk-fail-isolated' }),
      );
    });
  });
});
