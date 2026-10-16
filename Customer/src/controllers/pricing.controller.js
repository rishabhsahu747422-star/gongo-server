'use strict';

const pricingService = require('../services/pricing.service');
const availabilityService = require('../services/availability.service');
const BookingRepository = require('../repositories/booking.repository');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');
const { NotFoundError, BadRequestError } = require('../errors');

const bookingRepository = new BookingRepository();

/**
 * PricingController — thin HTTP adapter for pricing and quotes.
 */
class PricingController {
  /**
   * POST /api/v1/pricing/quote
   */
  async getQuote(req, res, next) {
    try {
      const {
        vehicleId,
        rentalType,
        startAt,
        endAt,
        couponCode,
      } = req.body;

      const vehicle = await bookingRepository.findVehicleEligibility(vehicleId);
      if (!vehicle) {
        throw new NotFoundError('Vehicle not found', 'VEHICLE_NOT_FOUND');
      }

      // Canonical eligibility check
      availabilityService.assertVehicleEligibility(vehicle);

      // Interval availability check against overlapping bookings
      if (startAt && endAt) {
        await availabilityService.assertAvailable(vehicleId, startAt, endAt);
      }

      const quote = await pricingService.calculateQuote({
        vehicle,
        rentalType,
        startAt,
        endAt,
        customerId: req.user.id,
        couponCode: couponCode || null,
      });

      return sendSuccess(res, { quote }, 'Pricing quote calculated successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new PricingController();
