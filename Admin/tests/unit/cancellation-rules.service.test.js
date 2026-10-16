'use strict';

const CancellationRulesService = require('../../src/services/cancellation-rules.service');
const { BadRequestError } = require('../../src/errors');

describe('CancellationRulesService Unit Tests', () => {
  let mockRepo;
  let service;

  beforeEach(() => {
    mockRepo = {
      findByVehicleType: jest.fn().mockImplementation(async (type) => [
        { id: `id-${type}-1`, tier: 1, noticeHours: 6, refundPercentage: 0 },
        { id: `id-${type}-2`, tier: 2, noticeHours: 12, refundPercentage: 50 },
        { id: `id-${type}-3`, tier: 3, noticeHours: 24, refundPercentage: 100 },
      ]),
      findAll: jest.fn().mockResolvedValue({
        bike: [
          { id: 'b1', tier: 1, noticeHours: 6, refundPercentage: 0 },
          { id: 'b2', tier: 2, noticeHours: 12, refundPercentage: 50 },
          { id: 'b3', tier: 3, noticeHours: 24, refundPercentage: 100 },
        ],
        car: [
          { id: 'c1', tier: 1, noticeHours: 12, refundPercentage: 0 },
          { id: 'c2', tier: 2, noticeHours: 24, refundPercentage: 50 },
          { id: 'c3', tier: 3, noticeHours: 24, refundPercentage: 100 },
        ],
      }),
      updateRulesForVehicleType: jest.fn().mockImplementation(async ({ vehicleType, rules }) => (
        rules.map((r, i) => ({
          id: `new-${vehicleType}-${i + 1}`,
          tier: i + 1,
          noticeHours: Number(r.noticeHours ?? r.notice_hours),
          refundPercentage: Number(r.refundPercentage ?? r.refund_percentage),
        }))
      )),
      updateAllRules: jest.fn().mockImplementation(async ({ bike, car }) => ({
        bike: bike.map((r, i) => ({
          id: `new-bike-${i + 1}`,
          tier: i + 1,
          noticeHours: Number(r.noticeHours ?? r.notice_hours),
          refundPercentage: Number(r.refundPercentage ?? r.refund_percentage),
        })),
        car: car.map((r, i) => ({
          id: `new-car-${i + 1}`,
          tier: i + 1,
          noticeHours: Number(r.noticeHours ?? r.notice_hours),
          refundPercentage: Number(r.refundPercentage ?? r.refund_percentage),
        })),
      })),
    };

    service = new CancellationRulesService({ repository: mockRepo });
  });

  describe('Fetching Rules', () => {
    it('fetches all vehicle rules by default', async () => {
      const res = await service.getRules();
      expect(res).toHaveProperty('bike');
      expect(res).toHaveProperty('car');
      expect(mockRepo.findAll).toHaveBeenCalledTimes(1);
    });

    it('fetches bike rules when vehicleType=bike', async () => {
      const res = await service.getRules('bike');
      expect(res.vehicleType).toBe('bike');
      expect(res.rules).toHaveLength(3);
      expect(mockRepo.findByVehicleType).toHaveBeenCalledWith('bike');
    });

    it('fetches car rules when vehicleType=car', async () => {
      const res = await service.getRules('car');
      expect(res.vehicleType).toBe('car');
      expect(res.rules).toHaveLength(3);
      expect(mockRepo.findByVehicleType).toHaveBeenCalledWith('car');
    });
  });

  describe('Updating Rules', () => {
    it('updates bike rules independently', async () => {
      const payload = {
        vehicleType: 'bike',
        rules: [
          { tier: 1, noticeHours: 6, refundPercentage: 0 },
          { tier: 2, noticeHours: 12, refundPercentage: 50 },
          { tier: 3, noticeHours: 24, refundPercentage: 100 },
        ],
      };

      const res = await service.updateRules(payload, 'admin-123');
      expect(res.mode).toBe('single');
      expect(res.vehicleType).toBe('bike');
      expect(res.rules).toHaveLength(3);
      expect(mockRepo.updateRulesForVehicleType).toHaveBeenCalledWith({
        vehicleType: 'bike',
        rules: payload.rules,
        adminId: 'admin-123',
      });
      expect(mockRepo.updateAllRules).not.toHaveBeenCalled();
    });

    it('updates car rules independently', async () => {
      const payload = {
        vehicleType: 'car',
        rules: [
          { tier: 1, noticeHours: 12, refundPercentage: 0 },
          { tier: 2, noticeHours: 24, refundPercentage: 50 },
          { tier: 3, noticeHours: 24, refundPercentage: 100 },
        ],
      };

      const res = await service.updateRules(payload, 'admin-123');
      expect(res.mode).toBe('single');
      expect(res.vehicleType).toBe('car');
      expect(mockRepo.updateRulesForVehicleType).toHaveBeenCalledWith({
        vehicleType: 'car',
        rules: payload.rules,
        adminId: 'admin-123',
      });
    });

    it('updates both bike and car rules transactionally in All Vehicles mode', async () => {
      const payload = {
        vehicleType: 'all',
        bike: [
          { tier: 1, noticeHours: 6, refundPercentage: 0 },
          { tier: 2, noticeHours: 12, refundPercentage: 100 },
        ],
        car: [
          { tier: 1, noticeHours: 12, refundPercentage: 0 },
          { tier: 2, noticeHours: 24, refundPercentage: 100 },
        ],
      };

      const res = await service.updateRules(payload, 'admin-123');
      expect(res.mode).toBe('all');
      expect(res.data.bike).toHaveLength(2);
      expect(res.data.car).toHaveLength(2);
      expect(mockRepo.updateAllRules).toHaveBeenCalledWith({
        bike: payload.bike,
        car: payload.car,
        adminId: 'admin-123',
      });
    });

    it('supports dynamic 4th and 5th rules', async () => {
      const payload = {
        vehicleType: 'bike',
        rules: [
          { tier: 1, noticeHours: 6, refundPercentage: 0 },
          { tier: 2, noticeHours: 12, refundPercentage: 25 },
          { tier: 3, noticeHours: 24, refundPercentage: 50 },
          { tier: 4, noticeHours: 48, refundPercentage: 75 },
          { tier: 5, noticeHours: 72, refundPercentage: 100 },
        ],
      };

      const res = await service.updateRules(payload, 'admin-123');
      expect(res.rules).toHaveLength(5);
      expect(res.rules[3].tier).toBe(4);
      expect(res.rules[4].tier).toBe(5);
    });

    it('re-sequences tiers sequentially with no gaps', async () => {
      const payload = {
        vehicleType: 'bike',
        // Tiers intentionally scrambled or with gaps in input
        rules: [
          { tier: 1, noticeHours: 6, refundPercentage: 0 },
          { tier: 99, noticeHours: 24, refundPercentage: 100 },
        ],
      };

      const res = await service.updateRules(payload, 'admin-123');
      expect(res.rules[0].tier).toBe(1);
      expect(res.rules[1].tier).toBe(2);
    });
  });

  describe('Validation Failures', () => {
    it('rejects invalid vehicle type', async () => {
      await expect(
        service.updateRules({ vehicleType: 'truck', rules: [{ noticeHours: 12, refundPercentage: 50 }] }),
      ).rejects.toThrow(BadRequestError);
    });

    it('rejects empty rules array', async () => {
      await expect(
        service.updateRules({ vehicleType: 'bike', rules: [] }),
      ).rejects.toThrow('At least one cancellation rule is required');
    });

    it('rejects non-numeric or <= 0 notice hours', async () => {
      await expect(
        service.updateRules({
          vehicleType: 'bike',
          rules: [{ tier: 1, noticeHours: -5, refundPercentage: 0 }],
        }),
      ).rejects.toThrow('greater than 0 hours');

      await expect(
        service.updateRules({
          vehicleType: 'bike',
          rules: [{ tier: 1, noticeHours: 'invalid', refundPercentage: 0 }],
        }),
      ).rejects.toThrow('valid number');
    });

    it('rejects negative or > 100 refund percentage', async () => {
      await expect(
        service.updateRules({
          vehicleType: 'bike',
          rules: [{ tier: 1, noticeHours: 6, refundPercentage: -10 }],
        }),
      ).rejects.toThrow('between 0 and 100');

      await expect(
        service.updateRules({
          vehicleType: 'bike',
          rules: [{ tier: 1, noticeHours: 6, refundPercentage: 150 }],
        }),
      ).rejects.toThrow('between 0 and 100');
    });

    it('rejects descending notice window order', async () => {
      await expect(
        service.updateRules({
          vehicleType: 'bike',
          rules: [
            { tier: 1, noticeHours: 24, refundPercentage: 0 },
            { tier: 2, noticeHours: 6, refundPercentage: 50 },
          ],
        }),
      ).rejects.toThrow('cannot be less than previous tier');
    });
  });
});
