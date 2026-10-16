'use strict';

const { PlatformFeeService } = require('../../../src/services/platform-fee.service');
const { NotFoundError, BadRequestError } = require('../../../src/errors');

describe('Unit: Customer PlatformFeeService', () => {
  let mockRepo;
  let service;

  const ACTIVE_CONFIG = {
    id: 'f3b25efa-1d9f-43e3-9484-b87ce762b6e5',
    feeType: 'fixed',
    feeValue: 50.0,
    currency: 'INR',
    isActive: true,
    createdBy: null,
    createdAt: new Date('2026-10-08T18:27:11.197Z'),
    updatedAt: new Date('2026-10-08T18:27:11.197Z'),
  };

  beforeEach(() => {
    mockRepo = {
      findActive: jest.fn().mockResolvedValue(ACTIVE_CONFIG),
    };
    service = new PlatformFeeService(mockRepo);
  });

  describe('getActivePlatformFee', () => {
    it('returns the active platform fee configuration when present', async () => {
      const result = await service.getActivePlatformFee();
      expect(result).toBeDefined();
      expect(result.feeType).toBe('fixed');
      expect(result.feeValue).toBe(50);
      expect(result.currency).toBe('INR');
      expect(mockRepo.findActive).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundError when no active configuration exists and throwIfMissing is true', async () => {
      mockRepo.findActive.mockResolvedValue(null);
      await expect(service.getActivePlatformFee({ throwIfMissing: true })).rejects.toThrow(
        NotFoundError,
      );
    });

    it('returns null safely when no active configuration exists and throwIfMissing is false', async () => {
      mockRepo.findActive.mockResolvedValue(null);
      const result = await service.getActivePlatformFee({ throwIfMissing: false });
      expect(result).toBeNull();
    });
  });

  describe('calculatePlatformFee', () => {
    it('15. Fixed fee calculation works', () => {
      const fee = service.calculatePlatformFee({
        feeType: 'fixed',
        feeValue: 50,
        baseAmount: 1000,
      });
      expect(fee).toBe(50);
    });

    it('Fixed fee with value 0 works', () => {
      const fee = service.calculatePlatformFee({
        feeType: 'fixed',
        feeValue: 0,
        baseAmount: 1000,
      });
      expect(fee).toBe(0);
    });

    it('16. Percentage fee calculation works', () => {
      const fee = service.calculatePlatformFee({
        feeType: 'percentage',
        feeValue: 5,
        baseAmount: 1000,
      });
      expect(fee).toBe(50);
    });

    it('17. Percentage boundary 0 works', () => {
      const fee = service.calculatePlatformFee({
        feeType: 'percentage',
        feeValue: 0,
        baseAmount: 1000,
      });
      expect(fee).toBe(0);
    });

    it('18. Percentage boundary 100 works', () => {
      const fee = service.calculatePlatformFee({
        feeType: 'percentage',
        feeValue: 100,
        baseAmount: 1000,
      });
      expect(fee).toBe(1000);
    });

    it('rounds percentage fee to 2 decimal places using standard monetary rounding', () => {
      const fee = service.calculatePlatformFee({
        feeType: 'percentage',
        feeValue: 5,
        baseAmount: 123.45,
      });
      // 123.45 * 5 / 100 = 6.1725 -> 6.17
      expect(fee).toBe(6.17);
    });

    it('19. Invalid percentage (> 100) is rejected', () => {
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'percentage',
          feeValue: 100.5,
          baseAmount: 1000,
        });
      }).toThrow(BadRequestError);
    });

    it('rejects negative feeValue', () => {
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'fixed',
          feeValue: -15,
          baseAmount: 1000,
        });
      }).toThrow(BadRequestError);
    });

    it('rejects invalid feeType', () => {
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'tiered',
          feeValue: 50,
          baseAmount: 1000,
        });
      }).toThrow(BadRequestError);
    });

    it('rejects non-numeric feeValue', () => {
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'fixed',
          feeValue: 'not-a-number',
          baseAmount: 1000,
        });
      }).toThrow(BadRequestError);
    });

    it('rejects missing or non-object params without throwing TypeError', () => {
      expect(() => service.calculatePlatformFee()).toThrow(BadRequestError);
      expect(() => service.calculatePlatformFee(null)).toThrow(BadRequestError);
      expect(() => service.calculatePlatformFee([])).toThrow(BadRequestError);
      expect(() => service.calculatePlatformFee('bad')).toThrow(BadRequestError);
    });

    it('rejects whitespace-only feeValue', () => {
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'fixed',
          feeValue: '   ',
          baseAmount: 1000,
        });
      }).toThrow(BadRequestError);
    });

    it('rejects array feeValue', () => {
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'fixed',
          feeValue: [50],
          baseAmount: 1000,
        });
      }).toThrow(BadRequestError);
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'fixed',
          feeValue: [],
          baseAmount: 1000,
        });
      }).toThrow(BadRequestError);
    });

    it('rejects whitespace-only baseAmount', () => {
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'fixed',
          feeValue: 50,
          baseAmount: '   ',
        });
      }).toThrow(BadRequestError);
    });

    it('rejects array baseAmount', () => {
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'fixed',
          feeValue: 50,
          baseAmount: [1000],
        });
      }).toThrow(BadRequestError);
    });
  });
});
