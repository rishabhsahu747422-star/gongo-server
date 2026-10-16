'use strict';

const franchiseService = require('../services/franchise.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class FranchiseController {
  /**
   * Helper to build audit context from request state.
   */
  _buildAuditContext(req, res, permission) {
    return {
      actorId: req.user ? req.user.id : 'unknown-admin',
      actorRole: req.user ? req.user.role : 'ADMIN',
      permission,
      audit: req.audit || null,
      requestId: req.id || (res.locals && res.locals.requestId) || null,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    };
  }

  /**
   * Public POST /api/v1/public/franchise-applications
   */
  async submitApplication(req, res, next) {
    try {
      const clientIp = getClientIp(req);
      const data = await franchiseService.submitApplication(req.sanitizedFranchise, clientIp);
      return sendSuccess(res, data, 'Thank you for your franchise application. Our team will review your application and contact you shortly.', 201);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Admin GET /api/v1/admin/franchise-applications
   */
  async listApplications(req, res, next) {
    try {
      const data = await franchiseService.listApplications(req.sanitizedQuery);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Admin GET /api/v1/admin/franchise-applications/:id
   */
  async getApplicationById(req, res, next) {
    try {
      const data = await franchiseService.getApplicationById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Admin PATCH /api/v1/admin/franchise-applications/:id/status
   */
  async updateStatus(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'franchise.update');
      const data = await franchiseService.updateApplicationStatus(
        req.params.id,
        req.sanitizedStatusUpdate,
        auditCtx,
      );
      return sendSuccess(res, data, 'Franchise application status updated successfully');
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new FranchiseController();
