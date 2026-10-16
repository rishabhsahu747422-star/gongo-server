'use strict';

const adminCouponService = require('../services/admin-coupon.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminCouponController {
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

  async listCoupons(req, res, next) {
    try {
      const data = await adminCouponService.listCoupons(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getCouponDetail(req, res, next) {
    try {
      const data = await adminCouponService.getCouponDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getCouponRedemptions(req, res, next) {
    try {
      const data = await adminCouponService.getCouponRedemptions(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async createCoupon(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'coupons.create');
      const data = await adminCouponService.createCoupon(req.body, auditCtx);
      return sendSuccess(res, data, 201);
    } catch (err) {
      return next(err);
    }
  }

  async updateCoupon(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'coupons.update');
      const data = await adminCouponService.updateCoupon(req.params.id, req.body, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async deleteCoupon(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'coupons.delete');
      const data = await adminCouponService.deleteCoupon(req.params.id, auditCtx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminCouponController();
