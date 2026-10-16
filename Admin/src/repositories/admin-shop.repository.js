'use strict';

const BaseRepository = require('../db/base.repository');
const logger = require('../config/logger');

let mockShopResolver = null;

class AdminShopRepository extends BaseRepository {
  constructor() {
    super('shops', 'id');
  }

  static setMockShopResolver(resolver) {
    mockShopResolver = resolver;
  }

  static resetMockShopResolver() {
    mockShopResolver = null;
  }

  _getExecutor(client) {
    return client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
  }

  /**
   * Retrieves paginated shops with partner info and vehicle counts.
   */
  async findAllPaginated({ search = null, status = null, city = null, partnerId = null, limit = 20, offset = 0 }, client = null) {
    if (mockShopResolver && mockShopResolver.findAllPaginated) {
      return mockShopResolver.findAllPaginated({ search, status, city, partnerId, limit, offset });
    }

    const executor = this._getExecutor(client);
    try {
      let whereClauses = [];
      let params = [];
      let idx = 1;

      if (search) {
        whereClauses.push(`(s.shop_name ILIKE $${idx} OR s.city ILIKE $${idx} OR p.business_name ILIKE $${idx})`);
        params.push(`%${search}%`);
        idx++;
      }
      if (status === 'active') {
        whereClauses.push(`s.is_active = true`);
      } else if (status === 'inactive' || status === 'suspended') {
        whereClauses.push(`s.is_active = false`);
      }
      if (city) {
        whereClauses.push(`s.city ILIKE $${idx}`);
        params.push(`%${city}%`);
        idx++;
      }
      if (partnerId) {
        whereClauses.push(`s.partner_id = $${idx}`);
        params.push(partnerId);
        idx++;
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      const countSql = `
        SELECT COUNT(s.id)::int AS total
        FROM shops s
        LEFT JOIN partners p ON s.partner_id = p.id
        ${whereSql};
      `;
      const countRes = await executor(countSql, params);
      const total = countRes.rows[0]?.total || 0;

      const dataSql = `
        SELECT
          s.id, s.partner_id, s.shop_name, s.shop_address, s.city, s.latitude, s.longitude,
          s.operating_info, s.is_active, s.created_at, s.updated_at,
          COALESCE(p.business_name, 'GOnGO Fleet Partner') AS partner_name,
          p.kyc_status AS partner_kyc_status,
          (SELECT COUNT(v.id)::int FROM vehicles v WHERE v.shop_id = s.id AND v.is_active = true) AS vehicle_count,
          sr.rating_avg AS rating,
          COALESCE(sr.rating_count, 0)::int AS review_count
        FROM shops s
        LEFT JOIN partners p ON s.partner_id = p.id
        LEFT JOIN (
          SELECT
            v.shop_id,
            ROUND(AVG(r.rating_score)::numeric, 1) AS rating_avg,
            COUNT(DISTINCT r.id)::int AS rating_count
          FROM ratings r
          JOIN vehicles v ON v.id = r.vehicle_id
          JOIN bookings b ON b.id = r.booking_id
          WHERE r.target_type = 'VEHICLE'
            AND r.status = 'APPROVED'
            AND (
              UPPER(COALESCE(b.booking_status, '')) IN ('COMPLETED', 'CONFIRMED')
              OR LOWER(COALESCE(b.status, '')) IN ('completed', 'returned')
            )
          GROUP BY v.shop_id
        ) sr ON sr.shop_id = s.id
        ${whereSql}
        ORDER BY s.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1};
      `;
      const dataParams = [...params, limit, offset];
      const res = await executor(dataSql, dataParams);

      return {
        shops: (res.rows || []).map(this._mapShopRow),
        total,
      };
    } catch (err) {
      logger.error('[AdminShopRepository] findAllPaginated error:', err);
    }

    return {
      shops: [],
      total: 0,
    };
  }

  /**
   * Retrieves single shop with full details.
   */
  async findById(shopId, client = null) {
    if (mockShopResolver && mockShopResolver.findById) {
      return mockShopResolver.findById(shopId);
    }

    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT
          s.id, s.partner_id, s.shop_name, s.shop_address, s.city, s.latitude, s.longitude,
          s.operating_info, s.is_active, s.created_at, s.updated_at,
          COALESCE(p.business_name, u.name, 'GOnGO Fleet Partner') AS partner_name,
          COALESCE(p.contact_phone, u.phone, '') AS partner_phone,
          p.kyc_status AS partner_kyc_status,
          (SELECT COUNT(v.id)::int FROM vehicles v WHERE v.shop_id = s.id AND v.is_active = true) AS vehicle_count,
          sr.rating_avg AS rating,
          COALESCE(sr.rating_count, 0)::int AS review_count
        FROM shops s
        LEFT JOIN partners p ON s.partner_id = p.id
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN (
          SELECT
            v.shop_id,
            ROUND(AVG(r.rating_score)::numeric, 1) AS rating_avg,
            COUNT(DISTINCT r.id)::int AS rating_count
          FROM ratings r
          JOIN vehicles v ON v.id = r.vehicle_id
          JOIN bookings b ON b.id = r.booking_id
          WHERE r.target_type = 'VEHICLE'
            AND r.status = 'APPROVED'
            AND (
              UPPER(COALESCE(b.booking_status, '')) IN ('COMPLETED', 'CONFIRMED')
              OR LOWER(COALESCE(b.status, '')) IN ('completed', 'returned')
            )
          GROUP BY v.shop_id
        ) sr ON sr.shop_id = s.id
        WHERE s.id = $1
        LIMIT 1;
      `;
      const res = await executor(sql, [shopId]);
      if (res.rows[0]) {
        return this._mapShopRow(res.rows[0]);
      }
    } catch (err) {
      logger.error(`[AdminShopRepository] findById error for ${shopId}:`, err);
    }

    return null;
  }

  /**
   * Updates shop status.
   */
  async updateStatus(shopId, { isActive }, client = null) {
    if (mockShopResolver && mockShopResolver.updateStatus) {
      return mockShopResolver.updateStatus(shopId, { isActive });
    }

    const executor = this._getExecutor(client);
    try {
      const sql = `
        UPDATE shops
        SET is_active = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, partner_id, shop_name, shop_address, city, is_active, updated_at;
      `;
      const res = await executor(sql, [shopId, isActive]);
      return res.rows[0] || null;
    } catch (_) {
      return { id: shopId, is_active: isActive };
    }
  }

  /**
   * Retrieves vehicles stationed at a shop.
   */
  async getShopVehicles(shopId, { limit = 20, offset = 0 } = {}, client = null) {
    if (mockShopResolver && mockShopResolver.getShopVehicles) {
      return mockShopResolver.getShopVehicles(shopId, { limit, offset });
    }

    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT
          v.id, v.shop_id, v.partner_id, v.brand, v.model AS model_name, v.registration_number,
          v.manual_status, v.rental_status, v.verification_status, NULL::numeric AS daily_rate,
          v.created_at, v.category,
          COALESCE(img.file_url, v.primary_image_url, '') AS cover_image_url
        FROM vehicles v
        LEFT JOIN (
          SELECT DISTINCT ON (vehicle_id) vehicle_id, file_url
          FROM vehicle_images
          WHERE is_active = true
          ORDER BY vehicle_id, is_cover DESC, sort_order ASC, created_at ASC
        ) img ON img.vehicle_id = v.id
        WHERE v.shop_id = $1 AND v.is_active = true
        ORDER BY v.created_at DESC
        LIMIT $2 OFFSET $3;
      `;
      const res = await executor(sql, [shopId, limit, offset]);
      return res.rows.map((v) => ({
        id: v.id,
        shopId: v.shop_id,
        partnerId: v.partner_id,
        brand: v.brand,
        modelName: v.model_name,
        registrationNumber: v.registration_number,
        manualStatus: v.manual_status,
        rentalStatus: v.rental_status,
        verificationStatus: v.verification_status,
        dailyRate: v.daily_rate ? parseFloat(v.daily_rate) : 0,
        category: v.category || 'Bike',
        isAvailable: v.manual_status === 'ONLINE' && v.rental_status === 'IDLE',
        coverImageUrl: v.cover_image_url || 'https://images.unsplash.com/photo-1558981403-c5f9899a28bc?w=500',
        createdAt: v.created_at,
      }));
    } catch (_) {}

    return [];
  }

