'use strict';

const adminAuditService = require('../services/admin-audit.service');
const { sendSuccess } = require('../utils/response');

class AdminAuditController {
  constructor(auditService = adminAuditService) {
    this.auditService = auditService;

    this.listAudit = this.listAudit.bind(this);
    this.getAuditDetail = this.getAuditDetail.bind(this);
    this.getActionsCatalog = this.getActionsCatalog.bind(this);
    this.getSecurityEvents = this.getSecurityEvents.bind(this);
    this.getAuditByAdmin = this.getAuditByAdmin.bind(this);
    this.getAuditByResource = this.getAuditByResource.bind(this);
    this.getSecuritySummary = this.getSecuritySummary.bind(this);
  }

  /**
   * GET /api/v1/admin/audit
   * Lists administrative audit actions with filtering, search, and pagination.
   */
  async listAudit(req, res, next) {
    try {
      const data = await this.auditService.listAudit(req.query);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/audit/:id
   * Retrieves single audit record detail by UUID.
   */
  async getAuditDetail(req, res, next) {
    try {
      const data = await this.auditService.getAuditDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/audit/actions
   * Returns distinct actions, target resources, and security categories catalog.
   */
  async getActionsCatalog(req, res, next) {
    try {
      const data = await this.auditService.getDistinctActions();
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/audit/security
   * GET /api/v1/admin/security/events
   * Returns security-classified audit events with pagination and filters.
   */
  async getSecurityEvents(req, res, next) {
    try {
      const data = await this.auditService.getSecurityEvents(req.query);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/audit/admin/:adminId
   * Returns audit actions performed by a specific administrator.
   */
  async getAuditByAdmin(req, res, next) {
    try {
      const data = await this.auditService.getAuditByAdmin(req.params.adminId, req.query);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/audit/resource/:resourceType/:resourceId
   * Returns chronological audit trail for a specific resource entity.
   */
  async getAuditByResource(req, res, next) {
    try {
      const data = await this.auditService.getAuditByResource(
        req.params.resourceType,
        req.params.resourceId,
        req.query,
      );
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/security/summary
   * Computes operational security summary metrics across a bounded time window.
   */
  async getSecuritySummary(req, res, next) {
    try {
      const data = await this.auditService.getSecuritySummary(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

const instance = new AdminAuditController();
instance.AdminAuditController = AdminAuditController;

module.exports = instance;
