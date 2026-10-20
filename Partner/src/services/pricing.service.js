'use strict';

const pricingRepository = require('../repositories/pricing.repository');
const vehicleRepository = require('../repositories/vehicle.repository');
const auditService = require('./audit.service');
const pool = require('../db/pool');
const { NotFoundError, ConflictError } = require('../errors');

function formatPricing(p) {
  if (!p) return null;
  const price3Hours = p.price_3_hours !== null && p.price_3_hours !== undefined
    ? Number(p.price_3_hours)
    : (p.price3Hours !== null && p.price3Hours !== undefined ? Number(p.price3Hours) : null);
  const price6Hours = p.price_6_hours !== null && p.price_6_hours !== undefined
    ? Number(p.price_6_hours)
    : (p.price6Hours !== null && p.price6Hours !== undefined ? Number(p.price6Hours) : null);
  const price12Hours = p.price_12_hours !== null && p.price_12_hours !== undefined
    ? Number(p.price_12_hours)
    : (p.price12Hours !== null && p.price12Hours !== undefined ? Number(p.price12Hours) : null);

  const kmLimitPerDay = p.km_limit_per_day !== null && p.km_limit_per_day !== undefined
    ? Number(p.km_limit_per_day)
    : (p.kmLimitPerDay !== null && p.kmLimitPerDay !== undefined ? Number(p.kmLimitPerDay) : null);
  const kmLimitPerHour = p.km_limit_per_hour !== null && p.km_limit_per_hour !== undefined
    ? Number(p.km_limit_per_hour)
    : (p.kmLimitPerHour !== null && p.kmLimitPerHour !== undefined ? Number(p.kmLimitPerHour) : null);
  const kmLimit3Hours = p.km_limit_3_hours !== null && p.km_limit_3_hours !== undefined
    ? Number(p.km_limit_3_hours)
    : (p.kmLimit3Hours !== null && p.kmLimit3Hours !== undefined ? Number(p.kmLimit3Hours) : null);
  const kmLimit6Hours = p.km_limit_6_hours !== null && p.km_limit_6_hours !== undefined
    ? Number(p.km_limit_6_hours)
    : (p.kmLimit6Hours !== null && p.kmLimit6Hours !== undefined ? Number(p.kmLimit6Hours) : null);
  const kmLimit12Hours = p.km_limit_12_hours !== null && p.km_limit_12_hours !== undefined
    ? Number(p.km_limit_12_hours)
    : (p.kmLimit12Hours !== null && p.kmLimit12Hours !== undefined ? Number(p.kmLimit12Hours) : null);

  return {
    id: p.id,
    vehicleId: p.vehicle_id,
    pricePerHour: Number(p.price_per_hour || 0),
    price3Hours,
    price6Hours,
    price12Hours,
    pricePer4Hours: Number(p.price_per_4_hours || 0),
    pricePerDay: Number(p.price_per_day || 0),
    price_per_hour: Number(p.price_per_hour || 0),
    price_3_hours: price3Hours,
    price_6_hours: price6Hours,
    price_12_hours: price12Hours,
    price_per_4_hours: Number(p.price_per_4_hours || 0),
    price_per_day: Number(p.price_per_day || 0),
    kmLimitPerDay,
    kmLimitPerHour,
    kmLimit3Hours,
    kmLimit6Hours,
    kmLimit12Hours,
    km_limit_per_day: kmLimitPerDay,
    km_limit_per_hour: kmLimitPerHour,
    km_limit_3_hours: kmLimit3Hours,
    km_limit_6_hours: kmLimit6Hours,
    km_limit_12_hours: kmLimit12Hours,
    securityDeposit: Number(p.security_deposit || 0),
    extraKmCharge: Number(p.extra_km_charge || 0),
    currency: p.currency,
    isActive: p.is_active,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

class PricingService {
  /**
   * Get active pricing configuration for a vehicle.
   *
   * @param {object} params
   * @param {string} params.vehicleId
   * @param {string} params.partnerId
   * @returns {Promise<object>}
   */
  async getVehiclePricing({ vehicleId, partnerId }) {
    const vehicle = await vehicleRepository.findByIdAndPartnerId(vehicleId, partnerId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found or does not belong to partner');
    }

    const pricing = await pricingRepository.findByVehicleId(vehicleId);
    if (!pricing) {
      return {
        id: null,
        vehicleId,
        pricePerHour: 0.00,
        price3Hours: null,
        price6Hours: null,
        price12Hours: null,
        pricePer4Hours: 0.00,
        pricePerDay: 0.00,
        price_per_hour: 0.00,
        price_3_hours: null,
        price_6_hours: null,
        price_12_hours: null,
        price_per_day: 0.00,
        kmLimitPerDay: null,
        kmLimitPerHour: null,
        kmLimit3Hours: null,
        kmLimit6Hours: null,
        kmLimit12Hours: null,
        km_limit_per_day: null,
        km_limit_per_hour: null,
        km_limit_3_hours: null,
        km_limit_6_hours: null,
        km_limit_12_hours: null,
        securityDeposit: 0.00,
        extraKmCharge: 0.00,
        currency: 'INR',
        isActive: true,
        createdAt: null,
        updatedAt: null,
      };
    }

    return formatPricing(pricing);
  }

  /**
   * Upsert vehicle pricing with concurrency locking and immutable history tracking.
   *
   * @param {object} params
   * @param {string} params.vehicleId
   * @param {string} params.partnerId
   * @param {object} params.pricingData
   * @param {string} [params.actorId]
   * @param {string} [params.changedBy] - users.id of the actor, recorded on the history row
   * @param {string} [params.requestId]
   * @returns {Promise<object>}
   */
  async updateVehiclePricing({
    vehicleId, partnerId, pricingData, actorId, changedBy, requestId,
  }) {
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
        throw new ConflictError('Cannot modify pricing for an archived vehicle');
      }

      const existing = await pricingRepository.findByVehicleId(vehicleId, client);

      // Close open history record if previous pricing existed
      if (existing) {
        await pricingRepository.closeOpenHistoryRecord(vehicleId, new Date().toISOString(), client);
      }

      // Upsert current pricing
      const updated = await pricingRepository.upsertPricing(vehicleId, pricingData, client);

      // Record in immutable history
      await pricingRepository.createHistoryRecord(
        {
          vehicleId,
          pricePerHour: updated.price_per_hour,
          price3Hours: updated.price_3_hours,
          price6Hours: updated.price_6_hours,
          price12Hours: updated.price_12_hours,
          pricePer4Hours: updated.price_per_4_hours,
          pricePerDay: updated.price_per_day,
          kmLimitPerDay: updated.km_limit_per_day,
          kmLimitPerHour: updated.km_limit_per_hour,
          kmLimit3Hours: updated.km_limit_3_hours,
          kmLimit6Hours: updated.km_limit_6_hours,
          kmLimit12Hours: updated.km_limit_12_hours,
          securityDeposit: updated.security_deposit,
          extraKmCharge: updated.extra_km_charge,
          validFrom: new Date().toISOString(),
          validTo: null,
          changedBy: changedBy || null,
        },
        client,
      );

      auditService.logEvent({
        actorId: actorId || partnerId,
        actorRole: 'PARTNER',
        action: 'VEHICLE_PRICING_UPDATED',
        entityType: 'VEHICLE_PRICING',
        entityId: updated.id,
        requestId,
        metadata: {
          vehicleId,
          registrationNumber: vehicle.registration_number,
          previousPricing: existing
            ? {
              pricePerHour: Number(existing.price_per_hour),
              price3Hours: existing.price_3_hours !== null && existing.price_3_hours !== undefined ? Number(existing.price_3_hours) : null,
              price6Hours: existing.price_6_hours !== null && existing.price_6_hours !== undefined ? Number(existing.price_6_hours) : null,
              price12Hours: existing.price_12_hours !== null && existing.price_12_hours !== undefined ? Number(existing.price_12_hours) : null,
              pricePer4Hours: Number(existing.price_per_4_hours),
              pricePerDay: Number(existing.price_per_day),
              kmLimitPerDay: existing.km_limit_per_day !== null && existing.km_limit_per_day !== undefined ? Number(existing.km_limit_per_day) : null,
              kmLimitPerHour: existing.km_limit_per_hour !== null && existing.km_limit_per_hour !== undefined ? Number(existing.km_limit_per_hour) : null,
              kmLimit3Hours: existing.km_limit_3_hours !== null && existing.km_limit_3_hours !== undefined ? Number(existing.km_limit_3_hours) : null,
              kmLimit6Hours: existing.km_limit_6_hours !== null && existing.km_limit_6_hours !== undefined ? Number(existing.km_limit_6_hours) : null,
              kmLimit12Hours: existing.km_limit_12_hours !== null && existing.km_limit_12_hours !== undefined ? Number(existing.km_limit_12_hours) : null,
              securityDeposit: Number(existing.security_deposit),
              extraKmCharge: Number(existing.extra_km_charge),
            }
            : null,
          newPricing: {
            pricePerHour: Number(updated.price_per_hour),
            price3Hours: updated.price_3_hours !== null && updated.price_3_hours !== undefined ? Number(updated.price_3_hours) : null,
            price6Hours: updated.price_6_hours !== null && updated.price_6_hours !== undefined ? Number(updated.price_6_hours) : null,
            price12Hours: updated.price_12_hours !== null && updated.price_12_hours !== undefined ? Number(updated.price_12_hours) : null,
            pricePer4Hours: Number(updated.price_per_4_hours),
            pricePerDay: Number(updated.price_per_day),
            kmLimitPerDay: updated.km_limit_per_day !== null && updated.km_limit_per_day !== undefined ? Number(updated.km_limit_per_day) : null,
            kmLimitPerHour: updated.km_limit_per_hour !== null && updated.km_limit_per_hour !== undefined ? Number(updated.km_limit_per_hour) : null,
            kmLimit3Hours: updated.km_limit_3_hours !== null && updated.km_limit_3_hours !== undefined ? Number(updated.km_limit_3_hours) : null,
            kmLimit6Hours: updated.km_limit_6_hours !== null && updated.km_limit_6_hours !== undefined ? Number(updated.km_limit_6_hours) : null,
            kmLimit12Hours: updated.km_limit_12_hours !== null && updated.km_limit_12_hours !== undefined ? Number(updated.km_limit_12_hours) : null,
            securityDeposit: Number(updated.security_deposit),
            extraKmCharge: Number(updated.extra_km_charge),
          },
        },
      });

      return formatPricing(updated);
    });
  }

  /**
   * Get pricing change history for a vehicle.
   *
   * @param {object} params
   * @param {string} params.vehicleId
   * @param {string} params.partnerId
   * @param {object} [params.options]
   * @returns {Promise<Array<object>>}
   */
  async getPricingHistory({ vehicleId, partnerId, options = {} }) {
    const vehicle = await vehicleRepository.findByIdAndPartnerId(vehicleId, partnerId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found or does not belong to partner');
    }

    const history = await pricingRepository.getPricingHistory(vehicleId, options);
    return history.map((h) => ({
      id: h.id,
      vehicleId: h.vehicle_id,
      pricePerHour: Number(h.price_per_hour),
      price3Hours: h.price_3_hours !== null && h.price_3_hours !== undefined ? Number(h.price_3_hours) : null,
      price6Hours: h.price_6_hours !== null && h.price_6_hours !== undefined ? Number(h.price_6_hours) : null,
      price12Hours: h.price_12_hours !== null && h.price_12_hours !== undefined ? Number(h.price_12_hours) : null,
      pricePer4Hours: Number(h.price_per_4_hours),
      pricePerDay: Number(h.price_per_day),
      kmLimitPerDay: h.km_limit_per_day !== null && h.km_limit_per_day !== undefined ? Number(h.km_limit_per_day) : null,
      kmLimitPerHour: h.km_limit_per_hour !== null && h.km_limit_per_hour !== undefined ? Number(h.km_limit_per_hour) : null,
      kmLimit3Hours: h.km_limit_3_hours !== null && h.km_limit_3_hours !== undefined ? Number(h.km_limit_3_hours) : null,
      kmLimit6Hours: h.km_limit_6_hours !== null && h.km_limit_6_hours !== undefined ? Number(h.km_limit_6_hours) : null,
      kmLimit12Hours: h.km_limit_12_hours !== null && h.km_limit_12_hours !== undefined ? Number(h.km_limit_12_hours) : null,
      km_limit_per_day: h.km_limit_per_day !== null && h.km_limit_per_day !== undefined ? Number(h.km_limit_per_day) : null,
      km_limit_per_hour: h.km_limit_per_hour !== null && h.km_limit_per_hour !== undefined ? Number(h.km_limit_per_hour) : null,
      km_limit_3_hours: h.km_limit_3_hours !== null && h.km_limit_3_hours !== undefined ? Number(h.km_limit_3_hours) : null,
      km_limit_6_hours: h.km_limit_6_hours !== null && h.km_limit_6_hours !== undefined ? Number(h.km_limit_6_hours) : null,
      km_limit_12_hours: h.km_limit_12_hours !== null && h.km_limit_12_hours !== undefined ? Number(h.km_limit_12_hours) : null,
      securityDeposit: Number(h.security_deposit),
      extraKmCharge: Number(h.extra_km_charge),
      validFrom: h.valid_from,
      validTo: h.valid_to,
      changedBy: h.changed_by || null,
      createdAt: h.created_at,
    }));
  }
}

module.exports = new PricingService();
