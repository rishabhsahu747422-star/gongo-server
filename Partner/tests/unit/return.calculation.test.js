'use strict';

const bookingService = require('../../src/services/booking.service');

describe('Unit: Return & Late Charge Calculation', () => {
  const { calculateLateCharges } = bookingService;
  const pricePerHour = 150.00;

  describe('15-Minute Grace Period Boundaries', () => {
    const baseExpected = new Date('2026-10-01T10:00:00.000Z');

    it('0 minutes late → ₹0 charge, 0 billable hours, ON_TIME status', () => {
      const actual = new Date(baseExpected.getTime());
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour,
      });

      expect(result.isLate).toBe(false);
      expect(result.lateMinutes).toBe(0);
      expect(result.billableHours).toBe(0);
      expect(result.lateFee).toBe(0.00);
      expect(result.returnStatus).toBe('ON_TIME');
    });

    it('10 minutes late → ₹0 charge, 0 billable hours, ON_TIME status', () => {
      const actual = new Date(baseExpected.getTime() + 10 * 60 * 1000);
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour,
      });

      expect(result.isLate).toBe(false);
      expect(result.lateMinutes).toBe(10);
      expect(result.billableHours).toBe(0);
      expect(result.lateFee).toBe(0.00);
      expect(result.returnStatus).toBe('ON_TIME');
    });

    it('15 minutes late (exact grace period threshold) → ₹0 charge, 0 billable hours, ON_TIME status', () => {
      const actual = new Date(baseExpected.getTime() + 15 * 60 * 1000);
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour,
      });

      expect(result.isLate).toBe(false);
      expect(result.lateMinutes).toBe(15);
      expect(result.billableHours).toBe(0);
      expect(result.lateFee).toBe(0.00);
      expect(result.returnStatus).toBe('ON_TIME');
    });

    it('16 minutes late (1 minute past grace period) → 1 hour charge, LATE status', () => {
      const actual = new Date(baseExpected.getTime() + 16 * 60 * 1000);
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour,
      });

      expect(result.isLate).toBe(true);
      expect(result.lateMinutes).toBe(16);
      expect(result.billableHours).toBe(1);
      expect(result.lateFee).toBe(150.00);
      expect(result.returnStatus).toBe('LATE');
    });

    it('59 minutes late → 1 hour charge, LATE status', () => {
      const actual = new Date(baseExpected.getTime() + 59 * 60 * 1000);
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour,
      });

      expect(result.isLate).toBe(true);
      expect(result.lateMinutes).toBe(59);
      expect(result.billableHours).toBe(1);
      expect(result.lateFee).toBe(150.00);
      expect(result.returnStatus).toBe('LATE');
    });

    it('60 minutes late → 1 hour charge, LATE status', () => {
      const actual = new Date(baseExpected.getTime() + 60 * 60 * 1000);
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour,
      });

      expect(result.isLate).toBe(true);
      expect(result.lateMinutes).toBe(60);
      expect(result.billableHours).toBe(1);
      expect(result.lateFee).toBe(150.00);
      expect(result.returnStatus).toBe('LATE');
    });

    it('61 minutes late → 2 hours charge, LATE status', () => {
      const actual = new Date(baseExpected.getTime() + 61 * 60 * 1000);
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour,
      });

      expect(result.isLate).toBe(true);
      expect(result.lateMinutes).toBe(61);
      expect(result.billableHours).toBe(2);
      expect(result.lateFee).toBe(300.00);
      expect(result.returnStatus).toBe('LATE');
    });

    it('120 minutes late → 2 hours charge, LATE status', () => {
      const actual = new Date(baseExpected.getTime() + 120 * 60 * 1000);
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour,
      });

      expect(result.isLate).toBe(true);
      expect(result.lateMinutes).toBe(120);
      expect(result.billableHours).toBe(2);
      expect(result.lateFee).toBe(300.00);
      expect(result.returnStatus).toBe('LATE');
    });

    it('121 minutes late → 3 hours charge, LATE status', () => {
      const actual = new Date(baseExpected.getTime() + 121 * 60 * 1000);
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour,
      });

      expect(result.isLate).toBe(true);
      expect(result.lateMinutes).toBe(121);
      expect(result.billableHours).toBe(3);
      expect(result.lateFee).toBe(450.00);
      expect(result.returnStatus).toBe('LATE');
    });
  });

  describe('Early Returns (Negative lateness)', () => {
    const baseExpected = new Date('2026-10-01T10:00:00.000Z');

    it('early return (30 minutes early) → ₹0 charge, 0 billable hours, ON_TIME status', () => {
      const actual = new Date(baseExpected.getTime() - 30 * 60 * 1000);
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour,
      });

      expect(result.isLate).toBe(false);
      expect(result.lateMinutes).toBe(0);
      expect(result.billableHours).toBe(0);
      expect(result.lateFee).toBe(0.00);
      expect(result.returnStatus).toBe('ON_TIME');
    });
  });

  describe('Rate Edge Cases', () => {
    it('handles zero hourly rate without NaN', () => {
      const baseExpected = new Date('2026-10-01T10:00:00.000Z');
      const actual = new Date(baseExpected.getTime() + 90 * 60 * 1000);
      const result = calculateLateCharges({
        expectedReturnAt: baseExpected.toISOString(),
        actualReturnAt: actual.toISOString(),
        pricePerHour: 0,
      });

      expect(result.isLate).toBe(true);
      expect(result.lateMinutes).toBe(90);
      expect(result.billableHours).toBe(2);
      expect(result.lateFee).toBe(0.00);
    });
  });
});
