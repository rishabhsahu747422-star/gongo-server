'use strict';

const availabilityRepository = require('../repositories/availability.repository');
const vehicleRepository = require('../repositories/vehicle.repository');
const auditService = require('./audit.service');
const pool = require('../db/pool');
const { NotFoundError, ConflictError } = require('../errors');

function formatBlock(b) {
  if (!b) return null;
  return {
    id: b.id,
    vehicleId: b.vehicle_id,
    startTime: b.start_time,
    endTime: b.end_time,
    reason: b.reason,
    isActive: b.is_active,
    createdBy: b.created_by,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

class AvailabilityService {
  /**
   * Get availability blocks for a vehicle.
   *
   * @param {object} params
   * @param {string} params.vehicleId
   * @param {string} params.partnerId
   * @param {object} [params.options]
   * @returns {Promise<Array<object>>}
   */
  async getVehicleAvailability({ vehicleId, partnerId, options = {} }) {
    const vehicle = await vehicleRepository.findByIdAndPartnerId(vehicleId, partnerId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found or does not belong to partner');
    }

    const blocks = await availabilityRepository.findBlocksByVehicleId(vehicleId, options);
    return blocks.map(formatBlock);
  }

  /**
   * Create an availability block for a vehicle with concurrency locking and overlap check.
   *
   * @param {object} params
   * @param {string} params.vehicleId
   * @param {string} params.partnerId
   * @param {object} params.blockData
   * @param {string} [params.actorId]
   * @param {string} [params.requestId]
   * @returns {Promise<object>}
   */
  async createAvailabilityBlock({ vehicleId, partnerId, blockData, actorId, requestId }) {
    return pool.transaction(async (client) => {
      const vehicle = await vehicleRepository.findByIdAndPartnerIdForUpdate(
        vehicleId,
        partnerId,
        client,
      );
      if (!vehicle) {
        throw new NotFoundError('Vehicle not found or does not belong to partner');
      }

      if (vehicle.is_archived) {
        throw new ConflictError('Cannot manage availability for an archived vehicle');
      }

      // Check for overlap with existing active blocks
      const overlapping = await availabilityRepository.findOverlappingBlocks(
        vehicleId,
        blockData.startTime,
        blockData.endTime,
        null,
        client,
      );

      if (overlapping) {
        throw new ConflictError('Vehicle availability block overlaps with an existing active block');
      }

      const created = await availabilityRepository.createBlock(
        {
          vehicleId,
          partnerId,
          startTime: blockData.startTime,
          endTime: blockData.endTime,
          reason: blockData.reason,
          isActive: true,
          createdBy: actorId || partnerId,
        },
        client,
      );

      auditService.logEvent({
        actorId: actorId || partnerId,
        actorRole: 'PARTNER',
        action: 'VEHICLE_AVAILABILITY_BLOCKED',
        entityType: 'VEHICLE_AVAILABILITY',
        entityId: created.id,
        requestId,
        metadata: {
          vehicleId,
          startTime: created.start_time,
          endTime: created.end_time,
          reason: created.reason,
        },
      });

      return formatBlock(created);
    });
  }

  /**
   * Update an availability block.
   *
   * @param {object} params
   * @param {string} params.blockId
   * @param {string} params.vehicleId
   * @param {string} params.partnerId
   * @param {object} params.updates
   * @param {string} [params.actorId]
   * @param {string} [params.requestId]
   * @returns {Promise<object>}
   */
  async updateAvailabilityBlock({ blockId, vehicleId, partnerId, updates, actorId, requestId }) {
    return pool.transaction(async (client) => {
      const vehicle = await vehicleRepository.findByIdAndPartnerIdForUpdate(
        vehicleId,
        partnerId,
        client,
      );
      if (!vehicle) {
        throw new NotFoundError('Vehicle not found or does not belong to partner');
      }

      const existingBlock = await availabilityRepository.findBlockByIdAndVehicleId(
        blockId,
        vehicleId,
        client,
      );
      if (!existingBlock) {
        throw new NotFoundError('Availability block not found');
      }

      if (updates.startTime || updates.endTime) {
        const newStartTime = updates.startTime || existingBlock.start_time;
        const newEndTime = updates.endTime || existingBlock.end_time;

        const overlapping = await availabilityRepository.findOverlappingBlocks(
          vehicleId,
          newStartTime,
          newEndTime,
          blockId,
          client,
        );

        if (overlapping) {
          throw new ConflictError('Vehicle availability block overlaps with an existing active block');
        }
      }

      const updated = await availabilityRepository.updateBlock(blockId, vehicleId, updates, client);

      auditService.logEvent({
        actorId: actorId || partnerId,
        actorRole: 'PARTNER',
        action: 'VEHICLE_AVAILABILITY_UPDATED',
        entityType: 'VEHICLE_AVAILABILITY',
        entityId: blockId,
        requestId,
        metadata: {
          vehicleId,
          updates,
        },
      });

      return formatBlock(updated);
    });
  }

  /**
   * Remove / deactivate an availability block.
   *
   * @param {object} params
   * @param {string} params.blockId
   * @param {string} params.vehicleId
   * @param {string} params.partnerId
   * @param {string} [params.actorId]
   * @param {string} [params.requestId]
   * @returns {Promise<object>}
   */
  async deleteAvailabilityBlock({ blockId, vehicleId, partnerId, actorId, requestId }) {
    return pool.transaction(async (client) => {
      const vehicle = await vehicleRepository.findByIdAndPartnerIdForUpdate(
        vehicleId,
        partnerId,
        client,
      );
      if (!vehicle) {
        throw new NotFoundError('Vehicle not found or does not belong to partner');
      }

      const existingBlock = await availabilityRepository.findBlockByIdAndVehicleId(
        blockId,
        vehicleId,
        client,
      );
      if (!existingBlock) {
        throw new NotFoundError('Availability block not found');
      }

      await availabilityRepository.deactivateBlock(blockId, vehicleId, client);

      auditService.logEvent({
        actorId: actorId || partnerId,
        actorRole: 'PARTNER',
        action: 'VEHICLE_AVAILABILITY_UNBLOCKED',
        entityType: 'VEHICLE_AVAILABILITY',
        entityId: blockId,
        requestId,
        metadata: {
          vehicleId,
          startTime: existingBlock.start_time,
          endTime: existingBlock.end_time,
        },
      });

      return {
        message: 'Availability block removed successfully',
        blockId,
      };
    });
  }
}

module.exports = new AvailabilityService();
