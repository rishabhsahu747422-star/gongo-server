'use strict';

process.env.NODE_ENV = 'test';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long';
process.env.PORT = process.env.PORT || '3000';

const CancellationService = require('../../../Customer/src/services/cancellation.service');

describe('Cancellation Policy Calculation with Dynamic Rules', () => {
  const defaultBikeRules = [
    { tier: 1, noticeHours: 6, refundPercentage: 0 },
    { tier: 2, noticeHours: 12, refundPercentage: 50 },
    { tier: 3, noticeHours: 24, refundPercentage: 100 },
  ];

  const defaultCarRules = [
    { tier: 1, noticeHours: 12, refundPercentage: 0 },
    { tier: 2, noticeHours: 24, refundPercentage: 50 },
    { tier: 3, noticeHours: 24, refundPercentage: 100 },
  ];

  const now = new Date('2026-10-10T10:00:00.000Z');

  describe('BIKE calculations', () => {
    it('3 hours before rental -> 0% refund', () => {
      const pickupTime = new Date(now.getTime() + 3 * 3600 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: now,
        vehicleCategory: 'BIKE',
        originalPaidAmount: 1000,
        rules: defaultBikeRules,
      });

      expect(res.refundPercentage).toBe(0);
      expect(res.refundAmount).toBe(0);
      expect(res.refundable).toBe(false);
    });

    it('8 hours before rental -> 50% refund', () => {
      const pickupTime = new Date(now.getTime() + 8 * 3600 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: now,
        vehicleCategory: 'BIKE',
        originalPaidAmount: 1000,
        rules: defaultBikeRules,
      });

      expect(res.refundPercentage).toBe(50);
      expect(res.refundAmount).toBe(500);
      expect(res.refundable).toBe(true);
    });

    it('20 hours before rental -> 100% refund', () => {
      const pickupTime = new Date(now.getTime() + 20 * 3600 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: now,
        vehicleCategory: 'BIKE',
        originalPaidAmount: 1000,
        rules: defaultBikeRules,
      });

      expect(res.refundPercentage).toBe(100);
      expect(res.refundAmount).toBe(1000);
      expect(res.refundable).toBe(true);
    });
  });

  describe('CAR calculations', () => {
    it('8 hours before rental -> 0% refund', () => {
      const pickupTime = new Date(now.getTime() + 8 * 3600 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: now,
        vehicleCategory: 'CAR',
        originalPaidAmount: 2000,
        rules: defaultCarRules,
      });

      expect(res.refundPercentage).toBe(0);
      expect(res.refundAmount).toBe(0);
      expect(res.refundable).toBe(false);
    });

    it('18 hours before rental -> 50% refund', () => {
      const pickupTime = new Date(now.getTime() + 18 * 3600 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: now,
        vehicleCategory: 'CAR',
        originalPaidAmount: 2000,
        rules: defaultCarRules,
      });

      expect(res.refundPercentage).toBe(50);
      expect(res.refundAmount).toBe(1000);
      expect(res.refundable).toBe(true);
    });

    it('30 hours before rental -> 100% refund', () => {
      const pickupTime = new Date(now.getTime() + 30 * 3600 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: now,
        vehicleCategory: 'CAR',
        originalPaidAmount: 2000,
        rules: defaultCarRules,
      });

      expect(res.refundPercentage).toBe(100);
      expect(res.refundAmount).toBe(2000);
      expect(res.refundable).toBe(true);
    });
  });

  describe('Dynamic rules (e.g. 4 tiers)', () => {
    const dynamicBikeRules = [
      { tier: 1, noticeHours: 6, refundPercentage: 0 },
      { tier: 2, noticeHours: 12, refundPercentage: 25 },
      { tier: 3, noticeHours: 24, refundPercentage: 75 },
      { tier: 4, noticeHours: 48, refundPercentage: 100 },
    ];

    it('evaluates Tier 4 dynamically for 36 hours', () => {
      const pickupTime = new Date(now.getTime() + 36 * 3600 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: now,
        vehicleCategory: 'BIKE',
        originalPaidAmount: 1000,
        rules: dynamicBikeRules,
      });

      expect(res.refundPercentage).toBe(100);
      expect(res.refundAmount).toBe(1000);
      expect(res.policy.name).toBe('BIKE_TIER_4');
    });

    it('evaluates open-ended tier for 60 hours', () => {
      const pickupTime = new Date(now.getTime() + 60 * 3600 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: now,
        vehicleCategory: 'BIKE',
        originalPaidAmount: 1000,
        rules: dynamicBikeRules,
      });

      expect(res.refundPercentage).toBe(100);
      expect(res.refundAmount).toBe(1000);
      expect(res.policy.name).toBe('BIKE_TIER_4');
    });
  });
});
