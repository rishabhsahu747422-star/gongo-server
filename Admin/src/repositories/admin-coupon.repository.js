'use strict';

const BaseRepository = require('../db/base.repository');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const toSafeUuid = (val) => (typeof val === 'string' && UUID_REGEX.test(val.trim()) ? val.trim() : null);

class AdminCouponRepository extends BaseRepository {
  constructor() {
    super('coupons', 'id');
  }

  _getExecutor(client) {
    return client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
  }

  async listCoupons({ search, active, page = 1, limit = 20 } = {}, client = null) {
    const executor = this._getExecutor(client);
    const conditions = [];
    const params = [];
    let pIdx = 1;

    if (search && search.trim()) {
      conditions.push(`(code ILIKE $${pIdx} OR name ILIKE $${pIdx})`);
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

    const countSql = `SELECT COUNT(*)::int AS total FROM coupons ${whereClause};`;
    const dataSql = `
      SELECT id, code, name, description, discount_type, discount_value,
             max_discount_amount AS max_discount, max_discount_amount,
             min_booking_amount,
             usage_limit AS usage_limit_total, usage_limit,
             usage_limit_per_customer AS usage_limit_per_user, usage_limit_per_customer,
             used_count, valid_from, valid_until,
             is_active AS active, is_active,
             created_by, created_at, updated_at
      FROM coupons
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${pIdx} OFFSET $${pIdx + 1};
    `;

    try {
      const [countRes, dataRes] = await Promise.all([
        executor(countSql, params),
        executor(dataSql, [...params, safeLimit, offset]),
      ]);

      const total = countRes.rows[0] ? Number(countRes.rows[0].total) : 0;
      return {
        coupons: dataRes.rows || [],
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 1,
      };
    } catch (_) {
      return { coupons: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    }
  }

  async findCouponById(id, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, code, name, description, discount_type, discount_value,
               max_discount_amount AS max_discount, max_discount_amount,
               min_booking_amount,
               usage_limit AS usage_limit_total, usage_limit,
               usage_limit_per_customer AS usage_limit_per_user, usage_limit_per_customer,
               used_count, valid_from, valid_until,
               is_active AS active, is_active,
               created_by, created_at, updated_at
        FROM coupons
        WHERE id = $1
        LIMIT 1;
      `;
      const res = await executor(sql, [id]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }

  async findCouponRules(couponId, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, coupon_id, rule_type, category_id, partner_id, shop_id, vehicle_id, rule_value,
               is_active AS active, is_active, created_at
        FROM coupon_rules
        WHERE coupon_id = $1
        ORDER BY created_at ASC;
      `;
      const res = await executor(sql, [couponId]);
      return res.rows || [];
    } catch (_) {
      return [];
    }
  }

  async findCouponRedemptions(couponId, { page = 1, limit = 20 } = {}, client = null) {
    const executor = this._getExecutor(client);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    try {
      const countSql = `SELECT COUNT(*)::int AS total FROM coupon_redemptions WHERE coupon_id = $1;`;
      const dataSql = `
        SELECT cr.id, cr.coupon_id, cr.customer_id, cr.booking_id, cr.discount_amount, cr.redeemed_at,
               u.phone AS customer_phone, b.booking_number
        FROM coupon_redemptions cr
        LEFT JOIN users u ON cr.customer_id = u.id
        LEFT JOIN bookings b ON cr.booking_id = b.id
        WHERE cr.coupon_id = $1
        ORDER BY cr.redeemed_at DESC
        LIMIT $2 OFFSET $3;
      `;
      const [countRes, dataRes] = await Promise.all([
        executor(countSql, [couponId]),
        executor(dataSql, [couponId, safeLimit, offset]),
      ]);

      const total = countRes.rows[0] ? Number(countRes.rows[0].total) : 0;
      return {
        redemptions: dataRes.rows || [],
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 1,
      };
    } catch (_) {
      return { redemptions: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    }
  }

  async createCoupon(data, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      INSERT INTO coupons (
        code, name, description, discount_type, discount_value, max_discount_amount,
        min_booking_amount, usage_limit, usage_limit_per_customer, valid_from, valid_until, is_active, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, code, name, description, discount_type, discount_value,
                max_discount_amount AS max_discount, max_discount_amount,
                min_booking_amount,
                usage_limit AS usage_limit_total, usage_limit,
                usage_limit_per_customer AS usage_limit_per_user, usage_limit_per_customer,
                used_count, valid_from, valid_until,
                is_active AS active, is_active,
                created_by, created_at, updated_at;
    `;

    const rawType = (data.discount_type || data.discountType || 'percentage').toLowerCase();
    const discountType = rawType === 'flat' ? 'fixed' : rawType;

    const maxDiscount = data.max_discount !== undefined
      ? data.max_discount
      : (data.max_discount_amount !== undefined ? data.max_discount_amount : (data.maxDiscount !== undefined ? data.maxDiscount : null));

    const usageLimit = data.usage_limit !== undefined
      ? data.usage_limit
      : (data.usage_limit_total !== undefined ? data.usage_limit_total : (data.usageLimit !== undefined ? data.usageLimit : null));

    const usageLimitPerCustomer = data.usage_limit_per_customer !== undefined
      ? data.usage_limit_per_customer
      : (data.usage_limit_per_user !== undefined ? data.usage_limit_per_user : (data.usageLimitPerCustomer !== undefined ? data.usageLimitPerCustomer : (data.usageLimitPerUser !== undefined ? data.usageLimitPerUser : 1)));

    const isActive = data.is_active !== undefined
      ? Boolean(data.is_active)
      : (data.active !== undefined ? Boolean(data.active) : true);

    const validFrom = data.valid_from || data.validFrom || new Date().toISOString();
    const validUntil = data.valid_until || data.validUntil || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const params = [
      data.code.toUpperCase().trim(),
      data.name.trim(),
      data.description || null,
      discountType,
      Number(data.discount_value !== undefined ? data.discount_value : data.discountValue),
      maxDiscount !== null && maxDiscount !== undefined && maxDiscount !== '' ? Number(maxDiscount) : null,
      Number(data.min_booking_amount !== undefined ? data.min_booking_amount : (data.minBookingAmount || 0)),
      usageLimit ? Number(usageLimit) : null,
      usageLimitPerCustomer ? Number(usageLimitPerCustomer) : null,
      validFrom,
      validUntil,
      isActive,
      toSafeUuid(data.created_by),
    ];
    const res = await executor(sql, params);
    return res.rows[0];
  }

  async updateCoupon(id, updates, client = null) {
    const executor = this._getExecutor(client);
    const fields = [];
    const params = [];
    let pIdx = 1;

    const colMapping = {
      name: 'name',
      description: 'description',
      discount_type: 'discount_type',
      discountType: 'discount_type',
      discount_value: 'discount_value',
      discountValue: 'discount_value',
      max_discount: 'max_discount_amount',
      maxDiscount: 'max_discount_amount',
      max_discount_amount: 'max_discount_amount',
      min_booking_amount: 'min_booking_amount',
      minBookingAmount: 'min_booking_amount',
      usage_limit: 'usage_limit',
      usage_limit_total: 'usage_limit',
      usageLimit: 'usage_limit',
      usage_limit_per_user: 'usage_limit_per_customer',
      usage_limit_per_customer: 'usage_limit_per_customer',
      usageLimitPerUser: 'usage_limit_per_customer',
      usageLimitPerCustomer: 'usage_limit_per_customer',
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
        let val = updates[key];
        if (dbCol === 'discount_type' && typeof val === 'string') {
          val = val.toLowerCase() === 'flat' ? 'fixed' : val.toLowerCase();
        } else if (dbCol === 'is_active') {
          val = Boolean(val);
        } else if (['discount_value', 'max_discount_amount', 'min_booking_amount', 'usage_limit', 'usage_limit_per_customer'].includes(dbCol)) {
          val = val !== null && val !== undefined && val !== '' ? Number(val) : null;
        }
        fields.push(`${dbCol} = $${pIdx}`);
        params.push(val);
        handledDbCols.add(dbCol);
        pIdx++;
      }
    }

    if (fields.length === 0) {
      return this.findCouponById(id, client);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const sql = `
      UPDATE coupons
      SET ${fields.join(', ')}
      WHERE id = $${pIdx}
      RETURNING id, code, name, description, discount_type, discount_value,
                max_discount_amount AS max_discount, max_discount_amount,
                min_booking_amount,
                usage_limit AS usage_limit_total, usage_limit,
                usage_limit_per_customer AS usage_limit_per_user, usage_limit_per_customer,
                used_count, valid_from, valid_until,
                is_active AS active, is_active,
                created_by, created_at, updated_at;
    `;

    const res = await executor(sql, params);
    return res.rows[0] || null;
  }

  async deleteCoupon(id, client = null) {
    const executor = this._getExecutor(client);
    const sql = `DELETE FROM coupons WHERE id = $1 RETURNING id;`;
    const res = await executor(sql, [id]);
    return res.rows[0] || null;
  }
}

module.exports = new AdminCouponRepository();