  /**
   * Retrieves documents associated with a shop.
   */
  async getShopDocuments(shopId, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, shop_id, document_type, document_number, file_url, storage_path,
               verification_status, rejection_reason, uploaded_at, verified_at, created_at, updated_at
        FROM shop_documents
        WHERE shop_id = $1
        ORDER BY created_at DESC;
      `;
      const res = await executor(sql, [shopId]);
      return res.rows;
    } catch (_) {
      return [];
    }
  }

  /**
   * Retrieves images for a shop.
   */
  async getShopImages(shopId, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, shop_id, file_url, storage_path, image_type, display_order, is_primary, is_active, created_at, updated_at
        FROM shop_images
        WHERE shop_id = $1 AND is_active = true
        ORDER BY display_order ASC, created_at DESC;
      `;
      const res = await executor(sql, [shopId]);
      return res.rows;
    } catch (_) {
      return [];
    }
  }

  /**
   * Retrieves operating hours for a shop.
   */
  async getShopOperatingHours(shopId, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, shop_id, day_of_week, opens_at, closes_at, is_closed, created_at, updated_at
        FROM shop_operating_hours
        WHERE shop_id = $1
        ORDER BY day_of_week ASC;
      `;
      const res = await executor(sql, [shopId]);
      return res.rows;
    } catch (_) {
      return [];
    }
  }

  /**
   * Retrieves verification history for a shop.
   */
  async getShopVerificationHistory(shopId, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, shop_id, verification_type, old_status, new_status, reason, verified_by, created_at
        FROM shop_verification_history
        WHERE shop_id = $1
        ORDER BY created_at DESC;
      `;
      const res = await executor(sql, [shopId]);
      return res.rows;
    } catch (_) {
      return [];
    }
  }

  /**
   * Updates shop verification status and appends verification history.
   */
  async updateVerificationStatus(shopId, { status, reason = null, verifiedBy = null }, client = null) {
    const executor = this._getExecutor(client);
    try {
      const current = await this.findById(shopId, client);
      const oldStatus = current ? (current.verificationStatus || current.status) : null;

      const sql = `
        UPDATE shops
        SET verification_status = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
      const res = await executor(sql, [shopId, status]);

      await executor(
        `INSERT INTO shop_verification_history (id, shop_id, verification_type, old_status, new_status, reason, verified_by, created_at)
         VALUES (gen_random_uuid(), $1, 'SHOP_VERIFICATION', $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [shopId, oldStatus, status, reason, verifiedBy],
      );

      return res.rows[0];
    } catch (_) {
      return { id: shopId, verification_status: status };
    }
  }

  _mapShopRow(r) {
    return {
      id: r.id,
      name: r.shop_name || r.name,
      shopName: r.shop_name || r.name,
      partnerId: r.partner_id,
      partnerName: r.partner_name || 'GOnGO Fleet Partner',
      partnerPhone: r.partner_phone || r.contact_phone,
      address: r.shop_address || r.address_line1,
      shopAddress: r.shop_address || r.address_line1,
      addressLine1: r.address_line1,
      addressLine2: r.address_line2,
      city: r.city,
      latitude: r.latitude ? parseFloat(r.latitude) : null,
      longitude: r.longitude ? parseFloat(r.longitude) : null,
      status: r.status || (r.is_active ? 'active' : 'suspended'),
      isActive: r.is_active,
      verificationStatus: r.verification_status || (r.partner_kyc_status === 'VERIFIED' ? 'verified' : 'under_review'),
      vehicleCount: r.vehicle_count !== undefined ? parseInt(r.vehicle_count, 10) : 0,
      rating: r.rating !== null && r.rating !== undefined ? parseFloat(r.rating) : null,
      reviewCount: r.review_count !== undefined ? parseInt(r.review_count, 10) : 0,
      operatingInfo: r.operating_info,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

module.exports = new AdminShopRepository();
