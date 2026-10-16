'use strict';

const adminNotificationService = require('../services/admin-notification.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminNotificationController {
  constructor() {
    this.listNotifications = this.listNotifications.bind(this);
    this.getNotificationById = this.getNotificationById.bind(this);
    this.getNotificationStatus = this.getNotificationStatus.bind(this);
    this.listTemplates = this.listTemplates.bind(this);
    this.getTemplateById = this.getTemplateById.bind(this);
    this.createTemplate = this.createTemplate.bind(this);
    this.updateTemplate = this.updateTemplate.bind(this);
    this.activateTemplate = this.activateTemplate.bind(this);
    this.deactivateTemplate = this.deactivateTemplate.bind(this);
    this.sendNotification = this.sendNotification.bind(this);
    this.retryNotification = this.retryNotification.bind(this);
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
   * GET /api/v1/admin/notifications
   */
  async listNotifications(req, res, next) {
    try {
      const data = await adminNotificationService.listNotifications(req.query);
      return sendSuccess(res, data.items, { pagination: data.pagination });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/notifications/:id
   */
  async getNotificationById(req, res, next) {
    try {
      const data = await adminNotificationService.getNotificationById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/notifications/:id/status
   */
  async getNotificationStatus(req, res, next) {
    try {
      const data = await adminNotificationService.getNotificationStatus(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/notifications/templates
   */
  async listTemplates(req, res, next) {
    try {
      const data = await adminNotificationService.listTemplates(req.query);
      return sendSuccess(res, data.items, { pagination: data.pagination });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/notifications/templates/:id
   */
  async getTemplateById(req, res, next) {
    try {
      const data = await adminNotificationService.getTemplateById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/notifications/templates
   */
  async createTemplate(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'notifications.manage');
      const data = await adminNotificationService.createTemplate(
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, null, 201);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/notifications/templates/:id
   */
  async updateTemplate(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'notifications.manage');
      const data = await adminNotificationService.updateTemplate(
        req.params.id,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/notifications/templates/:id/activate
   */
  async activateTemplate(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'notifications.manage');
      const data = await adminNotificationService.activateTemplate(
        req.params.id,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/notifications/templates/:id/deactivate
   */
  async deactivateTemplate(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'notifications.manage');
      const data = await adminNotificationService.deactivateTemplate(
        req.params.id,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/notifications/send
   * Also handles alias POST /api/v1/admin/notifications
   */
  async sendNotification(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'notifications.send');
      const data = await adminNotificationService.sendNotification(
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, null, 201);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/notifications/:id/send
   */
  async retryNotification(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'notifications.send');
      const data = await adminNotificationService.retryNotification(
        req.params.id,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminNotificationController();
