'use strict';

const adminVehicleService = require('../services/admin-vehicle.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminVehicleController {
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
   * GET /api/v1/admin/vehicles
   * Lists vehicles with search, filtering, and bounded pagination.
   */
  async listVehicles(req, res, next) {
    try {
      const data = await adminVehicleService.listVehicles(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/vehicles/:id
   * Retrieves single vehicle detail with partner info and operational summaries.
   */
  async getVehicleDetail(req, res, next) {
    try {
      const data = await adminVehicleService.getVehicleDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/vehicles/:id/status
   * Updates vehicle status fields (manualStatus, offlineReason, isArchived) with safety guards.
   */
  async updateVehicleStatus(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'vehicles.update');
      const data = await adminVehicleService.updateVehicleStatus(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/vehicles/:id/verification
   * Updates vehicle verification status directly with reason.
   */
  async updateVehicleVerification(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'vehicles.verify');
      const data = await adminVehicleService.updateVehicleVerification(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/vehicles/:id/approve
   * Approves vehicle verification.
   */
  async approveVehicle(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'vehicles.verify');
      const data = await adminVehicleService.approveVehicle(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/vehicles/:id/reject
   * Rejects vehicle verification with required reason.
   */
  async rejectVehicle(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'vehicles.verify');
      const data = await adminVehicleService.rejectVehicle(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/vehicles/:id/documents
   */
  async getVehicleDocuments(req, res, next) {
    try {
      const data = await adminVehicleService.getVehicleDocuments(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/vehicles/:id/documents/:documentId
   */
  async getVehicleDocumentDetail(req, res, next) {
    try {
      const data = await adminVehicleService.getVehicleDocumentDetail(req.params.id, req.params.documentId);
      return sendSuccess(res, data.document);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/vehicles/:id/images
   */
  async getVehicleImages(req, res, next) {
    try {
      const data = await adminVehicleService.getVehicleImages(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/vehicles/:id/bookings
   */
  async getVehicleBookings(req, res, next) {
    try {
      const data = await adminVehicleService.getVehicleBookings(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/vehicles/:id/availability
   */
  async getVehicleAvailability(req, res, next) {
    try {
      const data = await adminVehicleService.getVehicleAvailability(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/vehicles/:id/pricing
   */
  async getVehiclePricing(req, res, next) {
    try {
      const data = await adminVehicleService.getVehiclePricing(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/vehicles/:id/earnings
   */
  async getVehicleEarnings(req, res, next) {
    try {
      const data = await adminVehicleService.getVehicleEarnings(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/vehicles/:id/block
   */
  async blockVehicle(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'vehicles.update');
      const data = await adminVehicleService.blockVehicle(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data.vehicle, data.message);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/vehicles/:id/activate
   */
  async activateVehicle(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'vehicles.update');
      const data = await adminVehicleService.activateVehicle(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data.vehicle, data.message);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/vehicles/:id/deactivate
   */
  async deactivateVehicle(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'vehicles.update');
      const data = await adminVehicleService.deactivateVehicle(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data.vehicle, data.message);
    } catch (err) {
      return next(err);
    }
  }
  /**
   * GET /api/v1/admin/vehicles/:id/history
   */
  async getVehicleHistory(req, res, next) {
    try {
      const data = await adminVehicleService.getVehicleHistory(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminVehicleController();
