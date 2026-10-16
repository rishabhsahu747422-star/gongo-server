'use strict';

const ShopRepository = require('../repositories/shop.repository');
const PartnerRepository = require('../repositories/partner.repository');
const auditService = require('./audit.service');
const { NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { invalidateAuthCache } = require('../middlewares/auth');
const { resolveWorkingHoursFromRows, isOvernightSchedule } = require('../utils/working-hours');

class ShopService {
  constructor() {
    this.shopRepository = new ShopRepository();
    this.partnerRepository = new PartnerRepository();
  }

  /**
   * Formats raw shop database record into frontend-safe representation.
   *
   * @param {object} shop
   * @returns {object}
   */
  formatShopResponse(shop) {
    const area = shop.area || shop.locality || null;
    const workingHoursInfo = resolveWorkingHoursFromRows(null, shop);

    return {
      id: shop.id,
      partnerId: shop.partner_id,
      shopName: shop.shop_name,
      shopAddress: shop.shop_address,
      landmark: shop.landmark || null,
      city: shop.city,
      area,
      locality: area,
      latitude: (shop.latitude !== null && shop.latitude !== undefined)
        ? Number(shop.latitude)
        : null,
      longitude: (shop.longitude !== null && shop.longitude !== undefined)
        ? Number(shop.longitude)
        : null,
      locationAccuracy: (shop.location_accuracy !== null && shop.location_accuracy !== undefined)
        ? Number(shop.location_accuracy)
        : null,
      locationSource: shop.location_source || null,
      operatingInfo: workingHoursInfo.operatingInfo,
      openingTime: workingHoursInfo.openingTime,
      closingTime: workingHoursInfo.closingTime,
      isOpen24Hours: workingHoursInfo.isOpen24Hours,
      workingHours: workingHoursInfo.workingHours,
      isActive: shop.is_active,
      createdAt: shop.created_at,
      updatedAt: shop.updated_at,
    };
  }

  /**
   * Retrieves primary shop details for the authenticated partner.
   *
   * @param {string} partnerId
   * @returns {Promise<object>}
   */
  async getShop(partnerId) {
    const shop = await this.shopRepository.findByPartnerId(partnerId);

    if (!shop) {
      throw new NotFoundError('Shop details not found for this partner', ERROR_CODES.NOT_FOUND);
    }

    return this.formatShopResponse(shop);
  }

  /**
   * Updates shop location and operating details.
   *
   * @param {string} partnerId
   * @param {object} updates Validated shop fields from PartnerValidator
   * @param {string} [requestId]
   * @returns {Promise<object>} Updated shop details
   */
  async updateShop(partnerId, updates, requestId = null) {
    const existing = await this.shopRepository.findByPartnerId(partnerId);

    if (!existing) {
      throw new NotFoundError('Shop details not found for this partner', ERROR_CODES.NOT_FOUND);
    }

    const normalizedUpdates = { ...updates };
    if (updates.isOpen24Hours === true) {
      normalizedUpdates.isOpen24Hours = true;
      normalizedUpdates.openingTime = null;
      normalizedUpdates.closingTime = null;
      normalizedUpdates.operatingInfo = 'Open 24 Hours';
    } else if (updates.openingTime && updates.closingTime && updates.operatingInfo === undefined) {
      const isOvernight = isOvernightSchedule(updates.openingTime, updates.closingTime);
      normalizedUpdates.operatingInfo = `${updates.openingTime} - ${updates.closingTime}${isOvernight ? ' (Next Day)' : ''}`;
    }

    const updated = await this.shopRepository.updateShop(partnerId, normalizedUpdates);

    // Synchronize canonical partner record when shop details are updated
    if (this.partnerRepository && typeof this.partnerRepository.updatePartner === 'function') {
      const partnerSyncUpdates = {};
      if (normalizedUpdates.shopName !== undefined) partnerSyncUpdates.businessName = normalizedUpdates.shopName;
      if (normalizedUpdates.shopAddress !== undefined) partnerSyncUpdates.businessAddress = normalizedUpdates.shopAddress;
      if (normalizedUpdates.landmark !== undefined) partnerSyncUpdates.landmark = normalizedUpdates.landmark;
      if (normalizedUpdates.city !== undefined) partnerSyncUpdates.city = normalizedUpdates.city;
      if (normalizedUpdates.area !== undefined) partnerSyncUpdates.area = normalizedUpdates.area;
      if (normalizedUpdates.locality !== undefined) partnerSyncUpdates.locality = normalizedUpdates.locality;
      if (normalizedUpdates.latitude !== undefined) partnerSyncUpdates.latitude = normalizedUpdates.latitude;
      if (normalizedUpdates.longitude !== undefined) partnerSyncUpdates.longitude = normalizedUpdates.longitude;
      if (normalizedUpdates.locationAccuracy !== undefined) partnerSyncUpdates.locationAccuracy = normalizedUpdates.locationAccuracy;
      if (normalizedUpdates.locationSource !== undefined) partnerSyncUpdates.locationSource = normalizedUpdates.locationSource;
      if (normalizedUpdates.operatingInfo !== undefined) partnerSyncUpdates.operatingInfo = normalizedUpdates.operatingInfo;
      if (normalizedUpdates.openingTime !== undefined) partnerSyncUpdates.openingTime = normalizedUpdates.openingTime;
      if (normalizedUpdates.closingTime !== undefined) partnerSyncUpdates.closingTime = normalizedUpdates.closingTime;
      if (normalizedUpdates.isOpen24Hours !== undefined) partnerSyncUpdates.isOpen24Hours = normalizedUpdates.isOpen24Hours;

      if (Object.keys(partnerSyncUpdates).length > 0) {
        await this.partnerRepository.updatePartner(partnerId, partnerSyncUpdates).catch(() => null);
      }
    }

    invalidateAuthCache(partnerId);

    auditService.logEvent({
      actorId: partnerId,
      actorRole: 'PARTNER',
      action: 'PARTNER_SHOP_UPDATED',
      entityType: 'SHOP',
      entityId: existing.id,
      requestId,
      metadata: {
        updatedFields: Object.keys(updates),
        city: updated.city,
      },
    });

    return this.formatShopResponse(updated);
  }
}

module.exports = new ShopService();
