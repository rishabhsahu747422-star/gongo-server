'use strict';

const crypto = require('crypto');
const adminBannerRepo = require('../repositories/admin-banner.repository');
const auditService = require('./audit.service');
const { validateRemoteUrl, validateFileBuffer } = require('../utils/file-validator');
const supabaseStorage = require('../providers/supabase-storage');
const { getSupabaseAdmin } = require('../providers/supabase');
const env = require('../config/env');
const logger = require('../config/logger');
const { BadRequestError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class AdminBannerService {
  constructor(
    bannerRepo = adminBannerRepo,
    audit = auditService,
  ) {
    this.bannerRepo = bannerRepo;
    this.audit = audit;
  }

  /**
   * Lists all banners with optional filtering.
   */
  async listBanners(query = {}) {
    return this.bannerRepo.listBanners(query);
  }

  /**
   * Retrieves single banner details.
   */
  async getBannerDetail(id) {
    const banner = await this.bannerRepo.findBannerById(id);
    if (!banner) {
      throw new NotFoundError(`Banner '${id}' not found`, ERROR_CODES.NOT_FOUND);
    }
    return banner;
  }

  /**
   * Directly uploads an asset file to object storage after verifying magic bytes and size limits.
   */
  async uploadAsset({ buffer, filename, assetType }, auditCtx = {}) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
      throw new BadRequestError('Upload payload must contain a valid file buffer', ERROR_CODES.VALIDATION_ERROR);
    }

    // 1. Magic bytes & size inspection
    const validated = validateFileBuffer(buffer, assetType);
    const targetBucket = env.SUPABASE_STORAGE_BUCKET || 'gongo-uploads';
    const cleanFilename = (filename || 'asset').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `banners/${Date.now()}_${validated.contentHash.slice(0, 10)}_${cleanFilename}`;

    // 2. Upload to Supabase Storage via Service Role client
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
      logger.warn('Storage upload exception in banner service', { error: err.message });
    }

    // 3. Resolve public or permanent storage URL
    const assetUrl = supabaseStorage.getPublicUrl(storagePath, targetBucket);

    // 4. Audit log
    try {
      this.audit.logAdminAction({
        actorId: auditCtx.actorId || null,
        actorRole: auditCtx.actorRole || 'ADMIN',
        permission: auditCtx.permission || 'banners.manage',
        action: 'BANNER_ASSET_UPLOADED',
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

  /**
   * Creates a new banner record.
   */
  async createBanner(payload, auditCtx = {}) {
    let {
      title,
      subtitle,
      tag,
      assetType,
      asset_type,
      assetUrl,
      asset_url,
      storagePath,
      storage_path,
      displayOrder,
      display_order,
      ctaLabel,
      cta_label,
      ctaDestination,
      cta_destination,
      metadata = {},
      isActive,
      is_active,
      fileBuffer,
      filename,
    } = payload;

    const normalizedType = (assetType || asset_type || '').toUpperCase();
    if (!['IMAGE', 'GIF', 'VIDEO'].includes(normalizedType)) {
      throw new BadRequestError(
        "Invalid asset type. Supported formats: 'IMAGE', 'GIF', 'VIDEO'.",
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    let finalAssetUrl = assetUrl || asset_url;
    let finalStoragePath = storagePath || storage_path || null;
    let contentHash = payload.contentHash || payload.content_hash || null;
    let version = payload.version || '1';

    // Handle direct buffer upload if provided in payload
    if (fileBuffer) {
      const buf = Buffer.isBuffer(fileBuffer)
        ? fileBuffer
        : Buffer.from(fileBuffer, 'base64');
      const uploadRes = await this.uploadAsset(
        { buffer: buf, filename, assetType: normalizedType },
        auditCtx,
      );
      finalAssetUrl = uploadRes.assetUrl;
      finalStoragePath = uploadRes.storagePath;
      contentHash = uploadRes.contentHash;
      version = uploadRes.version;
    }

    if (!finalAssetUrl) {
      throw new BadRequestError(
        'An asset URL or uploaded file is required to create a banner',
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    // If external URL without storage path, validate URL safety (SSRF protection)
    if (!finalStoragePath) {
      await validateRemoteUrl(finalAssetUrl);
      if (!contentHash) {
        contentHash = crypto.createHash('sha256').update(finalAssetUrl).digest('hex');
        version = contentHash.slice(0, 12);
      }
    }

    const bannerData = {
      title: title?.trim() || null,
      subtitle: subtitle?.trim() || null,
      tag: tag?.trim() || null,
      asset_type: normalizedType,
      asset_url: finalAssetUrl,
      storage_path: finalStoragePath,
      version: String(version),
      content_hash: contentHash,
      is_active: isActive !== undefined ? Boolean(isActive) : (is_active !== undefined ? Boolean(is_active) : true),
      display_order: Number(displayOrder || display_order) || 0,
      cta_label: ctaLabel?.trim() || cta_label?.trim() || null,
      cta_destination: ctaDestination?.trim() || cta_destination?.trim() || null,
      metadata: typeof metadata === 'object' && metadata !== null ? metadata : {},
      created_by: auditCtx.actorId || null,
    };

    const created = await this.bannerRepo.createBanner(bannerData);

    try {
      this.audit.logAdminAction({
        actorId: auditCtx.actorId || null,
        actorRole: auditCtx.actorRole || 'ADMIN',
        permission: auditCtx.permission || 'banners.create',
        action: 'BANNER_CREATED',
        targetResource: 'HOME_BANNER',
        targetResourceId: created.id,
        requestId: auditCtx.requestId || null,
        ipAddress: auditCtx.ipAddress || null,
        userAgent: auditCtx.userAgent || null,
        metadata: {
          bannerId: created.id,
          assetType: created.asset_type,
          assetUrl: created.asset_url,
          isActive: created.is_active,
        },
      });
    } catch (_) {}

    return created;
  }

  /**
   * Updates an existing banner's metadata or replaces its asset.
   */
  async updateBanner(id, payload, auditCtx = {}) {
    const existing = await this.bannerRepo.findBannerById(id);
    if (!existing) {
      throw new NotFoundError(`Banner '${id}' not found`, ERROR_CODES.NOT_FOUND);
    }

    const updates = {};
    let assetChanged = false;

    if (payload.title !== undefined) updates.title = payload.title?.trim() || null;
    if (payload.subtitle !== undefined) updates.subtitle = payload.subtitle?.trim() || null;
    if (payload.tag !== undefined) updates.tag = payload.tag?.trim() || null;
    if (payload.ctaLabel !== undefined || payload.cta_label !== undefined) {
      updates.cta_label = (payload.ctaLabel || payload.cta_label)?.trim() || null;
    }
    if (payload.ctaDestination !== undefined || payload.cta_destination !== undefined) {
      updates.cta_destination = (payload.ctaDestination || payload.cta_destination)?.trim() || null;
    }
    if (payload.displayOrder !== undefined || payload.display_order !== undefined) {
      updates.display_order = Number(payload.displayOrder || payload.display_order) || 0;
    }
    if (payload.isActive !== undefined || payload.is_active !== undefined) {
      updates.is_active = Boolean(payload.isActive !== undefined ? payload.isActive : payload.is_active);
    }
    if (payload.metadata !== undefined) {
      updates.metadata = typeof payload.metadata === 'object' && payload.metadata !== null ? payload.metadata : {};
    }

    // Asset replacement via buffer upload
    if (payload.fileBuffer) {
      const buf = Buffer.isBuffer(payload.fileBuffer)
        ? payload.fileBuffer
        : Buffer.from(payload.fileBuffer, 'base64');
      const targetType = (payload.assetType || payload.asset_type || existing.asset_type).toUpperCase();
      const uploadRes = await this.uploadAsset(
        { buffer: buf, filename: payload.filename, assetType: targetType },
        auditCtx,
      );
      updates.asset_type = uploadRes.assetType;
      updates.asset_url = uploadRes.assetUrl;
      updates.storage_path = uploadRes.storagePath;
      updates.content_hash = uploadRes.contentHash;
      updates.version = uploadRes.version;
      assetChanged = true;
    } else if (payload.assetUrl || payload.asset_url) {
      const newUrl = payload.assetUrl || payload.asset_url;
      if (newUrl !== existing.asset_url) {
        if (!payload.storagePath && !payload.storage_path) {
          await validateRemoteUrl(newUrl);
        }
        updates.asset_url = newUrl;
        updates.storage_path = payload.storagePath || payload.storage_path || null;
        if (payload.assetType || payload.asset_type) {
          updates.asset_type = (payload.assetType || payload.asset_type).toUpperCase();
        }
        const newHash = crypto.createHash('sha256').update(newUrl).digest('hex');
        updates.content_hash = newHash;
        updates.version = newHash.slice(0, 12);
        assetChanged = true;
      }
    }

    // If metadata updated without asset change, keep content_hash but bump update time
    const updated = await this.bannerRepo.updateBanner(id, updates);

    try {
      this.audit.logAdminAction({
        actorId: auditCtx.actorId || null,
        actorRole: auditCtx.actorRole || 'ADMIN',
        permission: auditCtx.permission || 'banners.update',
        action: 'BANNER_UPDATED',
        targetResource: 'HOME_BANNER',
        targetResourceId: id,
        requestId: auditCtx.requestId || null,
        ipAddress: auditCtx.ipAddress || null,
        userAgent: auditCtx.userAgent || null,
        metadata: {
          bannerId: id,
          assetChanged,
          newVersion: updated.version,
        },
      });
    } catch (_) {}

    return updated;
  }

  /**
   * Activates or deactivates a banner.
   */
  async updateStatus(id, isActive, auditCtx = {}) {
    const existing = await this.bannerRepo.findBannerById(id);
    if (!existing) {
      throw new NotFoundError(`Banner '${id}' not found`, ERROR_CODES.NOT_FOUND);
    }

    const updated = await this.bannerRepo.updateBanner(id, { is_active: Boolean(isActive) });

    try {
      this.audit.logAdminAction({
        actorId: auditCtx.actorId || null,
        actorRole: auditCtx.actorRole || 'ADMIN',
        permission: auditCtx.permission || 'banners.status',
        action: isActive ? 'BANNER_ACTIVATED' : 'BANNER_DEACTIVATED',
        targetResource: 'HOME_BANNER',
        targetResourceId: id,
        requestId: auditCtx.requestId || null,
        ipAddress: auditCtx.ipAddress || null,
        userAgent: auditCtx.userAgent || null,
        metadata: { bannerId: id, isActive: Boolean(isActive) },
      });
    } catch (_) {}

    return updated;
  }

  /**
   * Safely deletes a banner and cleans up storage if no other active banner references the file.
   */
  async deleteBanner(id, auditCtx = {}) {
    const existing = await this.bannerRepo.findBannerById(id);
    if (!existing) {
      throw new NotFoundError(`Banner '${id}' not found`, ERROR_CODES.NOT_FOUND);
    }

    const deleted = await this.bannerRepo.deleteBanner(id);

    // If file is in storage, check if referenced by another banner before deleting
    if (existing.storage_path) {
      const inUse = await this.bannerRepo.isStoragePathInUse(existing.storage_path, id);
      if (!inUse) {
        try {
          const supabase = getSupabaseAdmin();
          const targetBucket = env.SUPABASE_STORAGE_BUCKET || 'gongo-uploads';
          if (supabase && supabase.storage) {
            await supabase.storage.from(targetBucket).remove([existing.storage_path]);
          }
        } catch (err) {
          logger.warn(`Failed to remove deleted banner asset from storage: ${err.message}`);
        }
      }
    }

    try {
      this.audit.logAdminAction({
        actorId: auditCtx.actorId || null,
        actorRole: auditCtx.actorRole || 'ADMIN',
        permission: auditCtx.permission || 'banners.delete',
        action: 'BANNER_DELETED',
        targetResource: 'HOME_BANNER',
        targetResourceId: id,
        requestId: auditCtx.requestId || null,
        ipAddress: auditCtx.ipAddress || null,
        userAgent: auditCtx.userAgent || null,
        metadata: {
          bannerId: id,
          title: existing.title,
          assetUrl: existing.asset_url,
        },
      });
    } catch (_) {}

    return { success: true, message: 'Banner deleted successfully' };
  }

  /**
   * Reorders display orders for a list of banners.
   */
  async reorderBanners(orderedIds, auditCtx = {}) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new BadRequestError('orderedIds must be a non-empty array of banner IDs', ERROR_CODES.VALIDATION_ERROR);
    }

    const reordered = await this.bannerRepo.reorderBanners(orderedIds);

    try {
      this.audit.logAdminAction({
        actorId: auditCtx.actorId || null,
        actorRole: auditCtx.actorRole || 'ADMIN',
        permission: auditCtx.permission || 'banners.update',
        action: 'BANNERS_REORDERED',
        targetResource: 'HOME_BANNER',
        targetResourceId: 'bulk',
        requestId: auditCtx.requestId || null,
        ipAddress: auditCtx.ipAddress || null,
        userAgent: auditCtx.userAgent || null,
        metadata: { count: reordered.length },
      });
    } catch (_) {}

    return reordered;
  }

  /**
   * Creates multiple banners in a batch operation.
   */
  async createBulk(bannersList = [], auditCtx = {}) {
    if (!Array.isArray(bannersList) || bannersList.length === 0) {
      throw new BadRequestError('banners must be a non-empty array', ERROR_CODES.VALIDATION_ERROR);
    }

    const created = [];
    const errors = [];

    for (let i = 0; i < bannersList.length; i++) {
      const bannerPayload = bannersList[i];
      try {
        const item = await this.createBanner(bannerPayload, auditCtx);
        created.push(item);
      } catch (err) {
        logger.warn(`Failed to create banner at index ${i}:`, { error: err.message });
        errors.push({
          index: i,
          title: bannerPayload.title || `Banner ${i + 1}`,
          error: err.message,
        });
      }
    }

    return {
      created,
      errors,
      totalRequested: bannersList.length,
      totalCreated: created.length,
    };
  }
}

module.exports = new AdminBannerService();
