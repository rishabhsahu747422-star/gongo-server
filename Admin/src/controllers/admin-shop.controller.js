'use strict';

const adminShopService = require('../services/admin-shop.service');
const { sendSuccess } = require('../utils/response');

class AdminShopController {
  async listShops(req, res, next) {
    try {
      const data = await adminShopService.listShops(req.query);
      return sendSuccess(res, data.shops, data.pagination, 200);
    } catch (err) {
      return next(err);
    }
  }

  async getShopDetail(req, res, next) {
    try {
      const data = await adminShopService.getShopDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getShopDocuments(req, res, next) {
    try {
      const data = await adminShopService.getShopDocuments(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getShopImages(req, res, next) {
    try {
      const data = await adminShopService.getShopImages(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getShopOperatingHours(req, res, next) {
    try {
      const data = await adminShopService.getShopOperatingHours(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async verifyShop(req, res, next) {
    try {
      const data = await adminShopService.verifyShop(req.params.id, req.body, req.user);
      return sendSuccess(res, data.shop, data.message);
    } catch (err) {
      return next(err);
    }
  }

  async rejectShop(req, res, next) {
    try {
      const data = await adminShopService.rejectShop(req.params.id, req.body, req.user);
      return sendSuccess(res, data.shop, data.message);
    } catch (err) {
      return next(err);
    }
  }

  async suspendShop(req, res, next) {
    try {
      const data = await adminShopService.suspendShop(req.params.id, req.body, req.user);
      return sendSuccess(res, data.shop, data.message);
    } catch (err) {
      return next(err);
    }
  }

  async reactivateShop(req, res, next) {
    try {
      const data = await adminShopService.reactivateShop(req.params.id, req.body, req.user);
      return sendSuccess(res, data.shop, data.message);
    } catch (err) {
      return next(err);
    }
  }

  async updateShopStatus(req, res, next) {
    try {
      const data = await adminShopService.updateShopStatus(req.params.id, {
        ...req.body,
        adminId: req.user ? req.user.id : 'admin',
      });
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getShopVehicles(req, res, next) {
    try {
      const data = await adminShopService.getShopVehicles(req.params.id, req.query);
      return sendSuccess(res, data.vehicles, 'Shop vehicles retrieved successfully', 200, data.pagination);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminShopController();
