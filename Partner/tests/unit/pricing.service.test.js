'use strict';

const pricingService = require('../../src/services/pricing.service');
const pricingRepository = require('../../src/repositories/pricing.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const auditService = require('../../src/services/audit.service');
const pool = require('../../src/db/pool');
const { NotFoundError, ConflictError } = require('../../src/errors');

describe('Unit: PricingService', () => {
  const partnerId = '11111111-1111-1111-1111-111111111111';
  const vehicleId = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getVehiclePricing', () => {
    it('returns formatted pricing when record exists', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
      });

      jest.spyOn(pricingRepository, 'findByVehicleId').mockResolvedValue({
        id: 'price-123',
        vehicle_id: vehicleId,
        price_per_hour: '150.00',
        price_per_4_hours: '550.00',
        price_per_day: '2400.00',
        security_deposit: '5000.00',
        extra_km_charge: '15.00',
        currency: 'INR',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await pricingService.getVehiclePricing({ vehicleId, partnerId });
      expect(res.vehicleId).toBe(vehicleId);
      expect(res.pricePerHour).toBe(150);
      expect(res.pricePer4Hours).toBe(550);
      expect(res.pricePerDay).toBe(2400);
      expect(res.securityDeposit).toBe(5000);
      expect(res.extraKmCharge).toBe(15);
      expect(res.currency).toBe('INR');
      expect(res.isActive).toBe(true);
    });

    it('returns default zero pricing when vehicle exists but no pricing row exists yet', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
      });
      jest.spyOn(pricingRepository, 'findByVehicleId').mockResolvedValue(null);

      const res = await pricingService.getVehiclePricing({ vehicleId, partnerId });
      expect(res.vehicleId).toBe(vehicleId);
      expect(res.pricePerHour).toBe(0);
      expect(res.pricePerDay).toBe(0);
      expect(res.securityDeposit).toBe(0);
    });

    it('throws NotFoundError when vehicle does not belong to partner (BOLA protection)', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      await expect(
        pricingService.getVehiclePricing({ vehicleId, partnerId }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateVehiclePricing', () => {
    it('atomically updates pricing and closes previous open history record', async () => {
      const mockClient = {};
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb(mockClient));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        registration_number: 'MP 04 AB 1234',
        is_archived: false,
      });

      jest.spyOn(pricingRepository, 'findByVehicleId').mockResolvedValue({
        id: 'price-prev',
        vehicle_id: vehicleId,
        price_per_hour: '100.00',
        price_per_4_hours: '400.00',
        price_per_day: '1500.00',
        security_deposit: '3000.00',
        extra_km_charge: '10.00',
      });

      const closeSpy = jest.spyOn(pricingRepository, 'closeOpenHistoryRecord').mockResolvedValue({});
      const upsertSpy = jest.spyOn(pricingRepository, 'upsertPricing').mockResolvedValue({
        id: 'price-new',
        vehicle_id: vehicleId,
        price_per_hour: 140,
        price_per_4_hours: 500,
        price_per_day: 2200,
        security_deposit: 4000,
        extra_km_charge: 14,
        currency: 'INR',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const historySpy = jest.spyOn(pricingRepository, 'createHistoryRecord').mockResolvedValue({});
      const auditSpy = jest.spyOn(auditService, 'logEvent').mockImplementation(() => {});

      const pricingData = {
        pricePerHour: 140,
        pricePer4Hours: 500,
        pricePerDay: 2200,
        securityDeposit: 4000,
        extraKmCharge: 14,
        currency: 'INR',
        isActive: true,
      };

      const res = await pricingService.updateVehiclePricing({
        vehicleId,
        partnerId,
        pricingData,
        actorId: partnerId,
        changedBy: 'user-1',
        requestId: 'req-1',
      });

      expect(closeSpy).toHaveBeenCalledWith(vehicleId, expect.any(String), mockClient);
      expect(upsertSpy).toHaveBeenCalledWith(vehicleId, pricingData, mockClient);
      expect(historySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          vehicleId,
          pricePerDay: 2200,
          validTo: null,
          changedBy: 'user-1',
        }),
        mockClient,
      );
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'VEHICLE_PRICING_UPDATED',
          entityId: 'price-new',
        }),
      );
      expect(res.pricePerDay).toBe(2200);
      expect(res.pricePerHour).toBe(140);
    });

    it('throws ConflictError when attempting to price an archived vehicle', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        is_archived: true,
      });

      await expect(
        pricingService.updateVehiclePricing({
          vehicleId,
          partnerId,
          pricingData: { pricePerDay: 1000 },
        }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('getPricingHistory', () => {
    it('returns mapped history rows for authorized partner', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
      });

      jest.spyOn(pricingRepository, 'getPricingHistory').mockResolvedValue([
        {
          id: 'hist-1',
          vehicle_id: vehicleId,
          price_per_hour: '140.00',
          price_per_4_hours: '500.00',
          price_per_day: '2200.00',
          security_deposit: '4000.00',
          extra_km_charge: '14.00',
          valid_from: '2026-09-20T10:00:00Z',
          valid_to: null,
          changed_by: 'user-1',
          created_at: '2026-09-20T10:00:00Z',
        },
      ]);

      const history = await pricingService.getPricingHistory({ vehicleId, partnerId });
      expect(history).toHaveLength(1);
      expect(history[0].pricePerDay).toBe(2200);
      expect(history[0].validTo).toBeNull();
      expect(history[0].changedBy).toBe('user-1');
    });

    it('returns null changedBy for legacy rows without an actor', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
      });
      jest.spyOn(pricingRepository, 'getPricingHistory').mockResolvedValue([
        {
          id: 'hist-legacy',
          vehicle_id: vehicleId,
          price_per_hour: '100.00',
          price_per_4_hours: '400.00',
          price_per_day: '1600.00',
          security_deposit: '3000.00',
          extra_km_charge: '10.00',
          valid_from: '2026-08-01T10:00:00Z',
          valid_to: '2026-09-20T10:00:00Z',
          created_at: '2026-08-01T10:00:00Z',
        },
      ]);

      const history = await pricingService.getPricingHistory({ vehicleId, partnerId });
      expect(history[0].changedBy).toBeNull();
    });
  });
});
