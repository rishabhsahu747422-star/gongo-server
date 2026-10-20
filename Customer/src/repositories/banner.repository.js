'use strict';

const BaseRepository = require('./base.repository');

class BannerRepository extends BaseRepository {
  /**
   * Retrieves all currently active banners ordered by display_order ASC, created_at DESC.
   * Customer endpoints MUST only return active banners.
   */
  async getActiveBanners() {
    const sql = `
      SELECT id, title, subtitle, tag, asset_type, asset_url,
             version, content_hash, display_order, cta_label, cta_destination,
             metadata, updated_at
      FROM home_banners
      WHERE is_active = true
      ORDER BY display_order ASC, created_at DESC;
    `;
    const res = await this.query(sql);
    return res.rows;
  }
}

module.exports = new BannerRepository();
