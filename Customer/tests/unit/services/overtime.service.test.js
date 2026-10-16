'use strict';

const OvertimeService = require('../../../src/services/overtime.service');
const { ROUNDING_RULE } = OvertimeService;

describe('Customer OvertimeService Unit Tests', () => {
  const baseBooking = {
    id: 'b-cust-123',
    expected_return_at: '2026-10-07T12:00:00.000Z',
    price_per_hour: '100.00',
    booking_status: 'ACTIVE',
  };

  it('detects on-time status before scheduled return', () => {
    const now = new Date('2026-10-07T11:59:00.000Z');
    const state = OvertimeService.calculateOvertimeState(baseBooking, now);
    expect(state.isOvertime).toBe(false);
    expect(state.extraPaymentRequired).toBe(false);
    expect(state.canCompleteReturn).toBe(true);
  });

  it('detects overtime and computes duration + fee accurately', () => {
    const now = new Date('2026-10-07T13:24:00.000Z'); // 1h 24m overdue
    const state = OvertimeService.calculateOvertimeState(baseBooking, now);
    expect(state.isOvertime).toBe(true);
    expect(state.overtimeDurationFormatted).toBe('1h 24m');
    expect(state.overtimeAmount).toBe(200); // 2 hours under CEIL_HOUR
    expect(state.extraPaymentRequired).toBe(true);
    expect(state.extraPaymentStatus).toBe('PENDING');
    expect(state.canCompleteReturn).toBe(false);
  });

  it('reconciles payment and clears extraPaymentRequired when paid', () => {
    const now = new Date('2026-10-07T13:00:00.000Z');
    const existingPayments = [
      { payment_type: 'OVERTIME_CHARGE', amount: 100, status: 'PAID' },
    ];
    const state = OvertimeService.calculateOvertimeState(baseBooking, now, { existingPayments });
    expect(state.remainingOvertimeDue).toBe(0);
    expect(state.extraPaymentRequired).toBe(false);
    expect(state.extraPaymentStatus).toBe('PAID');
    expect(state.canCompleteReturn).toBe(true);
  });
});
