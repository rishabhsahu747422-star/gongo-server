'use strict';

const adminShopRepository = require('../repositories/admin-shop.repository');
const auditService = require('./audit.service');
const { ValidationError, NotFoundError } = require('../errors');
const logger = require('../config/logger');

class AdminShopService {
  async listShops(query = {}) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 20), 100);
    const offset = (page - 1) * limit;

    const { search, status, city } = query;

    const { shops, total } = await adminShopRepository.findAllPaginated({
      search,
      status,
      city,
      limit,
      offset,
    });

    return {
      shops,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  async getShopDetail(shopId) {
    if (!shopId) {
      throw new ValidationError('Shop ID is required');
    }

    const shop = await adminShopRepository.findById(shopId);
    if (!shop) {
      throw new NotFoundError(`Shop not found with ID: ${shopId}`);
    }

    const [vehicles, documents, images, operatingHours] = await Promise.all([
      adminShopRepository.getShopVehicles(shopId, { limit: 10, offset: 0 }),
      adminShopRepository.getShopDocuments(shopId),
      adminShopRepository.getShopImages(shopId),
      adminShopRepository.getShopOperatingHours(shopId),
    ]);

    return {
      shop,
      recentVehicles: vehicles,
      vehicles,
      documents,
      images,
      operatingHours,
    };
  }

  async getShopDocuments(shopId) {
    if (!shopId) throw new ValidationError('Shop ID is required');
    const documents = await adminShopRepository.getShopDocuments(shopId);
    return { documents };
  }

  async getShopImages(shopId) {
    if (!shopId) throw new ValidationError('Shop ID is required');
    const images = await adminShopRepository.getShopImages(shopId);
    return { images };
  }

  async getShopOperatingHours(shopId) {
    if (!shopId) throw new ValidationError('Shop ID is required');
    const operatingHours = await adminShopRepository.getShopOperatingHours(shopId);
    return { operatingHours };
  }

  async verifyShop(shopId, { reason = 'Shop verified by admin' } = {}, actor = {}) {
    if (!shopId) throw new ValidationError('Shop ID is required');

    const shop = await adminShopRepository.findById(shopId);
    if (!shop) throw new NotFoundError('Shop not found');

    const updated = await adminShopRepository.updateVerificationStatus(shopId, {
      status: 'verified',
      reason,
      verifiedBy: actor.id || null,
    });

    await auditService.recordAction({
      actorId: actor.id || 'system-admin',
      actorRole: actor.role || 'admin',
      action: 'VERIFY_SHOP',
      targetResource: 'shops',
      targetResourceId: shopId,
      beforeState: { verificationStatus: shop.verificationStatus },
      afterState: { verificationStatus: 'verified' },
      metadata: { reason },
    });

    return { shop: updated, message: 'Shop verified successfully' };
  }

  async rejectShop(shopId, { reason = 'Shop rejected by admin' } = {}, actor = {}) {
    if (!shopId) throw new ValidationError('Shop ID is required');

    const shop = await adminShopRepository.findById(shopId);
    if (!shop) throw new NotFoundError('Shop not found');

    const updated = await adminShopRepository.updateVerificationStatus(shopId, {
      status: 'rejected',
      reason,
      verifiedBy: actor.id || null,
    });

    await auditService.recordAction({
      actorId: actor.id || 'system-admin',
      actorRole: actor.role || 'admin',
      action: 'REJECT_SHOP',
      targetResource: 'shops',
      targetResourceId: shopId,
      beforeState: { verificationStatus: shop.verificationStatus },
      afterState: { verificationStatus: 'rejected' },
      metadata: { reason },
    });

    return { shop: updated, message: 'Shop rejected successfully' };
  }

  async suspendShop(shopId, { reason = 'Shop suspended by admin' } = {}, actor = {}) {
    if (!shopId) throw new ValidationError('Shop ID is required');

    const shop = await adminShopRepository.findById(shopId);
    if (!shop) throw new NotFoundError('Shop not found');

    const updated = await adminShopRepository.updateStatus(shopId, {
      isActive: false,
      status: 'suspended',
      reason,
      updatedBy: actor.id,
    });

    await auditService.recordAction({
      actorId: actor.id || 'system-admin',
      actorRole: actor.role || 'admin',
      action: 'SUSPEND_SHOP',
      targetResource: 'shops',
      targetResourceId: shopId,
      beforeState: { isActive: shop.isActive },
      afterState: { isActive: false, status: 'suspended' },
      metadata: { reason },
    });

    return { shop: updated, message: 'Shop suspended successfully' };
  }

  async reactivateShop(shopId, { reason = 'Shop reactivated by admin' } = {}, actor = {}) {
    if (!shopId) throw new ValidationError('Shop ID is required');

    const shop = await adminShopRepository.findById(shopId);
    if (!shop) throw new NotFoundError('Shop not found');

    const updated = await adminShopRepository.updateStatus(shopId, {
      isActive: true,
      status: 'active',
      reason,
      updatedBy: actor.id,
    });

    await auditService.recordAction({
      actorId: actor.id || 'system-admin',
      actorRole: actor.role || 'admin',
      action: 'REACTIVATE_SHOP',
      targetResource: 'shops',
      targetResourceId: shopId,
      beforeState: { isActive: shop.isActive },
      afterState: { isActive: true, status: 'active' },
      metadata: { reason },
    });

    return { shop: updated, message: 'Shop reactivated successfully' };
  }

  async updateShopStatus(shopId, { status, reason, adminId }) {
    if (!shopId) {
      throw new ValidationError('Shop ID is required');
    }

    const normalizedStatus = String(status).toLowerCase();
    if (!['active', 'inactive', 'suspended'].includes(normalizedStatus)) {
      throw new ValidationError("Status must be 'active', 'inactive', or 'suspended'");
    }

    const isActive = normalizedStatus === 'active';
    const updated = await adminShopRepository.updateStatus(shopId, {
      isActive,
      status: normalizedStatus,
      reason,
      updatedBy: adminId,
    });

    logger.info('Admin updated shop status', { shopId, status: normalizedStatus, adminId });

    return {
      shopId,
      status: normalizedStatus,
      isActive,
      updated,
    };
  }

  async getShopVehicles(shopId, query = {}) {
    if (!shopId) {
      throw new ValidationError('Shop ID is required');
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 20), 100);
    const offset = (page - 1) * limit;

    const vehicles = await adminShopRepository.getShopVehicles(shopId, { limit, offset });

    return {
      shopId,
      vehicles,
      pagination: {
        page,
        limit,
        count: vehicles.length,
      },
    };
  }
}

module.exports = new AdminShopService();
