'use strict';

const BaseRepository = require('../db/base.repository');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const toSafeUuid = (val) => (typeof val === 'string' && UUID_REGEX.test(val.trim()) ? val.trim() : null);

class AdminBannerRepository extends BaseRepository {
  constructor() {
    super('home_banners', 'id');
  }

  _getExecutor(client) {
    return client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
  }

  /**
   * Lists banners with filtering and pagination.
   */
  async listBanners({ active, assetType, search, page = 1, limit = 50 } = {}, client = null) {
    const executor = this._getExecutor(client);
    const conditions = [];
    const params = [];
    let pIdx = 1;

    if (active !== undefined && active !== null && active !== '') {
      conditions.push(`is_active = $${pIdx}`);
      params.push(active === true || active === 'true');
      pIdx++;
    }

    if (assetType && ['IMAGE', 'GIF', 'VIDEO'].includes(assetType.toUpperCase())) {
      conditions.push(`asset_type = $${pIdx}`);
      params.push(assetType.toUpperCase());
      pIdx++;
    }

    if (search && search.trim()) {
      conditions.push(`(title ILIKE $${pIdx} OR subtitle ILIKE $${pIdx} OR tag ILIKE $${pIdx})`);
      params.push(`%${search.trim()}%`);
      pIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const countSql = `SELECT COUNT(*)::int AS total FROM home_banners ${whereClause};`;
    const dataSql = `
      SELECT id, title, subtitle, tag, asset_type, asset_url, storage_path,
             version, content_hash, is_active, display_order, cta_label, cta_destination,
             metadata, created_by, created_at, updated_at
      FROM home_banners
      ${whereClause}
      ORDER BY display_order ASC, created_at DESC
      LIMIT $${pIdx} OFFSET $${pIdx + 1};
    `;

    const [countRes, dataRes] = await Promise.all([
      executor(countSql, params),
      executor(dataSql, [...params, safeLimit, offset]),
    ]);

    const total = countRes.rows[0] ? Number(countRes.rows[0].total) : 0;
    return {
      items: dataRes.rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  /**
   * Retrieves single banner by ID.
   */
  async findBannerById(id, client = null) {
    const validId = toSafeUuid(id);
    if (!validId) return null;

    const executor = this._getExecutor(client);
    const sql = `
      SELECT id, title, subtitle, tag, asset_type, asset_url, storage_path,
             version, content_hash, is_active, display_order, cta_label, cta_destination,
             metadata, created_by, created_at, updated_at
      FROM home_banners
      WHERE id = $1
      LIMIT 1;
    `;
    const res = await executor(sql, [validId]);
    return res.rows[0] || null;
  }

  /**
   * Creates a new banner record.
   */
  async createBanner(data, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      INSERT INTO home_banners (
        title, subtitle, tag, asset_type, asset_url, storage_path,
        version, content_hash, is_active, display_order, cta_label, cta_destination,
        metadata, created_by, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      RETURNING *;
    `;

    const params = [
      data.title || null,
      data.subtitle || null,
      data.tag || null,
      data.asset_type,
      data.asset_url,
      data.storage_path || null,
      data.version || '1',
      data.content_hash || null,
      data.is_active !== undefined ? Boolean(data.is_active) : true,
      Number(data.display_order) || 0,
      data.cta_label || null,
      data.cta_destination || null,
      JSON.stringify(data.metadata || {}),
      toSafeUuid(data.created_by),
    ];

    const res = await executor(sql, params);
    return res.rows[0];
  }

  /**
   * Updates an existing banner record.
   */
  async updateBanner(id, data, client = null) {
    const validId = toSafeUuid(id);
    if (!validId) return null;

    const executor = this._getExecutor(client);
    const updates = [];
    const params = [];
    let pIdx = 1;

    const allowedFields = [
      'title', 'subtitle', 'tag', 'asset_type', 'asset_url', 'storage_path',
      'version', 'content_hash', 'is_active', 'display_order', 'cta_label', 'cta_destination',
    ];

    allowedFields.forEach((field) => {
      if (data[field] !== undefined) {
        updates.push(`${field} = $${pIdx}`);
        params.push(data[field]);
        pIdx++;
      }
    });

    if (data.metadata !== undefined) {
      updates.push(`metadata = $${pIdx}`);
      params.push(JSON.stringify(data.metadata));
      pIdx++;
    }

    if (updates.length === 0) {
      return this.findBannerById(validId, client);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');

    const sql = `
      UPDATE home_banners
      SET ${updates.join(', ')}
      WHERE id = $${pIdx}
      RETURNING *;
    `;
    params.push(validId);

    const res = await executor(sql, params);
    return res.rows[0] || null;
  }

  /**
   * Deletes a banner by ID.
   */
  async deleteBanner(id, client = null) {
    const validId = toSafeUuid(id);
    if (!validId) return false;

    const executor = this._getExecutor(client);
    const sql = `DELETE FROM home_banners WHERE id = $1 RETURNING id, storage_path;`;
    const res = await executor(sql, [validId]);
    return res.rows[0] || null;
  }

  /**
   * Atomically updates display orders for a list of banner IDs.
   */
  async reorderBanners(orderedIds = [], client = null) {
    const executor = this._getExecutor(client);
    const results = [];

    for (let index = 0; index < orderedIds.length; index++) {
      const validId = toSafeUuid(orderedIds[index]);
      if (validId) {
        const sql = `
          UPDATE home_banners
          SET display_order = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
          RETURNING id, display_order;
        `;
        const res = await executor(sql, [index, validId]);
        if (res.rows[0]) results.push(res.rows[0]);
      }
    }

    return results;
  }

  /**
   * Checks if an asset storage path is still referenced by other active banners.
   */
  async isStoragePathInUse(storagePath, excludeBannerId = null, client = null) {
    if (!storagePath) return false;
    const executor = this._getExecutor(client);
    const params = [storagePath];
    let excludeSql = '';
    if (excludeBannerId) {
      excludeSql = ' AND id != $2';
      params.push(excludeBannerId);
    }
    const sql = `SELECT COUNT(*)::int AS count FROM home_banners WHERE storage_path = $1${excludeSql};`;
    const res = await executor(sql, params);
    return (res.rows[0] ? Number(res.rows[0].count) : 0) > 0;
  }
}

module.exports = new AdminBannerRepository();
