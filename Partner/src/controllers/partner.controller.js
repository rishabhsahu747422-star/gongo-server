'use strict';

const partnerService = require('../services/partner.service');
const shopService = require('../services/shop.service');
const kycService = require('../services/kyc.service');
const partnerValidator = require('../validators/partner.validator');
const { sendSuccess } = require('../utils/response');

class PartnerController {
  /**
   * GET /api/v1/partner/profile
   */
  async getProfile(req, res, next) {
    try {
      const profile = await partnerService.getProfile(req.user.partnerId);
      sendSuccess(res, profile, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/partner/profile
   */
  async updateProfile(req, res, next) {
    try {
      const validated = partnerValidator.validateProfileUpdate(req.body);
      const updated = await partnerService.updateProfile(req.user.partnerId, validated, req.id);
      sendSuccess(res, updated, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/shop
   */
  async getShop(req, res, next) {
    try {
      const shop = await shopService.getShop(req.user.partnerId);
      sendSuccess(res, shop, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/partner/shop
   */
  async updateShop(req, res, next) {
    try {
      const validated = partnerValidator.validateShopUpdate(req.body);
      const updated = await shopService.updateShop(req.user.partnerId, validated, req.id);
      sendSuccess(res, updated, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/kyc
   */
  async getKyc(req, res, next) {
    try {
      const kycOverview = await kycService.getKycOverview(req.user.partnerId);
      sendSuccess(res, kycOverview, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/partner/kyc/documents
   */
  async submitKycDocument(req, res, next) {
    try {
      const validated = partnerValidator.validateKycDocument(req.body);
      const doc = await kycService.submitDocument(req.user.partnerId, validated, req.id);
      sendSuccess(res, doc, 201);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/kyc/documents/:id
   */
  async getKycDocumentById(req, res, next) {
    try {
      const doc = await kycService.getDocumentById(req.params.id, req.user.partnerId);
      sendSuccess(res, doc, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/dashboard/stats
   * GET /api/v1/partner/stats
   */
  async getDashboardStats(req, res, next) {
    try {
      const stats = await partnerService.getDashboardStats(req.user.partnerId);
      sendSuccess(res, stats, 200);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new PartnerController();
