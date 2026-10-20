'use strict';

const crypto = require('crypto');
const adminOfferRepository = require('../repositories/admin-offer.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const auditService = require('./audit.service');
const { validateRemoteUrl, validateFileBuffer } = require('../utils/file-validator');
const supabaseStorage = require('../providers/supabase-storage');
const { getSupabaseAdmin } = require('../providers/supabase');
const env = require('../config/env');
const logger = require('../config/logger');
const { ValidationError, NotFoundError, BadRequestError } = require('../errors');
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

  /**
   * Uploads an offer image/asset to Supabase storage after validating magic bytes & size.
   */
  async uploadAsset({ buffer, filename, assetType = 'IMAGE' }, auditCtx = {}) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
      throw new BadRequestError('Upload payload must contain a valid file buffer', ERROR_CODES.VALIDATION_ERROR);
    }

    const validated = validateFileBuffer(buffer, assetType);
    const targetBucket = env.SUPABASE_STORAGE_BUCKET || 'gongo-uploads';
    const cleanFilename = (filename || 'offer_asset').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `offers/${Date.now()}_${validated.contentHash.slice(0, 10)}_${cleanFilename}`;

    try {
      const supabase = getSupabaseAdmin();
      if (supabase && supabase.storage) {
        const { error } = await supabase.storage
          .from(targetBucket)
          .upload(storagePath, buffer, {
            contentType: validated.mimeType,
            upsert: true,
          });

        if (error) {
          logger.warn('Direct Supabase storage upload returned error, falling back', { error: error.message });
        }
      }
    } catch (err) {
      logger.warn('Storage upload exception in offer service', { error: err.message });
    }

    const assetUrl = supabaseStorage.getPublicUrl(storagePath, targetBucket);

    try {
      auditService.logAdminAction({
        actorId: auditCtx.actorId || 'system-admin',
        actorRole: auditCtx.actorRole || 'ADMIN',
        action: 'OFFER_ASSET_UPLOADED',
        targetResource: 'STORAGE_BUCKET',
        targetResourceId: storagePath,
        requestId: auditCtx.requestId || null,
        ipAddress: auditCtx.ipAddress || null,
        userAgent: auditCtx.userAgent || null,
        metadata: {
          assetType: validated.assetType,
          mimeType: validated.mimeType,
          size: validated.size,
          contentHash: validated.contentHash,
          storagePath,
        },
      });
    } catch (_) {}

    return {
      storagePath,
      assetUrl,
      assetType: validated.assetType,
      mimeType: validated.mimeType,
      size: validated.size,
      contentHash: validated.contentHash,
      version: validated.contentHash.slice(0, 12),
    };
  }

  async createOffer(data, auditContext = {}) {
    if (!data.name || typeof data.name !== 'string') {
      throw new ValidationError('Offer name is required');
    }
    if (data.discountValue === undefined && data.discount_value === undefined && (data.discount_type || data.discountType) !== 'none') {
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

    let imageUrl = data.image_url || data.imageUrl || null;
    let storagePath = data.storage_path || data.storagePath || null;

    // Direct buffer upload
    if (data.fileBuffer) {
      const buf = Buffer.isBuffer(data.fileBuffer) ? data.fileBuffer : Buffer.from(data.fileBuffer, 'base64');
      const uploadRes = await this.uploadAsset(
        { buffer: buf, filename: data.filename, assetType: 'IMAGE' },
        auditContext
      );
      imageUrl = uploadRes.assetUrl;
      storagePath = uploadRes.storagePath;
    } else if (imageUrl && !storagePath) {
      // Validate external URL (SSRF protection)
      await validateRemoteUrl(imageUrl);
    }

    const payload = {
      ...data,
      image_url: imageUrl,
      storage_path: storagePath,
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

    // Direct buffer upload for asset replacement
    if (updates.fileBuffer) {
      const buf = Buffer.isBuffer(updates.fileBuffer) ? updates.fileBuffer : Buffer.from(updates.fileBuffer, 'base64');
      const uploadRes = await this.uploadAsset(
        { buffer: buf, filename: updates.filename, assetType: 'IMAGE' },
        auditContext
      );
      updates.image_url = uploadRes.assetUrl;
      updates.storage_path = uploadRes.storagePath;
    } else if ((updates.image_url || updates.imageUrl) && !(updates.storage_path || updates.storagePath)) {
      const newUrl = updates.image_url || updates.imageUrl;
      if (newUrl !== current.image_url) {
        await validateRemoteUrl(newUrl);
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

  async updateStatus(id, isActive, auditContext = {}) {
    if (!id) throw new ValidationError('Offer ID is required');
    const current = await adminOfferRepository.findOfferById(id);
    if (!current) throw new NotFoundError('Offer not found', ERROR_CODES.NOT_FOUND);

    const updated = await adminOfferRepository.updateOffer(id, { is_active: Boolean(isActive) });

    try {
      auditService.logAdminAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        action: isActive ? 'OFFER_ACTIVATED' : 'OFFER_DEACTIVATED',
        targetResource: 'OFFER',
        targetResourceId: id,
        metadata: { offerId: id, isActive: Boolean(isActive) },
      });
    } catch (_) {}

    return { offer: updated };
  }

  async deleteOffer(id, auditContext = {}) {
    if (!id) throw new ValidationError('Offer ID is required');
    const current = await adminOfferRepository.findOfferById(id);
    if (!current) throw new NotFoundError('Offer not found', ERROR_CODES.NOT_FOUND);

    const res = await adminOfferRepository.deleteOffer(id);

    // If storage_path exists, safely remove from bucket if no other offer uses it
    if (current.storage_path) {
      const inUse = await adminOfferRepository.isStoragePathInUse(current.storage_path, id);
      if (!inUse) {
        try {
          const supabase = getSupabaseAdmin();
          const targetBucket = env.SUPABASE_STORAGE_BUCKET || 'gongo-uploads';
          if (supabase && supabase.storage) {
            await supabase.storage.from(targetBucket).remove([current.storage_path]);
          }
        } catch (err) {
          logger.warn(`Failed to remove deleted offer asset from storage: ${err.message}`);
        }
      }
    }

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

  async reorderOffers(orderedIds, auditContext = {}) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new BadRequestError('orderedIds must be a non-empty array of offer IDs', ERROR_CODES.VALIDATION_ERROR);
    }

    const reordered = await adminOfferRepository.reorderOffers(orderedIds);

    try {
      auditService.logAdminAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        action: 'OFFERS_REORDERED',
        targetResource: 'OFFER',
        targetResourceId: 'bulk',
        metadata: { count: reordered.length },
      });
    } catch (_) {}

    return reordered;
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
