'use strict';

const adminVerificationService = require('../services/admin-verification.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');
const logger = require('../config/logger');

class AdminVerificationController {
  constructor() {
    this.listPartnerVerifications = this.listPartnerVerifications.bind(this);
    this.getPartnerVerificationDetail = this.getPartnerVerificationDetail.bind(this);
    this.approvePartner = this.approvePartner.bind(this);
    this.rejectPartner = this.rejectPartner.bind(this);

    this.listVehicleVerifications = this.listVehicleVerifications.bind(this);
    this.getVehicleVerificationDetail = this.getVehicleVerificationDetail.bind(this);
    this.approveVehicle = this.approveVehicle.bind(this);
    this.rejectVehicle = this.rejectVehicle.bind(this);

    this.getDocumentDetail = this.getDocumentDetail.bind(this);
    this.getDocumentSignedUrl = this.getDocumentSignedUrl.bind(this);
    this.approveDocument = this.approveDocument.bind(this);
    this.rejectDocument = this.rejectDocument.bind(this);

    this.listKyc = this.listKyc.bind(this);
  }

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

  // ── Partner Verification Handlers ──────────────────────────────────────────

  /**
   * GET /api/v1/admin/verifications/partners
   * Lists partners with verification/KYC status, search, and bounded pagination.
   */
  async listPartnerVerifications(req, res, next) {
    try {
      const data = await adminVerificationService.listPartnerVerifications(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/verifications/partners/:id
   * Retrieves partner verification detail with owner info and list of partner documents.
   */
  async getPartnerVerificationDetail(req, res, next) {
    try {
      const data = await adminVerificationService.getPartnerVerificationDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/verifications/partners/:id/approve
   * Approves partner verification (KYC) with audit logging.
   */
  async approvePartner(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'kyc.verify');
      const data = await adminVerificationService.approvePartner(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data, 'Partner verification approved successfully');
    } catch (err) {
      logger.error('Admin verification approvePartner controller failure', {
        operation: 'approvePartner',
        partnerId: req.params?.id,
        requestId: req.id || (res.locals && res.locals.requestId) || null,
        errorCode: err.code || err.statusCode || 'UNKNOWN_ERROR',
        error: err.message,
      });
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/verifications/partners/:id/reject
   * Rejects partner verification with mandatory reason and audit logging.
   */
  async rejectPartner(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'kyc.reject');
      const data = await adminVerificationService.rejectPartner(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data, 'Partner verification rejected successfully');
    } catch (err) {
      logger.error('Admin verification rejectPartner controller failure', {
        operation: 'rejectPartner',
        partnerId: req.params?.id,
        requestId: req.id || (res.locals && res.locals.requestId) || null,
        errorCode: err.code || err.statusCode || 'UNKNOWN_ERROR',
        error: err.message,
      });
      return next(err);
    }
  }

  // ── Vehicle Verification Handlers ──────────────────────────────────────────

  /**
   * GET /api/v1/admin/verifications/vehicles
   * Lists vehicles with verification status, search, and bounded pagination.
   */
  async listVehicleVerifications(req, res, next) {
    try {
      const data = await adminVerificationService.listVehicleVerifications(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/verifications/vehicles/:id
   * Retrieves vehicle verification detail with partner info, documents, and images.
   */
  async getVehicleVerificationDetail(req, res, next) {
    try {
      const data = await adminVerificationService.getVehicleVerificationDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/verifications/vehicles/:id/approve
   * Approves vehicle verification with audit logging.
   */
  async approveVehicle(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'kyc.verify');
      const data = await adminVerificationService.approveVehicle(
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
   * POST /api/v1/admin/verifications/vehicles/:id/reject
   * Rejects vehicle verification with mandatory reason and audit logging.
   */
  async rejectVehicle(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'kyc.reject');
      const data = await adminVerificationService.rejectVehicle(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  // ── Document Verification Handlers ─────────────────────────────────────────

  /**
   * GET /api/v1/admin/verifications/documents/:id
   * Retrieves document metadata from either partner_documents or vehicle_documents.
   */
  async getDocumentDetail(req, res, next) {
    try {
      const data = await adminVerificationService.getDocumentDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/verifications/documents/:id/url
   * Generates a short-lived presigned GET URL for authorized document preview/download.
   */
  async getDocumentSignedUrl(req, res, next) {
    try {
      const data = await adminVerificationService.getDocumentSignedUrl(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/verifications/documents/:id/approve
   * Approves an individual document (partner or vehicle document) with audit trail.
   */
  async approveDocument(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'kyc.verify');
      const data = await adminVerificationService.approveDocument(
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
   * POST /api/v1/admin/verifications/documents/:id/reject
   * Rejects an individual document with mandatory reason and audit trail.
   */
  async rejectDocument(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'kyc.reject');
      const data = await adminVerificationService.rejectDocument(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  // ── Vehicle Image Verification Handlers (Step 11) ──────────────────────────

  /**
   * GET /api/v1/admin/verifications/vehicle-images/:id
   * Retrieves vehicle image metadata including verification status.
   */
  async getVehicleImageDetail(req, res, next) {
    try {
      const data = await adminVerificationService.getVehicleImageDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/verifications/vehicle-images/:id/url
   * Generates a short-lived presigned GET URL for authorized vehicle image preview.
   */
  async getVehicleImageSignedUrl(req, res, next) {
    try {
      const data = await adminVerificationService.getVehicleImageSignedUrl(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/verifications/vehicle-images/:id/approve
   * Approves an individual vehicle image with audit trail.
   */
  async approveVehicleImage(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'vehicles.verify');
      const data = await adminVerificationService.approveVehicleImage(
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
   * POST /api/v1/admin/verifications/vehicle-images/:id/reject
   * Rejects an individual vehicle image with mandatory reason and audit trail.
   */
  async rejectVehicleImage(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'vehicles.verify');
      const data = await adminVerificationService.rejectVehicleImage(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  // ── Unified KYC Listing Handler ────────────────────────────────────────────

  /**
   * GET /api/v1/admin/verifications/kyc
   * Unified KYC queue across partners and vehicles with filters and bounded pagination.
   */
  async listKyc(req, res, next) {
    try {
      const data = await adminVerificationService.listKyc(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminVerificationController();
