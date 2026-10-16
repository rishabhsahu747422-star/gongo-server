'use strict';

const RatingRepository = require('../repositories/rating.repository');
const { ForbiddenError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class RatingService {
  constructor() {
    this.ratingRepository = new RatingRepository();
  }

  /**
   * Retrieves overall partner rating summary (average, count, 1-5 star distribution).
   *
   * @param {string} partnerId
   * @returns {Promise<object>}
   */
  async getPartnerSummary(partnerId) {
    if (!partnerId) {
      throw new ForbiddenError('Partner identity required', ERROR_CODES.UNAUTHORIZED);
    }
    return this.ratingRepository.getPartnerSummary(partnerId);
  }

  /**
   * Retrieves vehicle-specific rating summary.
   *
   * @param {string} partnerId
   * @param {string} vehicleId
   * @returns {Promise<object>}
   */
  async getVehicleSummary(partnerId, vehicleId) {
    if (!partnerId || !vehicleId) {
      throw new ForbiddenError('Partner identity and vehicle ID required', ERROR_CODES.UNAUTHORIZED);
    }
    return this.ratingRepository.getVehicleSummary(partnerId, vehicleId);
  }

  /**
   * Retrieves vehicle ratings overview across all partner vehicles.
   *
   * @param {string} partnerId
   * @returns {Promise<Array<object>>}
   */
  async getVehicleRatingsOverview(partnerId) {
    if (!partnerId) {
      throw new ForbiddenError('Partner identity required', ERROR_CODES.UNAUTHORIZED);
    }
    return this.ratingRepository.getVehicleRatingsOverview(partnerId);
  }

  /**
   * Retrieves paginated reviews and ratings history.
   *
   * @param {string} partnerId
   * @param {object} options
   * @returns {Promise<object>}
   */
  async getReviews(partnerId, options) {
    if (!partnerId) {
      throw new ForbiddenError('Partner identity required', ERROR_CODES.UNAUTHORIZED);
    }
    return this.ratingRepository.getPartnerReviews(partnerId, options);
  }

  /**
   * Internal/Testing/Future helper to submit rating from completed booking.
   *
   * @param {object} params
   * @returns {Promise<object>}
   */
  async submitRating(params) {
    return this.ratingRepository.createRating(params);
  }
}

module.exports = new RatingService();
