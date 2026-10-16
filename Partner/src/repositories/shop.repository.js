'use strict';

const BaseRepository = require('../db/base.repository');

class ShopRepository extends BaseRepository {
  constructor() {
    super('shops', 'id');
  }

  /**
   * Find shop by partner ID.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByPartnerId(partnerId, client = null) {
    const text = `
      SELECT id, partner_id, shop_name, shop_address, landmark, city, COALESCE(area, locality) AS area, COALESCE(locality, area) AS locality, latitude, longitude, operating_info, opening_time, closing_time, is_open_24_hours, location_accuracy, location_source, is_active, created_at, updated_at
      FROM ${this.tableName}
      WHERE partner_id = $1 AND is_active = true
      ORDER BY created_at ASC
      LIMIT 1
    `;
    const res = client
      ? await client.query(text, [partnerId])
      : await this.query(text, [partnerId]);
    return res.rows[0] || null;
  }

  /**
   * Create shop within an existing client/transaction.
   *
   * @param {object} shopData
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async createShop(shopData, client) {
    const areaVal = shopData.area !== undefined ? shopData.area : (shopData.locality || null);
    const localityVal = shopData.locality !== undefined ? shopData.locality : (shopData.area || null);

    const text = `
      INSERT INTO ${this.tableName} (
        partner_id, shop_name, shop_address, landmark, city, area, locality, latitude, longitude, operating_info, opening_time, closing_time, is_open_24_hours, location_accuracy, location_source, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id, partner_id, shop_name, shop_address, landmark, city, COALESCE(area, locality) AS area, COALESCE(locality, area) AS locality, latitude, longitude, operating_info, opening_time, closing_time, is_open_24_hours, location_accuracy, location_source, is_active, created_at, updated_at
    `;
    const values = [
      shopData.partnerId,
      shopData.shopName.trim(),
      shopData.shopAddress ? shopData.shopAddress.trim() : `${shopData.shopName.trim()}, ${shopData.city.trim()}`,
      shopData.landmark ? shopData.landmark.trim() : null,
      shopData.city.trim(),
      areaVal ? String(areaVal).trim() : null,
      localityVal ? String(localityVal).trim() : null,
      (shopData.latitude !== undefined && shopData.latitude !== null) ? Number(shopData.latitude) : null,
      (shopData.longitude !== undefined && shopData.longitude !== null) ? Number(shopData.longitude) : null,
      shopData.operatingInfo || '08:00 AM - 10:00 PM (All Days)',
      shopData.openingTime || null,
      shopData.closingTime || null,
      Boolean(shopData.isOpen24Hours),
      (shopData.locationAccuracy !== undefined && shopData.locationAccuracy !== null) ? Number(shopData.locationAccuracy) : null,
      shopData.locationSource || null,
      shopData.isActive !== undefined ? shopData.isActive : true,
    ];

    const res = await client.query(text, values);
    return res.rows[0];
  }

  /**
   * Update shop details for partner.
   *
   * @param {string} partnerId
   * @param {object} updates
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateShop(partnerId, updates, client = null) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (updates.shopName !== undefined) {
      fields.push(`shop_name = $${idx}`);
      idx += 1;
      values.push(updates.shopName.trim());
    }

    if (updates.shopAddress !== undefined) {
      fields.push(`shop_address = $${idx}`);
      idx += 1;
      values.push(updates.shopAddress.trim());
    }

    if (updates.landmark !== undefined) {
      fields.push(`landmark = $${idx}`);
      idx += 1;
      values.push(updates.landmark ? updates.landmark.trim() : null);
    }

    if (updates.city !== undefined) {
      fields.push(`city = $${idx}`);
      idx += 1;
      values.push(updates.city.trim());
    }

    if (updates.area !== undefined || updates.locality !== undefined) {
      const areaVal = updates.area !== undefined ? updates.area : updates.locality;
      const locVal = updates.locality !== undefined ? updates.locality : updates.area;
      fields.push(`area = $${idx}`);
      idx += 1;
      values.push(areaVal ? String(areaVal).trim() : null);
      fields.push(`locality = $${idx}`);
      idx += 1;
      values.push(locVal ? String(locVal).trim() : null);
    }

    if (updates.latitude !== undefined) {
      fields.push(`latitude = $${idx}`);
      idx += 1;
      values.push(updates.latitude !== null ? Number(updates.latitude) : null);
    }

    if (updates.longitude !== undefined) {
      fields.push(`longitude = $${idx}`);
      idx += 1;
      values.push(updates.longitude !== null ? Number(updates.longitude) : null);
    }

    if (updates.operatingInfo !== undefined) {
      fields.push(`operating_info = $${idx}`);
      idx += 1;
      values.push(updates.operatingInfo ? updates.operatingInfo.trim() : null);
    }

    if (updates.openingTime !== undefined) {
      fields.push(`opening_time = $${idx}`);
      idx += 1;
      values.push(updates.openingTime || null);
    }

    if (updates.closingTime !== undefined) {
      fields.push(`closing_time = $${idx}`);
      idx += 1;
      values.push(updates.closingTime || null);
    }

    if (updates.isOpen24Hours !== undefined) {
      fields.push(`is_open_24_hours = $${idx}`);
      idx += 1;
      values.push(Boolean(updates.isOpen24Hours));
    }

    if (updates.locationAccuracy !== undefined) {
      fields.push(`location_accuracy = $${idx}`);
      idx += 1;
      values.push(updates.locationAccuracy !== null ? Number(updates.locationAccuracy) : null);
    }

    if (updates.locationSource !== undefined) {
      fields.push(`location_source = $${idx}`);
      idx += 1;
      values.push(updates.locationSource || null);
    }

    if (fields.length === 0) {
      return this.findByPartnerId(partnerId, client);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    values.push(partnerId);
    const text = `
      UPDATE ${this.tableName}
      SET ${fields.join(', ')}
      WHERE partner_id = $${idx} AND is_active = true
      RETURNING id, partner_id, shop_name, shop_address, landmark, city, COALESCE(area, locality) AS area, COALESCE(locality, area) AS locality, latitude, longitude, operating_info, opening_time, closing_time, is_open_24_hours, location_accuracy, location_source, is_active, created_at, updated_at
    `;

    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows[0] || null;
  }
}

module.exports = ShopRepository;
