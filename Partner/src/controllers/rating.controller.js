'use strict';

const ratingService = require('../services/rating.service');
const { sendSuccess } = require('../utils/response');
const { ForbiddenError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class RatingController {
  /**
   * GET /api/v1/partner/ratings/summary
   * Overall partner rating summary and distribution.
   */
  async getSummary(req, res, next) {
    try {
      const summary = await ratingService.getPartnerSummary(req.user.partnerId);
      sendSuccess(res, summary, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/ratings
   * Paginated list of reviews & ratings received by the partner.
   */
  async getReviews(req, res, next) {
    try {
      const {
        page = 1,
        limit = 10,
        vehicleId = null,
        score = null,
        hasComment = false,
      } = req.query;

      const result = await ratingService.getReviews(req.user.partnerId, {
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 10,
        vehicleId: vehicleId ? String(vehicleId).trim() : null,
        score: score ? parseInt(score, 10) : null,
        hasComment: String(hasComment).toLowerCase() === 'true',
      });

      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/ratings/vehicles
   * Vehicle-wise ratings overview for all partner's vehicles.
   */
  async getVehicleRatingsOverview(req, res, next) {
    try {
      const vehicles = await ratingService.getVehicleRatingsOverview(req.user.partnerId);
      sendSuccess(res, { vehicles }, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/ratings/vehicles/:vehicleId
   * Vehicle-specific rating summary.
   */
  async getVehicleSummary(req, res, next) {
    try {
      const { vehicleId } = req.params;
      const summary = await ratingService.getVehicleSummary(req.user.partnerId, vehicleId);
      sendSuccess(res, summary, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Disallows partner mutation of ratings.
   */
  rejectPartnerMutation(req, res, next) {
    next(new ForbiddenError(
      'Partners cannot create, alter or delete their own received ratings',
      ERROR_CODES.FORBIDDEN_ACTION,
    ));
  }
}

module.exports = new RatingController();
