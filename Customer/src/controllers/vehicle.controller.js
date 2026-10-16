'use strict';

const vehicleService = require('../services/vehicle.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * VehicleController — thin HTTP adapter for vehicle discovery.
 *
 * SECURITY:
 *   - userId/partnerId are NEVER read from req.params, req.query, or req.body.
 *   - All query parameters arrive pre-validated via req.vehicleQuery or
 *     req.nearbyQuery (set by vehicle.validator middleware).
 *   - Listing eligibility is enforced in the service/repository layer.
 *   - Controller never constructs SQL or handles raw DB values.
 *
 * NOTE: Vehicle discovery endpoints are PUBLIC (no authentication required).
 * Authentication is only required for booking/wishlist operations (later steps).
 */
class VehicleController {
  /**
   * GET /api/v1/vehicles
   * Browse/search vehicles with optional filters, sort, and pagination.
   */
  async listVehicles(req, res, next) {
    try {
      const result = await vehicleService.searchVehicles(req.vehicleQuery);
      return sendSuccess(res, result, 'Vehicles retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/vehicles/categories
   * Return all active vehicle categories (BIKE, CAR).
   */
  async getCategories(req, res, next) {
    try {
      const categories = await vehicleService.getCategories();
      return sendSuccess(res, { categories }, 'Categories retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/vehicles/cities
   * Return cities that have at least one active, eligible vehicle.
   */
  async getCities(req, res, next) {
    try {
      const cities = await vehicleService.getCitiesWithVehicles();
      return sendSuccess(res, { cities }, 'Cities retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/vehicles/nearby
   * Discover vehicles near a geographic coordinate.
   * Distance is calculated server-side — never trusted from client.
   */
  async getNearbyVehicles(req, res, next) {
    try {
      const result = await vehicleService.getNearbyVehicles(req.nearbyQuery);
      return sendSuccess(res, result, 'Nearby vehicles retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/vehicles/:vehicleId
   * Get full public details for a single vehicle.
   * Returns 404 for non-existent, non-active, or ineligible vehicles.
   */
  async getVehicleById(req, res, next) {
    try {
      const vehicle = await vehicleService.getVehicleById(req.params.vehicleId);
      return sendSuccess(res, { vehicle }, 'Vehicle retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new VehicleController();
