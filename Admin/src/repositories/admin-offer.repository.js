'use strict';

const BaseRepository = require('../db/base.repository');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const toSafeUuid = (val) => (typeof val === 'string' && UUID_REGEX.test(val.trim()) ? val.trim() : null);

class AdminOfferRepository extends BaseRepository {
  constructor() {
    super('offers', 'id');
  }

  _getExecutor(client) {
    return client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
  }

  async listOffers({ search, active, page = 1, limit = 20 } = {}, client = null) {
    const executor = this._getExecutor(client);
    const conditions = [];
    const params = [];
    let pIdx = 1;

    if (search && search.trim()) {
      conditions.push(`(name ILIKE $${pIdx} OR description ILIKE $${pIdx})`);
      params.push(`%${search.trim()}%`);
      pIdx++;
    }

    if (active !== undefined && active !== null && active !== '') {
      conditions.push(`is_active = $${pIdx}`);
      params.push(active === true || active === 'true');
      pIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    try {
      const countSql = `SELECT COUNT(*)::int AS total FROM offers ${whereClause};`;
      const dataSql = `
        SELECT id, name, description, offer_type, discount_type, discount_value,
               max_discount_amount AS max_discount, max_discount_amount, valid_from, valid_until,
               is_active AS active, is_active, created_by, created_at, updated_at
        FROM offers
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${pIdx} OFFSET $${pIdx + 1};
      `;

      const [countRes, dataRes] = await Promise.all([
        executor(countSql, params),
        executor(dataSql, [...params, safeLimit, offset]),
      ]);

      const total = countRes.rows[0] ? Number(countRes.rows[0].total) : 0;
      return {
        offers: dataRes.rows || [],
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 1,
      };
    } catch (_) {
      return { offers: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    }
  }

  async findOfferById(id, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, name, description, offer_type, discount_type, discount_value,
               max_discount_amount AS max_discount, max_discount_amount, valid_from, valid_until,
               is_active AS active, is_active, created_by, created_at, updated_at
        FROM offers
        WHERE id = $1
        LIMIT 1;
      `;
      const res = await executor(sql, [id]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }

  async findOfferVehicles(offerId, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT ov.id, ov.offer_id, ov.vehicle_id, ov.created_at,
               v.name AS vehicle_name, v.registration_number
        FROM offer_vehicles ov
        LEFT JOIN vehicles v ON ov.vehicle_id = v.id
        WHERE ov.offer_id = $1
        ORDER BY ov.created_at ASC;
      `;
      const res = await executor(sql, [offerId]);
      return res.rows || [];
    } catch (_) {
      return [];
    }
  }

  async findOfferShops(offerId, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT os.id, os.offer_id, os.shop_id, os.created_at,
               s.name AS shop_name, s.shop_code
        FROM offer_shops os
        LEFT JOIN shops s ON os.shop_id = s.id
        WHERE os.offer_id = $1
        ORDER BY os.created_at ASC;
      `;
      const res = await executor(sql, [offerId]);
      return res.rows || [];
    } catch (_) {
      return [];
    }
  }

  async createOffer(data, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      INSERT INTO offers (
        name, description, offer_type, discount_type, discount_value, max_discount_amount,
        valid_from, valid_until, is_active, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, description, offer_type, discount_type, discount_value,
                max_discount_amount AS max_discount, max_discount_amount, valid_from, valid_until,
                is_active AS active, is_active, created_by, created_at, updated_at;
    `;
    const rawDiscountType = data.discount_type || data.discountType || 'percentage';
    const discountType = typeof rawDiscountType === 'string' && rawDiscountType.toLowerCase() === 'flat' ? 'fixed' : rawDiscountType;
    const validFrom = data.valid_from || data.validFrom || new Date().toISOString();
    const validUntil = data.valid_until || data.validUntil || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const maxDiscount = data.max_discount !== undefined
      ? data.max_discount
      : (data.max_discount_amount !== undefined ? data.max_discount_amount : (data.maxDiscount !== undefined ? data.maxDiscount : null));

    const params = [
      data.name.trim(),
      data.description || null,
      data.offer_type || data.offerType || 'discount',
      discountType,
      data.discount_value !== undefined ? Number(data.discount_value) : (data.discountValue !== undefined ? Number(data.discountValue) : null),
      maxDiscount !== null && maxDiscount !== undefined && maxDiscount !== '' ? Number(maxDiscount) : null,
      validFrom,
      validUntil,
      data.active !== undefined ? Boolean(data.active) : (data.is_active !== undefined ? Boolean(data.is_active) : true),
      toSafeUuid(data.created_by),
    ];
    const res = await executor(sql, params);
    return res.rows[0];
  }

  async updateOffer(id, updates, client = null) {
    const executor = this._getExecutor(client);
    const fields = [];
    const params = [];
    let pIdx = 1;

    const colMapping = {
      name: 'name',
      description: 'description',
      offer_type: 'offer_type',
      offerType: 'offer_type',
      discount_type: 'discount_type',
      discountType: 'discount_type',
      discount_value: 'discount_value',
      discountValue: 'discount_value',
      max_discount: 'max_discount_amount',
      maxDiscount: 'max_discount_amount',
      max_discount_amount: 'max_discount_amount',
      valid_from: 'valid_from',
      validFrom: 'valid_from',
      valid_until: 'valid_until',
      validUntil: 'valid_until',
      active: 'is_active',
      isActive: 'is_active',
      is_active: 'is_active',
    };

    const handledDbCols = new Set();
    for (const [key, dbCol] of Object.entries(colMapping)) {
      if (updates[key] !== undefined && !handledDbCols.has(dbCol)) {
        fields.push(`${dbCol} = $${pIdx}`);
        params.push(updates[key]);
        handledDbCols.add(dbCol);
        pIdx++;
      }
    }

    if (fields.length === 0) {
      return this.findOfferById(id, client);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const sql = `
      UPDATE offers
      SET ${fields.join(', ')}
      WHERE id = $${pIdx}
      RETURNING id, name, description, offer_type, discount_type, discount_value,
                max_discount_amount AS max_discount, max_discount_amount, valid_from, valid_until,
                is_active AS active, is_active, created_by, created_at, updated_at;
    `;

    const res = await executor(sql, params);
    return res.rows[0] || null;
  }

  async deleteOffer(id, client = null) {
    const executor = this._getExecutor(client);
    const sql = `DELETE FROM offers WHERE id = $1 RETURNING id;`;
    const res = await executor(sql, [id]);
    return res.rows[0] || null;
  }

  async addVehicleToOffer(offerId, vehicleId, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      INSERT INTO offer_vehicles (offer_id, vehicle_id)
      VALUES ($1, $2)
      ON CONFLICT (offer_id, vehicle_id) DO NOTHING
      RETURNING *;
    `;
    const res = await executor(sql, [offerId, vehicleId]);
    return res.rows[0] || { offer_id: offerId, vehicle_id: vehicleId };
  }

  async removeVehicleFromOffer(offerId, vehicleId, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      DELETE FROM offer_vehicles
      WHERE offer_id = $1 AND vehicle_id = $2
      RETURNING *;
    `;
    const res = await executor(sql, [offerId, vehicleId]);
    return res.rows[0] || null;
  }

  async addShopToOffer(offerId, shopId, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      INSERT INTO offer_shops (offer_id, shop_id)
      VALUES ($1, $2)
      ON CONFLICT (offer_id, shop_id) DO NOTHING
      RETURNING *;
    `;
    const res = await executor(sql, [offerId, shopId]);
    return res.rows[0] || { offer_id: offerId, shop_id: shopId };
  }

  async removeShopFromOffer(offerId, shopId, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      DELETE FROM offer_shops
      WHERE offer_id = $1 AND shop_id = $2
      RETURNING *;
    `;
    const res = await executor(sql, [offerId, shopId]);
    return res.rows[0] || null;
  }
}

module.exports = new AdminOfferRepository();
