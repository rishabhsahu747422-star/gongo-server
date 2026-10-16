'use strict';

const adminStorageService = require('../services/admin-storage.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminStorageController {
  constructor(storageService = adminStorageService) {
    this.storageService = storageService;

    this.listDocuments = this.listDocuments.bind(this);
    this.getDocumentDetail = this.getDocumentDetail.bind(this);
    this.getDocumentSignedUrl = this.getDocumentSignedUrl.bind(this);
    this.previewDocument = this.previewDocument.bind(this);
    this.downloadDocument = this.downloadDocument.bind(this);
    this.createUploadUrl = this.createUploadUrl.bind(this);
    this.createDownloadUrl = this.createDownloadUrl.bind(this);
    this.getDocumentHistory = this.getDocumentHistory.bind(this);
    this.getPartnerDocuments = this.getPartnerDocuments.bind(this);
    this.getVehicleDocuments = this.getVehicleDocuments.bind(this);
    this.getCustomerDocuments = this.getCustomerDocuments.bind(this);
  }

  /**
   * POST /api/v1/admin/storage/upload-url
   * Generates a temporary presigned upload URL for direct storage upload.
   */
  async createUploadUrl(req, res, next) {
    try {
      const { bucket, path, fileName, contentType } = req.body || {};
      const ctx = this._buildAuditContext(req, res, 'storage.document.upload');
      const data = await this.storageService.createUploadUrl({ bucket, path, fileName, contentType }, ctx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/storage/download-url
   * Generates a temporary presigned download URL for direct storage download.
   */
  async createDownloadUrl(req, res, next) {
    try {
      const { bucket, path, expiresIn } = req.body || {};
      const ctx = this._buildAuditContext(req, res, 'storage.document.access');
      const data = await this.storageService.createDownloadUrl({ bucket, path, expiresIn }, ctx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

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
   * GET /api/v1/admin/storage/documents
   * Lists administrative documents with rich filters, search, and pagination.
   */
  async listDocuments(req, res, next) {
    try {
      const data = await this.storageService.listDocuments(req.query);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/storage/documents/:id
   * Retrieves single document detail with safe metadata and verification status.
   */
  async getDocumentDetail(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'storage.read');
      const data = await this.storageService.getDocumentDetail(req.params.id, ctx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/storage/documents/:id/url
   * Generates a temporary signed S3 GET URL for authorized document access.
   */
  async getDocumentSignedUrl(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'storage.document.access');
      const data = await this.storageService.getDocumentSignedUrl(req.params.id, ctx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/storage/documents/:id/preview
   * Generates a temporary signed GET URL configured for inline browser preview.
   */
  async previewDocument(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'storage.document.access');
      const data = await this.storageService.previewDocument(req.params.id, ctx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/storage/documents/:id/download
   * Generates a temporary signed GET URL configured with attachment filename download.
   */
  async downloadDocument(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'storage.document.access');
      const data = await this.storageService.downloadDocument(req.params.id, ctx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/storage/documents/:id/history
   * Retrieves chronological administrative history for a document.
   */
  async getDocumentHistory(req, res, next) {
    try {
      const data = await this.storageService.getDocumentHistory(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/storage/partners/:partnerId/documents
   * Retrieves documents belonging to a specific partner.
   */
  async getPartnerDocuments(req, res, next) {
    try {
      const data = await this.storageService.getPartnerDocuments(req.params.partnerId, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/storage/vehicles/:vehicleId/documents
   * Retrieves documents belonging to a specific vehicle.
   */
  async getVehicleDocuments(req, res, next) {
    try {
      const data = await this.storageService.getVehicleDocuments(req.params.vehicleId, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/storage/customers/:customerId/documents
   * Retrieves documents belonging to a specific customer.
   */
  async getCustomerDocuments(req, res, next) {
    try {
      const data = await this.storageService.getCustomerDocuments(req.params.customerId, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

const instance = new AdminStorageController();
instance.AdminStorageController = AdminStorageController;

module.exports = instance;
