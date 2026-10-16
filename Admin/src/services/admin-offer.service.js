'use strict';

const adminOfferRepository = require('../repositories/admin-offer.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const auditService = require('./audit.service');
const { ValidationError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class AdminOfferService {
  async listOffers(query = {}) {
    return adminOfferRepository.listOffers(query);
  }

  async getOfferDetail(id) {
    if (!id) throw new ValidationError('Offer ID is required');
    const offer = await adminOfferRepository.findOfferById(id);
    if (!offer) throw new NotFoundError('Offer not found', ERROR_CODES.NOT_FOUND);

    const [vehicles, shops] = await Promise.all([
      adminOfferRepository.findOfferVehicles(id),
      adminOfferRepository.findOfferShops(id),
    ]);

    return {
      offer,
      vehicles,
      shops,
    };
  }

  async createOffer(data, auditContext = {}) {
    if (!data.name || typeof data.name !== 'string') {
      throw new ValidationError('Offer name is required');
    }
    if (data.discountValue === undefined && data.discount_value === undefined) {
      throw new ValidationError('discount_value is required');
    }
    if (!data.validUntil && !data.valid_until) {
      throw new ValidationError('valid_until is required');
    }

    const validFrom = data.valid_from || data.validFrom || new Date().toISOString();
    const validUntil = data.valid_until || data.validUntil;

    if (new Date(validFrom) >= new Date(validUntil)) {
      throw new ValidationError('valid_from must be before valid_until');
    }

    const payload = {
      ...data,
      created_by: auditContext.actorId || null,
    };

    const created = await adminOfferRepository.createOffer(payload);

    try {
      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: 'offers.create',
        action: 'OFFER_CREATED',
        targetResource: 'OFFER',
        targetResourceId: created.id,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        afterState: created,
        metadata: { name: created.name },
      });

      auditService.logAdminAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        action: 'OFFER_CREATED',
        targetResource: 'OFFER',
        targetResourceId: created.id,
        metadata: { name: created.name },
      });
    } catch (_) {
      // Audit failure must not fail the business request
    }

    return { offer: created };
  }

  async updateOffer(id, updates = {}, auditContext = {}) {
    if (!id) throw new ValidationError('Offer ID is required');
    const current = await adminOfferRepository.findOfferById(id);
    if (!current) throw new NotFoundError('Offer not found', ERROR_CODES.NOT_FOUND);

    if (updates.valid_until && updates.valid_from) {
      if (new Date(updates.valid_from) >= new Date(updates.valid_until)) {
        throw new ValidationError('valid_from must be before valid_until');
      }
    }

    const updated = await adminOfferRepository.updateOffer(id, updates);

    try {
      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: 'offers.update',
        action: 'OFFER_UPDATED',
        targetResource: 'OFFER',
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
        action: 'OFFER_UPDATED',
        targetResource: 'OFFER',
        targetResourceId: id,
        metadata: updates,
      });
    } catch (_) {
      // Audit failure must not fail the business request
    }

    return { offer: updated };
  }

  async deleteOffer(id, auditContext = {}) {
    if (!id) throw new ValidationError('Offer ID is required');
    const current = await adminOfferRepository.findOfferById(id);
    if (!current) throw new NotFoundError('Offer not found', ERROR_CODES.NOT_FOUND);

    const res = await adminOfferRepository.deleteOffer(id);

    try {
      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: 'offers.delete',
        action: 'OFFER_DELETED',
        targetResource: 'OFFER',
        targetResourceId: id,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState: current,
        metadata: { name: current.name },
      });

      auditService.logAdminAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        action: 'OFFER_DELETED',
        targetResource: 'OFFER',
        targetResourceId: id,
        metadata: { name: current.name },
      });
    } catch (_) {
      // Audit failure must not fail the business request
    }

    return res;
  }

  async addVehicleToOffer(offerId, vehicleId, auditContext = {}) {
    if (!offerId || !vehicleId) throw new ValidationError('offerId and vehicleId are required');
    const offer = await adminOfferRepository.findOfferById(offerId);
    if (!offer) throw new NotFoundError('Offer not found', ERROR_CODES.NOT_FOUND);
    return adminOfferRepository.addVehicleToOffer(offerId, vehicleId);
  }

  async removeVehicleFromOffer(offerId, vehicleId, auditContext = {}) {
    if (!offerId || !vehicleId) throw new ValidationError('offerId and vehicleId are required');
    return adminOfferRepository.removeVehicleFromOffer(offerId, vehicleId);
  }

  async addShopToOffer(offerId, shopId, auditContext = {}) {
    if (!offerId || !shopId) throw new ValidationError('offerId and shopId are required');
    const offer = await adminOfferRepository.findOfferById(offerId);
    if (!offer) throw new NotFoundError('Offer not found', ERROR_CODES.NOT_FOUND);
    return adminOfferRepository.addShopToOffer(offerId, shopId);
  }

  async removeShopFromOffer(offerId, shopId, auditContext = {}) {
    if (!offerId || !shopId) throw new ValidationError('offerId and shopId are required');
    return adminOfferRepository.removeShopFromOffer(offerId, shopId);
  }
}

module.exports = new AdminOfferService();
