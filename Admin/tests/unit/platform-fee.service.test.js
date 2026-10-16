'use strict';

const { PlatformFeeService } = require('../../src/services/platform-fee.service');
const { NotFoundError, ValidationError } = require('../../src/errors');

describe('Unit: PlatformFeeService', () => {
  let mockRepo;
  let service;

  const ACTIVE_RECORD = {
    serviceCharge: {
      id: '8e130156-9b3b-4f4d-b50b-f8a3c04ea675',
      calculationType: 'fixed',
      value: 2.50,
      currency: 'INR',
      isActive: true,
      createdBy: null,
      createdAt: new Date('2026-10-09T05:38:47.480Z'),
      updatedAt: new Date('2026-10-09T05:38:47.480Z'),
    },
    convenienceFee: {
      id: 'b1699dea-b202-4402-a318-a969f9199561',
      calculationType: 'fixed',
      value: 2.00,
      currency: 'INR',
      isActive: true,
      createdBy: null,
      createdAt: new Date('2026-10-09T05:38:47.480Z'),
      updatedAt: new Date('2026-10-09T05:38:47.480Z'),
    },
    gst: {
      id: 'f68a0d50-a3fd-463b-8d5f-54e6b1db126f',
      calculationType: 'percentage',
      value: 18.00,
      currency: 'INR',
      isActive: true,
      createdBy: null,
      createdAt: new Date('2026-10-09T05:38:47.480Z'),
      updatedAt: new Date('2026-10-09T05:38:47.480Z'),
    },
  };

  beforeEach(() => {
    mockRepo = {
      findActive: jest.fn().mockResolvedValue(ACTIVE_RECORD),
      updateActiveCharges: jest.fn(),
    };
    service = new PlatformFeeService(mockRepo);
  });

  describe('getActivePlatformFee', () => {
    it('returns the active platform fee configuration when present', async () => {
      const result = await service.getActivePlatformFee();
      expect(result).toBeDefined();
      expect(result.serviceCharge.value).toBe(2.50);
      expect(result.convenienceFee.value).toBe(2.00);
      expect(result.gst.value).toBe(18.00);
      expect(result.totalPlatformFees).toBe(5.31);
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

  describe('calculateTotalPlatformFees', () => {
    it('calculates total correctly for ₹2.50 service charge, ₹2.00 convenience fee and 18% GST', () => {
      const total = service.calculateTotalPlatformFees({
        serviceCharge: 2.50,
        convenienceFee: 2.00,
        gst: 18,
      });
      // baseCharges = 4.50, gstAmount = 0.81, total = 5.31
      expect(total).toBe(5.31);
    });

    it('calculates total when service charge or convenience fee is zero', () => {
      const total = service.calculateTotalPlatformFees({
        serviceCharge: 0,
        convenienceFee: 0,
        gst: 18,
      });
      expect(total).toBe(0);
    });
  });

  describe('calculatePlatformFee', () => {
    it('calculates fixed platform fee correctly', () => {
      const fee = service.calculatePlatformFee({
        feeType: 'fixed',
        feeValue: 50,
        baseAmount: 1000,
      });
      expect(fee).toBe(50);
    });

    it('calculates percentage platform fee correctly', () => {
      const fee = service.calculatePlatformFee({
        feeType: 'percentage',
        feeValue: 5,
        baseAmount: 1000,
      });
      expect(fee).toBe(50);
    });

    it('rejects percentage fee greater than 100', () => {
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'percentage',
          feeValue: 150,
          baseAmount: 1000,
        });
      }).toThrow(ValidationError);
    });

    it('rejects negative feeValue', () => {
      expect(() => {
        service.calculatePlatformFee({
          feeType: 'fixed',
          feeValue: -10,
          baseAmount: 1000,
        });
      }).toThrow(ValidationError);
    });
  });

  describe('updatePlatformFee', () => {
    it('rejects negative serviceCharge', async () => {
      await expect(
        service.updatePlatformFee({
          serviceCharge: -1,
          convenienceFee: 2,
          gst: 18,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects negative convenienceFee', async () => {
      await expect(
        service.updatePlatformFee({
          serviceCharge: 2.5,
          convenienceFee: -10,
          gst: 18,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects GST greater than 100', async () => {
      await expect(
        service.updatePlatformFee({
          serviceCharge: 2.5,
          convenienceFee: 2.0,
          gst: 150,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects negative GST', async () => {
      await expect(
        service.updatePlatformFee({
          serviceCharge: 2.5,
          convenienceFee: 2.0,
          gst: -5,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects non-numeric string values', async () => {
      await expect(
        service.updatePlatformFee({
          serviceCharge: 'abc',
          convenienceFee: 2.0,
          gst: 18,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('validates 3-component payload and delegates to repository', async () => {
      mockRepo.updateActiveCharges.mockResolvedValue({
        previous: ACTIVE_RECORD,
        current: {
          ...ACTIVE_RECORD,
          serviceCharge: { ...ACTIVE_RECORD.serviceCharge, value: 3.0 },
        },
      });

      await service.updatePlatformFee(
        {
          serviceCharge: 3.0,
          convenienceFee: 2.0,
          gst: 18,
        },
        'a0000001-0000-4000-a000-000000000001',
      );

      expect(mockRepo.updateActiveCharges).toHaveBeenCalledWith(
        {
          serviceCharge: 3.0,
          convenienceFee: 2.0,
          gst: 18,
          adminId: 'a0000001-0000-4000-a000-000000000001',
        },
        null,
      );
    });
  });
});
