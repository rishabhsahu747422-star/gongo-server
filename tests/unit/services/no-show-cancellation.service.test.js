'use strict';

const { NoShowAutoCancellationService } = require('../../../src/services/no-show-cancellation.service');
const OvertimeService = require('../../../src/services/overtime.service');
const CancellationService = require('../../../src/services/cancellation.service');

describe('NoShowAutoCancellationService & Overtime Unit Tests', () => {
  let mockPool;
  let mockClient;
  let mockRedisClient;
  let mockLogger;
  let mockNotificationService;
  let service;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
    };
    mockRedisClient = {
      del: jest.fn().mockResolvedValue(1),
    };
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockNotificationService = {
      sendNotification: jest.fn().mockResolvedValue({ success: true }),
    };

    service = new NoShowAutoCancellationService({
      pool: mockPool,
      redisClient: mockRedisClient,
      logger: mockLogger,
      notificationService: mockNotificationService,
    });
  });

  describe('Core Auto-Cancellation Lifecycle', () => {
    it('1. No handover + return time not reached -> remains awaiting pickup (not returned in query)', async () => {
      // Query returns 0 rows because return time is in the future
      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
        if (sql.includes('SELECT') && sql.includes('FOR UPDATE SKIP LOCKED')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.processExpiredBookings();
      expect(result.processed).toBe(0);
      expect(result.cancelled.length).toBe(0);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('2. No handover + return time reached/passed -> auto no-show cancellation', async () => {
      const expiredBooking = {
        id: 'bk-1001',
        booking_number: 'BK-1001',
        booking_reference: 'BK-1001',
        customer_id: 'cust-1',
        partner_id: 'part-1',
        vehicle_id: 'veh-1',
        start_at: '2026-10-10T22:00:00.000Z',
        end_at: '2026-10-10T23:00:00.000Z',
        expected_return_at: '2026-10-10T23:00:00.000Z',
        status: 'confirmed',
        booking_status: 'CONFIRMED',
        subtotal: 500,
        total_amount: 500,
      };

      mockClient.query.mockImplementation((sql, params) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          return Promise.resolve({ rows: [expiredBooking] });
        }
        if (sql.includes('WHERE b.id = $1')) {
          return Promise.resolve({
            rows: [{
              status: 'confirmed',
              booking_status: 'CONFIRMED',
              is_verified: false,
              is_picked_up: false,
            }],
          });
        }
        if (sql.includes('FROM payments')) {
          return Promise.resolve({ rows: [{ amount: 500 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.processExpiredBookings();
      expect(result.processed).toBe(1);
      expect(result.cancelled.length).toBe(1);
      expect(result.cancelled[0].id).toBe('bk-1001');

      // Check status update query executed
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'cancelled'"),
        ['bk-1001'],
      );

      // Check booking_status_history query executed with NO_SHOW_EXPIRED
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringMatching(/booking_status_history[\s\S]*NO_SHOW_EXPIRED/),
        expect.arrayContaining(['bk-1001', 'confirmed']),
      );

      // Check booking_cancellations executed with 0% refund
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('booking_cancellations'),
        expect.arrayContaining(['bk-1001', 500]),
      );

      // Check Redis OTP invalidated
      expect(mockRedisClient.del).toHaveBeenCalledWith('otp:pickup:state:bk-1001');
      expect(mockRedisClient.del).toHaveBeenCalledWith('otp:pickup:attempts:bk-1001');

      // Check customer push notification dispatched
      expect(mockNotificationService.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'cust-1',
          type: 'BOOKING_CANCELLED',
          title: 'Booking Expired',
          eventKey: 'NO_SHOW_EXPIRED:booking:bk-1001',
        }),
      );
    });

    it('3. Handover completed before return -> never auto no-show (re-check inside transaction skips)', async () => {
      const booking = {
        id: 'bk-1002',
        status: 'confirmed',
        booking_status: 'CONFIRMED',
        end_at: '2026-10-10T23:00:00.000Z',
      };

      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          return Promise.resolve({ rows: [booking] });
        }
        if (sql.includes('WHERE b.id = $1')) {
          // Re-check shows handover OTP was just verified concurrently!
          return Promise.resolve({
            rows: [{
              status: 'in_progress',
              booking_status: 'ACTIVE',
              is_verified: true,
              is_picked_up: true,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.processExpiredBookings();
      expect(result.cancelled.length).toBe(0);
      // Status update must NOT be called
      expect(mockClient.query).not.toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'cancelled'"),
        ['bk-1002'],
      );
    });

    it('4. Duplicate execution is idempotent (already cancelled booking is skipped)', async () => {
      mockClient.query.mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          // Query filters out already cancelled rows
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result1 = await service.processExpiredBookings();
      const result2 = await service.processExpiredBookings();
      expect(result1.cancelled.length).toBe(0);
      expect(result2.cancelled.length).toBe(0);
      expect(mockNotificationService.sendNotification).not.toHaveBeenCalled();
    });
  });

  describe('Overtime & Handover Boundary Conditions', () => {
    it('5. No overtime for no-show booking (handover never occurred)', () => {
      const noShowBooking = {
        id: 'b-noshow-1',
        expected_return_at: '2026-10-10T23:00:00.000Z',
        price_per_hour: '100.00',
        booking_status: 'CONFIRMED',
        status: 'confirmed',
        picked_up_at: null,
        is_verified: false,
      };

      // Reference time is 2 hours AFTER scheduled return time
      const afterReturn = new Date('2026-10-11T01:00:00.000Z');
      const overtimeState = OvertimeService.calculateOvertimeState(noShowBooking, afterReturn);

      expect(overtimeState.isOvertime).toBe(false);
      expect(overtimeState.overtimeDurationSeconds).toBe(0);
      expect(overtimeState.overtimeAmount).toBe(0);
      expect(overtimeState.remainingOvertimeDue).toBe(0);
      expect(overtimeState.extraPaymentRequired).toBe(false);
    });

    it('6. Active rental where handover DID occur enters overtime when overdue', () => {
      const activeBooking = {
        id: 'b-active-1',
        expected_return_at: '2026-10-10T23:00:00.000Z',
        price_per_hour: '100.00',
        booking_status: 'ACTIVE',
        status: 'in_progress',
        picked_up_at: '2026-10-10T22:05:00.000Z',
        is_verified: true,
      };

      // 1 hour after scheduled return
      const afterReturn = new Date('2026-10-11T00:00:00.000Z');
      const overtimeState = OvertimeService.calculateOvertimeState(activeBooking, afterReturn);

      expect(overtimeState.isOvertime).toBe(true);
      expect(overtimeState.overtimeDurationSeconds).toBe(3600);
      expect(overtimeState.overtimeAmount).toBe(100);
      expect(overtimeState.extraPaymentRequired).toBe(true);
    });

    it('7. Cross-midnight booking correctly evaluated', () => {
      const crossMidnight = {
        id: 'b-midnight-1',
        start_at: '2026-10-10T23:00:00.000Z',
        end_at: '2026-10-11T01:00:00.000Z',
        expected_return_at: '2026-10-11T01:00:00.000Z',
        booking_status: 'CONFIRMED',
        status: 'confirmed',
      };

      // 11:30 PM (before return time)
      const beforeReturn = new Date('2026-10-10T23:30:00.000Z');
      const stateBefore = OvertimeService.calculateOvertimeState(crossMidnight, beforeReturn);
      expect(stateBefore.isOvertime).toBe(false);

      // Return time reached (1:00 AM Oct 11) - no handover, so overtime is false
      const afterReturn = new Date('2026-10-11T01:05:00.000Z');
      const stateAfter = OvertimeService.calculateOvertimeState(crossMidnight, afterReturn);
      expect(stateAfter.isOvertime).toBe(false);
    });

    it('8. Existing cancellation policy returns 0% refund past pickup time', () => {
      const policyResult = CancellationService.calculatePolicy({
        pickupTime: '2026-10-10T22:00:00.000Z',
        serverTime: new Date('2026-10-10T23:00:00.000Z'), // Past pickup time
        vehicleCategory: 'BIKE',
        originalPaidAmount: 500,
        securityDeposit: 1000,
      });

      expect(policyResult.refundPercentage).toBe(0);
      expect(policyResult.refundAmount).toBe(0);
      expect(policyResult.cancellationCharge).toBe(500);
      expect(policyResult.refundable).toBe(false);
      // Security deposit NEVER participates in cancellation refund
      expect(policyResult.securityDepositRefundable).toBe(false);
    });
  });
});
