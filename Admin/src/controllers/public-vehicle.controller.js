'use strict';

const publicVehicleRepository = require('../repositories/public-vehicle.repository');
const { sendSuccess } = require('../utils/response');

class PublicVehicleController {
  async getCategories(req, res, next) {
    try {
      const categories = await publicVehicleRepository.getCategories();
      return sendSuccess(res, { categories }, 'Vehicle categories retrieved successfully');
    } catch (err) {
      return next(err);
    }
  }

  async getCities(req, res, next) {
    try {
      const cities = await publicVehicleRepository.getCities();
      return sendSuccess(res, { cities }, 'Operational cities retrieved successfully');
    } catch (err) {
      return next(err);
    }
  }

  async searchVehicles(req, res, next) {
    try {
      const data = await publicVehicleRepository.searchVehicles(req.sanitizedSearchQuery);
      return sendSuccess(res, data, 'Vehicles retrieved successfully');
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new PublicVehicleController();
