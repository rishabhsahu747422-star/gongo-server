'use strict';

const adminOfferService = require('../services/admin-offer.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminOfferController {
  _buildAuditContext(req, res, permission) {
    return {
      actorId: req.user ? req.user.id : 'unknown-admin',
      actorRole: req.user ? req.user.role : 'ADMIN',
      permission,
      requestId: req.id || (res.locals && res.locals.requestId) || null,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    };
  }

  async listOffers(req, res, next) {
    try {
      const data = await adminOfferService.listOffers(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getOfferDetail(req, res, next) {
    try {
      const data = await adminOfferService.getOfferDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async createOffer(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'offers.create');
      const data = await adminOfferService.createOffer(req.body, auditCtx);
      return sendSuccess(res, data, 201);
    } catch (err) {
      return next(err);
    }
  }

  async updateOffer(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'offers.update');
      const data = await adminOfferService.updateOffer(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async deleteOffer(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'offers.delete');
      const data = await adminOfferService.deleteOffer(req.params.id, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async addVehicleToOffer(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'offers.update');
      const vehicleId = req.body.vehicleId || req.body.vehicle_id;
      const data = await adminOfferService.addVehicleToOffer(req.params.id, vehicleId, auditCtx);
      return sendSuccess(res, data, 201);
    } catch (err) {
      return next(err);
    }
  }

  async removeVehicleFromOffer(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'offers.update');
      const data = await adminOfferService.removeVehicleFromOffer(req.params.id, req.params.vehicleId, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async addShopToOffer(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'offers.update');
      const shopId = req.body.shopId || req.body.shop_id;
      const data = await adminOfferService.addShopToOffer(req.params.id, shopId, auditCtx);
      return sendSuccess(res, data, 201);
    } catch (err) {
      return next(err);
    }
  }

  async removeShopFromOffer(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'offers.update');
      const data = await adminOfferService.removeShopFromOffer(req.params.id, req.params.shopId, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminOfferController();
