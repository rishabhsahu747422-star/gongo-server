'use strict';

const adminPartnerService = require('../services/admin-partner.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminPartnerController {
  /**
   * Helper to build audit context from request state.
   * @private
   */
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

  /**
   * GET /api/v1/admin/partners
   */
  async listPartners(req, res, next) {
    try {
      const data = await adminPartnerService.listPartners(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/partners/:id
   */
  async getPartnerDetail(req, res, next) {
    try {
      const data = await adminPartnerService.getPartnerDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/partners/:id/status
   */
  async updatePartnerStatus(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'partners.update');
      const data = await adminPartnerService.updatePartnerStatus(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/partners/:id/approve
   */
  async approvePartner(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'partners.verify');
      const data = await adminPartnerService.approvePartner(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/partners/:id/reject
   */
  async rejectPartner(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'partners.verify');
      const data = await adminPartnerService.rejectPartner(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/partners/:id/documents
   */
  async getPartnerDocuments(req, res, next) {
    try {
      const data = await adminPartnerService.getPartnerDocuments(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/partners/:id/kyc
   */
  async getPartnerKyc(req, res, next) {
    try {
      const data = await adminPartnerService.getPartnerKyc(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/partners/:id/bank-accounts
   */
  async getPartnerBankAccounts(req, res, next) {
    try {
      const data = await adminPartnerService.getPartnerBankAccounts(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/partners/:id/shops
   */
  async getPartnerShops(req, res, next) {
    try {
      const data = await adminPartnerService.getPartnerShops(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/partners/:id/vehicles
   */
  async getPartnerVehicles(req, res, next) {
    try {
      const data = await adminPartnerService.getPartnerVehicles(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/partners/:id/bookings
   */
  async getPartnerBookings(req, res, next) {
    try {
      const data = await adminPartnerService.getPartnerBookings(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/partners/:id/earnings
   */
  async getPartnerEarnings(req, res, next) {
    try {
      const data = await adminPartnerService.getPartnerEarnings(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/partners/:id/verification-history
   */
  async getPartnerVerificationHistory(req, res, next) {
    try {
      const data = await adminPartnerService.getPartnerVerificationHistory(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/partners/:id/suspend
   */
  async suspendPartner(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'partners.update');
      const data = await adminPartnerService.suspendPartner(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data, 'Partner suspended successfully');
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/partners/:id/reactivate
   */
  async reactivatePartner(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'partners.update');
      const data = await adminPartnerService.reactivatePartner(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data, 'Partner reactivated successfully');
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminPartnerController();
