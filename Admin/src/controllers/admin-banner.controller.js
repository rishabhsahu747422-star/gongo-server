'use strict';

const adminBannerService = require('../services/admin-banner.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminBannerController {
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

  async listBanners(req, res, next) {
    try {
      const data = await adminBannerService.listBanners(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getBannerDetail(req, res, next) {
    try {
      const data = await adminBannerService.getBannerDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async uploadAsset(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'banners.upload');
      let buffer = null;
      let filename = 'banner_asset';
      let assetType = req.body?.assetType || req.body?.asset_type;

      if (req.body?.fileBase64) {
        buffer = Buffer.from(req.body.fileBase64, 'base64');
        filename = req.body.filename || filename;
      } else if (req.body?.buffer) {
        buffer = Buffer.isBuffer(req.body.buffer) ? req.body.buffer : Buffer.from(req.body.buffer);
        filename = req.body.filename || filename;
      } else if (Buffer.isBuffer(req.body)) {
        buffer = req.body;
      }

      const data = await adminBannerService.uploadAsset(
        { buffer, filename, assetType },
        auditCtx,
      );
      return sendSuccess(res, data, null, 201);
    } catch (err) {
      return next(err);
    }
  }

  async createBanner(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'banners.create');
      const data = await adminBannerService.createBanner(req.body, auditCtx);
      return sendSuccess(res, data, null, 201);
    } catch (err) {
      return next(err);
    }
  }

  async updateBanner(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'banners.update');
      const data = await adminBannerService.updateBanner(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async updateStatus(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'banners.status');
      const isActive = req.body.isActive !== undefined ? req.body.isActive : req.body.is_active;
      const data = await adminBannerService.updateStatus(req.params.id, isActive, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async deleteBanner(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'banners.delete');
      const data = await adminBannerService.deleteBanner(req.params.id, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async reorderBanners(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'banners.update');
      const orderedIds = req.body.orderedIds || req.body.bannerIds;
      const data = await adminBannerService.reorderBanners(orderedIds, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async createBulk(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'banners.create');
      const banners = req.body?.banners || [];
      const data = await adminBannerService.createBulk(banners, auditCtx);
      return sendSuccess(res, data, 'Batch banners processed', 201);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminBannerController();
