'use strict';

const availabilityService = require('../../src/services/availability.service');
const availabilityRepository = require('../../src/repositories/availability.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const auditService = require('../../src/services/audit.service');
const pool = require('../../src/db/pool');
const { NotFoundError, ConflictError } = require('../../src/errors');

describe('Unit: AvailabilityService', () => {
  const partnerId = '11111111-1111-1111-1111-111111111111';
  const vehicleId = '22222222-2222-2222-2222-222222222222';
  const blockId = '33333333-3333-3333-3333-333333333333';

  const startTime = new Date(Date.now() + 86400000).toISOString();
  const endTime = new Date(Date.now() + 2 * 86400000).toISOString();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getVehicleAvailability', () => {
    it('returns formatted availability blocks for vehicle', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
      });

      jest.spyOn(availabilityRepository, 'findBlocksByVehicleId').mockResolvedValue([
        {
          id: blockId,
          vehicle_id: vehicleId,
          start_time: startTime,
          end_time: endTime,
          reason: 'Maintenance',
          is_active: true,
          created_by: partnerId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);

      const res = await availabilityService.getVehicleAvailability({ vehicleId, partnerId });
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe(blockId);
      expect(res[0].reason).toBe('Maintenance');
    });

    it('throws NotFoundError when vehicle does not belong to partner (BOLA)', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      await expect(
        availabilityService.getVehicleAvailability({ vehicleId, partnerId }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('createAvailabilityBlock', () => {
    it('creates block and emits audit log when no overlap exists', async () => {
      const mockClient = {};
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb(mockClient));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        is_archived: false,
      });

      jest.spyOn(availabilityRepository, 'findOverlappingBlocks').mockResolvedValue(null);

      jest.spyOn(availabilityRepository, 'createBlock').mockResolvedValue({
        id: blockId,
        vehicle_id: vehicleId,
        start_time: startTime,
        end_time: endTime,
        reason: 'Service',
        is_active: true,
        created_by: partnerId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const auditSpy = jest.spyOn(auditService, 'logEvent').mockImplementation(() => {});

      const res = await availabilityService.createAvailabilityBlock({
        vehicleId,
        partnerId,
        blockData: { startTime, endTime, reason: 'Service' },
        actorId: partnerId,
      });

      expect(res.id).toBe(blockId);
      expect(res.reason).toBe('Service');
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'VEHICLE_AVAILABILITY_BLOCKED',
          entityId: blockId,
        }),
      );
    });

    it('throws ConflictError when candidate block overlaps with existing active block', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        is_archived: false,
      });

      jest.spyOn(availabilityRepository, 'findOverlappingBlocks').mockResolvedValue({
        id: 'existing-block-id',
      });

      await expect(
        availabilityService.createAvailabilityBlock({
          vehicleId,
          partnerId,
          blockData: { startTime, endTime, reason: 'Maintenance' },
        }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('updateAvailabilityBlock', () => {
    it('updates block and checks overlap when dates change', async () => {
      const mockClient = {};
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb(mockClient));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
      });

      jest.spyOn(availabilityRepository, 'findBlockByIdAndVehicleId').mockResolvedValue({
        id: blockId,
        vehicle_id: vehicleId,
        start_time: startTime,
        end_time: endTime,
        reason: 'Maintenance',
        is_active: true,
      });

      jest.spyOn(availabilityRepository, 'findOverlappingBlocks').mockResolvedValue(null);

      jest.spyOn(availabilityRepository, 'updateBlock').mockResolvedValue({
        id: blockId,
        vehicle_id: vehicleId,
        start_time: startTime,
        end_time: endTime,
        reason: 'Damage',
        is_active: true,
      });

      const res = await availabilityService.updateAvailabilityBlock({
        blockId,
        vehicleId,
        partnerId,
        updates: { reason: 'Damage' },
      });

      expect(res.reason).toBe('Damage');
    });

    it('throws ConflictError if update causes overlap', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
      });

      jest.spyOn(availabilityRepository, 'findBlockByIdAndVehicleId').mockResolvedValue({
        id: blockId,
        vehicle_id: vehicleId,
        start_time: startTime,
        end_time: endTime,
        is_active: true,
      });

      jest.spyOn(availabilityRepository, 'findOverlappingBlocks').mockResolvedValue({
        id: 'other-block',
      });

      await expect(
        availabilityService.updateAvailabilityBlock({
          blockId,
          vehicleId,
          partnerId,
          updates: { startTime },
        }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('deleteAvailabilityBlock', () => {
    it('deactivates block and emits audit log', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
      });

      jest.spyOn(availabilityRepository, 'findBlockByIdAndVehicleId').mockResolvedValue({
        id: blockId,
        vehicle_id: vehicleId,
        start_time: startTime,
        end_time: endTime,
      });

      jest.spyOn(availabilityRepository, 'deactivateBlock').mockResolvedValue({
        id: blockId,
        is_active: false,
      });

      const auditSpy = jest.spyOn(auditService, 'logEvent').mockImplementation(() => {});

      const res = await availabilityService.deleteAvailabilityBlock({
        blockId,
        vehicleId,
        partnerId,
      });

      expect(res.blockId).toBe(blockId);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'VEHICLE_AVAILABILITY_UNBLOCKED',
          entityId: blockId,
        }),
      );
    });
  });
});
