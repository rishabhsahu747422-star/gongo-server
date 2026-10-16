'use strict';

const adminReviewService = require('../services/admin-review.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminReviewController {
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

  async listReviews(req, res, next) {
    try {
      const data = await adminReviewService.listReviews(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getReviewById(req, res, next) {
    try {
      const data = await adminReviewService.getReviewById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async updateReviewStatus(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'reviews.update');
      const data = await adminReviewService.updateReviewStatus(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async listReviewReports(req, res, next) {
    try {
      const data = await adminReviewService.listReviewReports(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async resolveReviewReport(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'reviews.resolve_report');
      const data = await adminReviewService.resolveReviewReport(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminReviewController();
