'use strict';

const BookingRepository = require('../repositories/booking.repository');
const { ConflictError, NotFoundError, BadRequestError, ForbiddenError } = require('../errors');

const bookingRepository = new BookingRepository();

/**
 * AvailabilityService — centralized service for vehicle rental availability.
 *
 * Enforces:
 *   1. Static vehicle listing eligibility (active vehicle + active shop + approved/active partner)
 *   2. Dynamic booking schedule availability (no overlapping active bookings in [startAt, endAt))
 *
 * Interval logic uses half-open intervals [startAt, endAt) plus a 1-hour post-rental
 * grace period (existing booking blocks until end_at + 1 hour):
 *   After a [10:00, 12:00) booking, [12:00, 14:00) is unavailable and [13:00, 15:00) is available.
 */
class AvailabilityService {
  /**
   * Asserts vehicle listing eligibility across discovery, pricing quotes, and bookings.
   * Checks:
   *   - Vehicle exists
   *   - Partner is NOT suspended (throws 403 ForbiddenError)
   *   - Vehicle status in ACTIVE, AVAILABLE, or PENDING (with verification)
   *   - Active shop
   *   - Approved/verified and active partner
   *
   * @param {object} vehicle
   * @throws {NotFoundError|ForbiddenError|BadRequestError}
   */
  assertVehicleEligibility(vehicle) {
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', 'VEHICLE_NOT_FOUND');
    }

    // Partner suspension enforcement — source of truth rejection
    const partnerLifecycle = (vehicle.partner_lifecycle_status || '').toLowerCase();
    const partnerOperational = (vehicle.partner_operational_status || '').toUpperCase();
    if (
      partnerLifecycle === 'suspended' ||
      partnerLifecycle === 'deactivated' ||
      partnerLifecycle === 'rejected' ||
      partnerOperational === 'SUSPENDED' ||
      (vehicle.partner_active !== undefined && vehicle.partner_active !== null && !vehicle.partner_active)
    ) {
      throw new ForbiddenError(
        'Partner is currently suspended and cannot accept new bookings.',
        'PARTNER_SUSPENDED',
      );
    }

    const vStatus = (vehicle.listing_status || vehicle.status || '').toUpperCase();
    if (vStatus !== 'ACTIVE' && vStatus !== 'AVAILABLE' && vStatus !== 'PENDING') {
      throw new BadRequestError('Vehicle is not currently available for booking', 'VEHICLE_NOT_ACTIVE');
    }

    // Direct check on administrative marketplace deactivation
    const manualStatus = (vehicle.manual_status || vehicle.manualStatus || '').toUpperCase();
    // is_active = false is the admin block/deactivate hold (Admin BLOCK keeps is_archived false).
    // Only an explicit false blocks; NULL/undefined (column absent in legacy rows) is treated as active.
    if (
      manualStatus === 'OFFLINE'
      || vehicle.is_archived === true || vehicle.isArchived === true
      || vehicle.is_active === false || vehicle.isActive === false
    ) {
      throw new BadRequestError('Vehicle is currently deactivated by administrator', 'VEHICLE_DEACTIVATED');
    }

    const verificationStatus = (vehicle.verification_status || vehicle.verificationStatus || '').toUpperCase();
    if (verificationStatus === 'REJECTED' || verificationStatus === 'SUSPENDED') {
      throw new BadRequestError('Vehicle is currently deactivated by administrator', 'VEHICLE_DEACTIVATED');
    }

    if (vehicle.shop_active !== undefined && vehicle.shop_active !== null && !vehicle.shop_active) {
      throw new BadRequestError('Vehicle shop is currently inactive', 'SHOP_NOT_ACTIVE');
    }

    const pStatus = (vehicle.partner_status || '').toLowerCase();
    if (vehicle.partner_status !== undefined && (pStatus !== 'approved' && pStatus !== 'verified')) {
      throw new BadRequestError('Vehicle partner is not eligible for booking', 'PARTNER_NOT_ELIGIBLE');
    }

    return true;
  }

  /**
   * Check if a vehicle is available for rental between startAt and endAt.
   *
   * @param {string} vehicleId
   * @param {string|Date} startAt
   * @param {string|Date} endAt
   * @param {object} [client] - Optional transactional client
   * @returns {Promise<{isAvailable: boolean, reason?: string}>}
   */
  async checkAvailability(vehicleId, startAt, endAt, client = null) {
    // 1. Check vehicle listing eligibility
    const vehicle = await bookingRepository.findVehicleEligibility(vehicleId, client);
    if (!vehicle) {
      return {
        isAvailable: false,
        reason: 'Vehicle is not listed or not eligible for rent',
      };
    }

    try {
      this.assertVehicleEligibility(vehicle);
    } catch {
      return {
        isAvailable: false,
        reason: 'Vehicle is not listed or not eligible for rent',
      };
    }

    // 2. Check for overlapping blocking bookings
    const overlap = await bookingRepository.findOverlappingBooking(
      vehicleId,
      startAt,
      endAt,
      client,
    );

    if (overlap) {
      return {
        isAvailable: false,
        reason: 'Vehicle is already reserved for the selected dates/times',
      };
    }

    return {
      isAvailable: true,
    };
  }

  /**
   * Asserts availability, throwing ConflictError or NotFoundError if unavailable.
   * Used during booking creation inside transactions.
   *
   * @param {string} vehicleId
   * @param {string|Date} startAt
   * @param {string|Date} endAt
   * @param {object} [client]
   * @returns {Promise<void>}
   */
  async assertAvailable(vehicleId, startAt, endAt, client = null) {
    const overlap = await bookingRepository.findOverlappingBooking(
      vehicleId,
      startAt,
      endAt,
      client,
    );

    if (overlap) {
      throw new ConflictError(
        'Vehicle is unavailable for the selected dates/times',
        'BOOKING_VEHICLE_UNAVAILABLE',
      );
    }
  }
}

module.exports = new AvailabilityService();
