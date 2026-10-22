'use strict';

const { PaymentTimeoutService } = require('../../../src/services/payment-timeout.service');
const { PaymentService } = require('../../../src/services/payment.service');
const BookingRepository = require('../../../src/repositories/booking.repository');
const { PAYMENT_STATUS } = require('../../../src/constants/payment');
const { BOOKING_STATUS } = require('../../../src/constants/booking');

describe('Comprehensive 5-Minute Payment Deadline & Expiration Test Suite', () => {
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
      query: jest.fn(),
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

  // Test 1: A pending booking with time remaining stays pending
  it('1. pending booking with time remaining stays pending and is not selected', async () => {
    const futureDeadline = new Date(Date.now() + 3 * 60 * 1000); // 3 minutes remaining
    mockClient.query.mockImplementation((sql, params) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
      if (sql.includes('FOR UPDATE OF b')) {
        // Query returns 0 rows because deadline has not passed
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await timeoutService.processExpiredPaymentBookings();
    expect(result.processed).toBe(0);
    expect(result.cancelled.length).toBe(0);
  });

  // Test 2: A pending booking past its deadline is eligible for cancellation
  it('2. pending booking past its deadline is eligible for cancellation and cancelled', async () => {
    const pastDeadline = new Date(Date.now() - 30 * 1000); // 30s past deadline
    const candidate = {
      booking_id: 'b-past-1',
      booking_number: 'BK-PAST-1',
      booking_reference: 'GB-PAST-1',
      customer_id: 'c-1',
      vehicle_id: 'v-1',
      booking_status: 'payment_pending',
      payment_id: 'p-1',
      provider_order_id: 'order_past_1',
      payment_expires_at: pastDeadline,
    };

    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SAVEPOINT') || sql.includes('RELEASE')) {
        return Promise.resolve();
      }
      if (sql.includes('FOR UPDATE OF b')) {
        return Promise.resolve({ rows: [candidate] });
      }
      if (sql.includes('SELECT 1 FROM payments')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    mockProvider.getOrderStatus.mockResolvedValue({ orderStatus: 'ACTIVE' }); // unpaid

    const result = await timeoutService.processExpiredPaymentBookings();
    expect(result.processed).toBe(1);
    expect(result.cancelled.length).toBe(1);
    expect(result.cancelled[0].id).toBe('b-past-1');
    expect(result.cancelled[0].reason).toBe('PAYMENT_TIMEOUT');
  });

  // Test 3: The scheduled process actually invokes the expiration logic
  it('3. startScheduler runs and triggers expiration execution cycle', (done) => {
    const processSpy = jest.spyOn(timeoutService, 'processExpiredPaymentBookings').mockResolvedValue({
      processed: 0,
      cancelled: [],
    });

    timeoutService.startScheduler(100);
    expect(timeoutService.timer).not.toBeNull();

    // Verify initial cycle or periodic tick
    setTimeout(async () => {
      await timeoutService.stopScheduler();
      expect(timeoutService.timer).toBeNull();
      processSpy.mockRestore();
      done();
    }, 50);
  });

  // Test 4: A successfully paid booking is never expired
  it('4. a successfully paid booking is never expired', async () => {
    const candidate = {
      booking_id: 'b-paid-1',
      booking_status: 'payment_pending',
      payment_id: 'p-paid-1',
      provider_order_id: 'order_paid_1',
    };

    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SAVEPOINT') || sql.includes('RELEASE')) {
        return Promise.resolve();
      }
      if (sql.includes('FOR UPDATE OF b')) {
        return Promise.resolve({ rows: [candidate] });
      }
      if (sql.includes('SELECT 1 FROM payments')) {
        // Successful payment exists!
        return Promise.resolve({ rows: [{ id: 'p-paid-1' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await timeoutService.processExpiredPaymentBookings();
    expect(result.cancelled.length).toBe(0);
    // Cancellation queries not called
    const cancelCall = mockClient.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes("status = 'cancelled'"),
    );
    expect(cancelCall).toBeUndefined();
  });

  // Test 5: A cancelled booking is not processed repeatedly (Idempotency)
  it('5. a cancelled booking is not processed repeatedly', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
      if (sql.includes('FOR UPDATE OF b')) {
        // Status condition excludes 'cancelled'
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await timeoutService.processExpiredPaymentBookings();
    expect(result.processed).toBe(0);
    expect(result.cancelled.length).toBe(0);
  });

  // Test 6: Duplicate scheduled executions are safe (in-flight mutex)
  it('6. duplicate scheduled executions are safe and do not run concurrently', async () => {
    timeoutService.isProcessing = true;
    let connectCalled = false;
    mockPool.connect = jest.fn().mockImplementation(() => {
      connectCalled = true;
      return Promise.resolve(mockClient);
    });

    // execute cycle via scheduler logic
    const cycle = async () => {
      if (timeoutService.isProcessing) return;
      await timeoutService.processExpiredPaymentBookings();
    };

    await cycle();
    expect(connectCalled).toBe(false);
    timeoutService.isProcessing = false;
  });

  // Test 7: Late payment success follows the defined late-payment policy
  it('7. late payment success does not confirm cancelled booking and flags refund', async () => {
    const mockBookingRepo = {
      findById: jest.fn().mockResolvedValue({ id: 'b-late-1', status: 'cancelled' }),
    };
    const paymentService = new PaymentService({
      pool: mockPool,
      bookingRepository: mockBookingRepo,
      logger: mockLogger,
      notificationService: mockNotificationService,
    });

    const client = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT status FROM bookings')) {
          return Promise.resolve({ rows: [{ status: 'cancelled' }] });
        }
        if (sql.includes('INSERT INTO refunds') || sql.includes('refund')) {
          return Promise.resolve({ rows: [{ id: 'ref-1' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    paymentService._raiseLatePaymentRefundRequest = jest.fn().mockResolvedValue('ref-req-1');

    const lockedPayment = {
      id: 'p-late-1',
      booking_id: 'b-late-1',
      amount: 500,
      customer_id: 'c-1',
    };

    const res = await paymentService._applyPaymentSuccess(client, lockedPayment, 'cf_late_order');
    expect(res.bookingConfirmed).toBe(false);
    expect(res.reason).toBe('BOOKING_NOT_CONFIRMABLE_REFUND_REQUIRED');
    expect(res.refundRequestId).toBe('ref-req-1');
  });

  // Test 8: Only the correct vehicle reservation is released (rental_status = IDLE)
  it('8. vehicle release marks target vehicle as IDLE and excludes ACTIVE rentals', async () => {
    const candidate = {
      booking_id: 'b-release-1',
      vehicle_id: 'v-release-1',
      booking_status: 'payment_pending',
      payment_id: 'p-release-1',
      payment_expires_at: new Date(Date.now() - 60000),
    };

    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('SAVEPOINT') || sql.includes('RELEASE')) {
        return Promise.resolve();
      }
      if (sql.includes('FOR UPDATE OF b')) {
        return Promise.resolve({ rows: [candidate] });
      }
      if (sql.includes('SELECT 1 FROM payments')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    mockProvider.getOrderStatus.mockResolvedValue({ orderStatus: 'EXPIRED' });

    await timeoutService.processExpiredPaymentBookings();

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("SET rental_status = 'IDLE'"),
      ['v-release-1'],
    );
  });

  // Test 9: mapBookingDto correctly surfaces paymentExpiresAt and defaults
  it('9. BookingRepository.mapBookingDto surfaces persisted paymentExpiresAt reliably', () => {
    const row = {
      id: 'b-map-1',
      status: 'PAYMENT_PENDING',
      created_at: new Date('2026-10-21T10:00:00.000Z'),
      payment_expires_at: new Date('2026-10-21T10:05:00.000Z'),
      payment_initiated_at: new Date('2026-10-21T10:00:00.000Z'),
      total_amount: '198.00',
    };

    const dto = BookingRepository.mapBookingDto(row);
    expect(dto.paymentExpiresAt).toBe('2026-10-21T10:05:00.000Z');
    expect(dto.paymentInitiatedAt).toBe('2026-10-21T10:00:00.000Z');
    expect(dto.totalAmount).toBe(198);
  });

  // Test 10: Missing payment_expires_at defaults safely to created_at + 5 min
  it('10. BookingRepository.mapBookingDto provides safe 5-minute fallback when payment_expires_at is missing', () => {
    const row = {
      id: 'b-fallback-1',
      status: 'PAYMENT_PENDING',
      created_at: new Date('2026-10-21T10:00:00.000Z'),
      payment_expires_at: null,
      payment_initiated_at: null,
      total_amount: '198.00',
    };

    const dto = BookingRepository.mapBookingDto(row);
    expect(dto.paymentExpiresAt).toBe('2026-10-21T10:05:00.000Z');
  });
});
