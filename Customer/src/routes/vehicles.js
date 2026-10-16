'use strict';

const express = require('express');
const vehicleController = require('../controllers/vehicle.controller');
const {
  validateVehicleSearch,
  validateNearbySearch,
  validateVehicleId,
} = require('../validators/vehicle.validator');

const router = express.Router();

/**
 * Vehicle Discovery Routes — /api/v1/vehicles
 *
 * All endpoints are PUBLIC (no authentication required).
 * Authentication is required only for booking/wishlist operations (later steps).
 *
 * IMPORTANT: Static routes (/categories, /cities, /nearby) MUST be defined
 * BEFORE the /:vehicleId dynamic route to prevent Express from treating
 * 'categories', 'cities', and 'nearby' as vehicleId values.
 */

/**
 * @route   GET /api/v1/vehicles/categories
 * @desc    List all active vehicle categories (BIKE, CAR)
 * @access  Public
 */
router.get(
  '/categories',
  (req, res, next) => vehicleController.getCategories(req, res, next),
);

/**
 * @route   GET /api/v1/vehicles/cities
 * @desc    List cities that have at least one active, eligible vehicle
 * @access  Public
 */
router.get(
  '/cities',
  (req, res, next) => vehicleController.getCities(req, res, next),
);

/**
 * @route   GET /api/v1/vehicles/nearby
 * @desc    Discover vehicles near a geographic coordinate
 * @query   latitude, longitude, radius (km, max 100), page, limit
 * @access  Public
 */
router.get(
  '/nearby',
  validateNearbySearch,
  (req, res, next) => vehicleController.getNearbyVehicles(req, res, next),
);

/**
 * @route   GET /api/v1/vehicles
 * @desc    Browse and search vehicles with optional filters and pagination
 * @query   city, category, brand, shop, fuelType, transmission,
 *          minPrice, maxPrice, minRating, sort, page, limit
 * @access  Public
 */
router.get(
  '/',
  validateVehicleSearch,
  (req, res, next) => vehicleController.listVehicles(req, res, next),
);

/**
 * @route   GET /api/v1/vehicles/:vehicleId
 * @desc    Get full public details for a single vehicle
 * @access  Public
 */
router.get(
  '/:vehicleId',
  validateVehicleId,
  (req, res, next) => vehicleController.getVehicleById(req, res, next),
);

module.exports = router;
