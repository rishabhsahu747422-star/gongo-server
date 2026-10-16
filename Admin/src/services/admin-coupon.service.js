'use strict';

const adminCouponRepository = require('../repositories/admin-coupon.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const auditService = require('./audit.service');
const { ValidationError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class AdminCouponService {
  async listCoupons(query = {}) {
    return adminCouponRepository.listCoupons(query);
  }

  async getCouponDetail(id) {
    if (!id) {
      throw new ValidationError('Coupon ID is required');
    }
    const coupon = await adminCouponRepository.findCouponById(id);
    if (!coupon) {
      throw new NotFoundError('Coupon not found', ERROR_CODES.NOT_FOUND);
    }
    const rules = await adminCouponRepository.findCouponRules(id);
    return {
      coupon,
      rules,
    };
  }

  async getCouponRedemptions(id, query = {}) {
    if (!id) {
      throw new ValidationError('Coupon ID is required');
    }
    const coupon = await adminCouponRepository.findCouponById(id);
    if (!coupon) {
      throw new NotFoundError('Coupon not found', ERROR_CODES.NOT_FOUND);
    }
    return adminCouponRepository.findCouponRedemptions(id, query);
  }

  async createCoupon(data, auditContext = {}) {
    if (!data.code || typeof data.code !== 'string') {
      throw new ValidationError('Valid coupon code is required');
    }
    if (!data.name || typeof data.name !== 'string') {
      throw new ValidationError('Coupon name is required');
    }
    const discountType = (data.discount_type || data.discountType || 'percentage').toLowerCase();
    const discountVal = Number(data.discount_value !== undefined ? data.discount_value : data.discountValue);
    if (isNaN(discountVal) || discountVal <= 0) {
      throw new ValidationError('discount_value must be greater than 0');
    }
    if ((discountType === 'percentage' || discountType === '%') && discountVal > 100) {
      throw new ValidationError('Percentage discount cannot exceed 100%');
    }

    const validFrom = data.valid_from || data.validFrom || new Date().toISOString();
    const validUntil = data.valid_until || data.validUntil || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    if (new Date(validFrom) >= new Date(validUntil)) {
      throw new ValidationError('valid_from must be before valid_until');
    }

    const payload = {
      ...data,
      discount_value: discountVal,
      discount_type: discountType === 'flat' ? 'fixed' : discountType,
      valid_from: validFrom,
      valid_until: validUntil,
      created_by: auditContext.actorId || null,
    };

    let created;
    try {
      created = await adminCouponRepository.createCoupon(payload);
    } catch (err) {
      if (err.code === '23505') {
        throw new ValidationError(`Coupon code "${data.code.toUpperCase().trim()}" already exists`);
      }
      throw err;
    }

    try {
      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: 'coupons.create',
        action: 'COUPON_CREATED',
        targetResource: 'COUPON',
        targetResourceId: created.id,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        afterState: created,
        metadata: { code: created.code },
      });

      auditService.logAdminAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        action: 'COUPON_CREATED',
        targetResource: 'COUPON',
        targetResourceId: created.id,
        metadata: { code: created.code },
      });
    } catch (_) {
      // Audit failure must not fail the request
    }

    return { coupon: created };
  }

  async updateCoupon(id, updates = {}, auditContext = {}) {
    if (!id) {
      throw new ValidationError('Coupon ID is required');
    }
    const current = await adminCouponRepository.findCouponById(id);
    if (!current) {
      throw new NotFoundError('Coupon not found', ERROR_CODES.NOT_FOUND);
    }

    if (updates.valid_until && updates.valid_from) {
      if (new Date(updates.valid_from) >= new Date(updates.valid_until)) {
        throw new ValidationError('valid_from must be before valid_until');
      }
    }

    const updated = await adminCouponRepository.updateCoupon(id, updates);

    try {
      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: 'coupons.update',
        action: 'COUPON_UPDATED',
        targetResource: 'COUPON',
        targetResourceId: id,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState: current,
        afterState: updated,
        metadata: updates,
      });

      auditService.logAdminAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        action: 'COUPON_UPDATED',
        targetResource: 'COUPON',
        targetResourceId: id,
        metadata: updates,
      });
    } catch (_) {
      // Audit failure must not fail the request
    }

    return { coupon: updated };
  }

  async deleteCoupon(id, auditContext = {}) {
    if (!id) {
      throw new ValidationError('Coupon ID is required');
    }
    const current = await adminCouponRepository.findCouponById(id);
    if (!current) {
      throw new NotFoundError('Coupon not found', ERROR_CODES.NOT_FOUND);
    }

    const res = await adminCouponRepository.deleteCoupon(id);

    try {
      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: 'coupons.delete',
        action: 'COUPON_DELETED',
        targetResource: 'COUPON',
        targetResourceId: id,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState: current,
        metadata: { code: current.code },
      });

      auditService.logAdminAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        action: 'COUPON_DELETED',
        targetResource: 'COUPON',
        targetResourceId: id,
        metadata: { code: current.code },
      });
    } catch (_) {
      // Audit failure must not fail the request
    }

    return { success: true, id: res.id };
  }
}

module.exports = new AdminCouponService();
