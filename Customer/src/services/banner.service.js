'use strict';

const crypto = require('crypto');
const bannerRepository = require('../repositories/banner.repository');

class BannerService {
  constructor(bannerRepo = bannerRepository) {
    this.bannerRepo = bannerRepo;
  }

  _resolveAssetUrl(row) {
    if (row.asset_url && (row.asset_url.startsWith('http://') || row.asset_url.startsWith('https://'))) {
      return row.asset_url;
    }
    const path = row.storage_path || row.asset_url;
    if (!path) return null;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'gongo-uploads';
    const supabaseUrl = (process.env.SUPABASE_URL || 'https://mtfljykvxyslhdvpfcil.supabase.co').replace(/^https?:\/\//, '');
    return `https://${supabaseUrl}/storage/v1/object/public/${bucket}/${path.replace(/^\/+/, '')}`;
  }

  /**
   * Retrieves all active home banners with stable configuration revision identifier.
   */
  async getActiveBanners() {
    const rows = await this.bannerRepo.getActiveBanners();

    // Map public fields (do not leak internal administrative metadata or storage keys)
    const banners = rows.map((row) => {
      const resolvedUrl = this._resolveAssetUrl(row);
      return {
        id: row.id,
        title: row.title || '',
        subtitle: row.subtitle || '',
        tag: row.tag || '',
        assetType: row.asset_type,
        asset_type: row.asset_type,
        assetUrl: resolvedUrl,
        asset_url: resolvedUrl,
        version: row.version || '1',
        contentHash: row.content_hash || '',
        content_hash: row.content_hash || '',
        displayOrder: row.display_order || 0,
        display_order: row.display_order || 0,
        ctaLabel: row.cta_label || null,
        cta_label: row.cta_label || null,
        ctaDestination: row.cta_destination || null,
        cta_destination: row.cta_destination || null,
        metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      };
    });

    // Calculate a deterministic revision hash across all active banner revisions
    const revisionInput = banners
      .map((b) => `${b.id}:${b.version}:${b.contentHash}:${b.updatedAt}`)
      .join('|');
    const revision = crypto
      .createHash('sha256')
      .update(revisionInput || 'empty-active-banners')
      .digest('hex')
      .slice(0, 16);

    return {
      banners,
      items: banners,
      revision,
      count: banners.length,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = new BannerService();
