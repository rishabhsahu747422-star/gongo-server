'use strict';

const OvertimeService = require('../../src/services/overtime.service');
const { ROUNDING_RULE } = OvertimeService;

describe('OvertimeService Unit Tests', () => {
  const baseBooking = {
    id: 'b-test-123',
    expected_return_at: '2026-10-07T12:00:00.000Z',
    price_per_hour: '100.00',
    booking_status: 'ACTIVE',
  };

  describe('1. Authoritative Overtime Detection & State', () => {
    it('returns isOvertime = false when vehicle is returned before scheduled return time', () => {
      const now = new Date('2026-10-07T11:45:00.000Z'); // 15 mins before
      const state = OvertimeService.calculateOvertimeState(baseBooking, now);

      expect(state.isOvertime).toBe(false);
      expect(state.overtimeDurationSeconds).toBe(0);
      expect(state.overtimeAmount).toBe(0);
      expect(state.extraPaymentRequired).toBe(false);
      expect(state.extraPaymentStatus).toBe('NOT_REQUIRED');
      expect(state.canCompleteReturn).toBe(true);
      expect(state.returnPaymentRequired).toBe(false);
    });

    it('returns isOvertime = false when exactly at scheduled return time', () => {
      const now = new Date('2026-10-07T12:00:00.000Z');
      const state = OvertimeService.calculateOvertimeState(baseBooking, now);

      expect(state.isOvertime).toBe(false);
      expect(state.overtimeAmount).toBe(0);
      expect(state.extraPaymentRequired).toBe(false);
    });

    it('returns isOvertime = true exactly when current_time > scheduled_return_at', () => {
      const now = new Date('2026-10-07T12:00:01.000Z'); // 1 sec after
      const state = OvertimeService.calculateOvertimeState(baseBooking, now);

      expect(state.isOvertime).toBe(true);
      expect(state.overtimeStartedAt).toBe('2026-10-07T12:00:00.000Z');
      expect(state.overtimeDurationSeconds).toBe(1);
      expect(state.overtimeDurationFormatted).toBe('1s');
      // Within 15-minute grace period -> amount is 0
      expect(state.overtimeAmount).toBe(0);
      expect(state.extraPaymentRequired).toBe(false);
      expect(state.canCompleteReturn).toBe(true);
    });

    it('does not calculate overtime if booking is already COMPLETED or CANCELLED', () => {
      const completedBooking = {
        ...baseBooking,
        booking_status: 'COMPLETED',
        returned_at: '2026-10-07T11:50:00.000Z',
      };
      const now = new Date('2026-10-07T14:00:00.000Z');
      const state = OvertimeService.calculateOvertimeState(completedBooking, now);

      expect(state.isOvertime).toBe(false);
      expect(state.overtimeAmount).toBe(0);
      expect(state.canCompleteReturn).toBe(true);
    });
  });

  describe('2. Configurable Grace Period & Rounding Rules', () => {
    it('applies 15-minute grace period by default without charging', () => {
      const now = new Date('2026-10-07T12:14:59.000Z'); // 14m 59s
      const state = OvertimeService.calculateOvertimeState(baseBooking, now);

      expect(state.isOvertime).toBe(true);
      expect(state.overtimeAmount).toBe(0);
      expect(state.extraPaymentRequired).toBe(false);
      expect(state.canCompleteReturn).toBe(true);
    });

    it('charges 1 hour when exceeding 15-minute grace period under CEIL_HOUR (default)', () => {
      const now = new Date('2026-10-07T12:16:00.000Z'); // 16 minutes late
      const state = OvertimeService.calculateOvertimeState(baseBooking, now);

      expect(state.isOvertime).toBe(true);
      expect(state.overtimeDurationSeconds).toBe(960);
      expect(state.overtimeDurationFormatted).toBe('16m');
      expect(state.overtimeRate).toBe(100);
      expect(state.overtimeAmount).toBe(100); // 1 full billable hour
      expect(state.extraPaymentRequired).toBe(true);
      expect(state.extraPaymentStatus).toBe('PENDING');
      expect(state.canCompleteReturn).toBe(false);
      expect(state.returnPaymentRequired).toBe(true);
    });

    it('calculates deterministic amounts for multiple hours overdue', () => {
      const now = new Date('2026-10-07T14:30:00.000Z'); // 2 hours 30 mins overdue
      const state = OvertimeService.calculateOvertimeState(baseBooking, now);

      expect(state.isOvertime).toBe(true);
      expect(state.overtimeDurationSeconds).toBe(9000);
      expect(state.overtimeDurationFormatted).toBe('2h 30m');
      // Under CEIL_HOUR: 150 mins / 60 = 2.5 -> 3 hours * 100 = 300
      expect(state.overtimeAmount).toBe(300);
      expect(state.remainingOvertimeDue).toBe(300);
      expect(state.canCompleteReturn).toBe(false);
    });

    it('supports EXACT_PRO_RATA rounding rule when configured', () => {
      const now = new Date('2026-10-07T13:30:00.000Z'); // 90 mins overdue
      const state = OvertimeService.calculateOvertimeState(baseBooking, now, {
        roundingRule: ROUNDING_RULE.EXACT_PRO_RATA,
      });

      // 90 mins / 60 = 1.5 * 100 = 150.00
      expect(state.overtimeAmount).toBe(150.00);
    });

    it('supports HALF_HOUR rounding rule when configured', () => {
      const now = new Date('2026-10-07T13:10:00.000Z'); // 70 mins overdue
      const state = OvertimeService.calculateOvertimeState(baseBooking, now, {
        roundingRule: ROUNDING_RULE.HALF_HOUR,
      });

      // 70 mins -> 3 half hours (90 mins) -> 1.5 * 100 = 150.00
      expect(state.overtimeAmount).toBe(150.00);
    });
  });

  describe('3. Payment Reconciliation & Return Gate Eligibility', () => {
    it('marks extraPaymentStatus as PAID and allows return when customer has paid total overtime', () => {
      const now = new Date('2026-10-07T14:00:00.000Z'); // 2 hours late = 200
      const existingPayments = [
        {
          id: 'pay-ot-1',
          payment_type: 'OVERTIME_CHARGE',
          amount: '200.00',
          status: 'SUCCESS',
        },
      ];

      const state = OvertimeService.calculateOvertimeState(baseBooking, now, {
        existingPayments,
      });

      expect(state.overtimeAmount).toBe(200.00);
      expect(state.totalOvertimePaid).toBe(200.00);
      expect(state.remainingOvertimeDue).toBe(0.00);
      expect(state.extraPaymentRequired).toBe(false);
      expect(state.extraPaymentStatus).toBe('PAID');
      expect(state.canCompleteReturn).toBe(true);
      expect(state.returnPaymentRequired).toBe(false);
    });

    it('blocks return when customer partially paid accumulated overtime and duration increased', () => {
      // Customer paid for 1 hour earlier (100) but stayed 3 hours (300)
      const now = new Date('2026-10-07T15:00:00.000Z'); // 3 hours late = 300
      const existingPayments = [
        {
          id: 'pay-ot-1',
          payment_type: 'OVERTIME_CHARGE',
          amount: '100.00',
          status: 'PAID',
        },
      ];

      const state = OvertimeService.calculateOvertimeState(baseBooking, now, {
        existingPayments,
      });

      expect(state.overtimeAmount).toBe(300.00);
      expect(state.totalOvertimePaid).toBe(100.00);
      expect(state.remainingOvertimeDue).toBe(200.00); // 300 - 100 = 200
      expect(state.extraPaymentRequired).toBe(true);
      expect(state.extraPaymentStatus).toBe('PENDING');
      expect(state.canCompleteReturn).toBe(false);
      expect(state.returnPaymentRequired).toBe(true);
    });

    it('recognizes POST_RENTAL_SETTLEMENT payments alongside OVERTIME_CHARGE', () => {
      const now = new Date('2026-10-07T13:00:00.000Z'); // 1 hour late = 100
      const existingPayments = [
        {
          id: 'pay-settle-1',
          payment_type: 'POST_RENTAL_SETTLEMENT',
          amount: '100.00',
          status: 'PAID',
        },
      ];

      const state = OvertimeService.calculateOvertimeState(baseBooking, now, {
        existingPayments,
      });

      expect(state.totalOvertimePaid).toBe(100.00);
      expect(state.remainingOvertimeDue).toBe(0.00);
      expect(state.canCompleteReturn).toBe(true);
    });
  });

  describe('4. Formatting & Safe Float Arithmetic', () => {
    it('formats seconds, minutes, and hours accurately', () => {
      expect(OvertimeService.formatOvertimeDuration(45)).toBe('45s');
      expect(OvertimeService.formatOvertimeDuration(125)).toBe('2m 5s');
      expect(OvertimeService.formatOvertimeDuration(3600)).toBe('1h');
      expect(OvertimeService.formatOvertimeDuration(5040)).toBe('1h 24m');
    });

    it('avoids floating-point imprecision when rounding money', () => {
      expect(OvertimeService.roundMoney(0.1 + 0.2)).toBe(0.3);
      expect(OvertimeService.roundMoney(199.999)).toBe(200.00);
    });
  });
});
