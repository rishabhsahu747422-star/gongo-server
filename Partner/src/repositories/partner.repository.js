'use strict';

const crypto = require('crypto');
const BaseRepository = require('../db/base.repository');
const { generateUniqueEntityReference } = require('../utils/reference-generator');

let mockPartnerResolver = null;

class PartnerRepository extends BaseRepository {
  constructor() {
    super('partners', 'id');
  }

  /**
   * Resolves partner account by external authentication ID (Firebase UID).
   *
   * @param {string} authId External Firebase UID
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>} Combined user and partner record or null
   */
  async findByAuthId(authId, client = null) {
    if (mockPartnerResolver) {
      return mockPartnerResolver(authId);
    }

    try {
      const text = `
        SELECT 
          p.id AS id,
          p.id AS partner_id,
          p.partner_reference,
          p.user_id,
          p.partner_status,
          p.kyc_status,
          p.profile_image_url,
          p.business_name,
          p.business_address,
          p.landmark,
          p.city,
          COALESCE(p.area, p.locality) AS area,
          COALESCE(p.locality, p.area) AS locality,
          p.latitude,
          p.longitude,
          p.operating_info,
          p.opening_time,
          p.closing_time,
          p.is_open_24_hours,
          p.location_accuracy,
          p.location_source,
          p.rating,
          p.review_count,
          p.registered_since,
          p.is_active AS partner_is_active,
          p.partner_reference,
          p.partner_code,
          u.id AS user_primary_id,
          u.auth_id,
          u.role,
          u.name,
          u.phone,
          u.email,
          u.is_active AS user_is_active,
          u.created_at AS user_created_at
        FROM users u
        LEFT JOIN ${this.tableName} p ON p.user_id = u.id
        WHERE u.auth_id = $1
        LIMIT 1
      `;
      const res = client ? await client.query(text, [authId]) : await this.query(text, [authId]);
      if (!res.rows[0]) return null;

      const row = res.rows[0];
      return {
        id: row.partner_id || row.user_primary_id,
        partnerId: row.partner_id || null,
        partnerReference: row.partner_reference || null,
        userId: row.user_primary_id,
        auth_id: row.auth_id,
        role: row.role ? String(row.role).toUpperCase() : 'PARTNER',
        name: row.name,
        phone: row.phone,
        email: row.email,
        is_active: row.partner_id
          ? (row.partner_is_active && row.user_is_active)
          : row.user_is_active,
        partner_status: row.partner_status ? String(row.partner_status).toUpperCase() : 'OFFLINE',
        kyc_status: row.kyc_status ? String(row.kyc_status).toUpperCase() : 'PENDING',
        business_name: row.business_name || null,
        business_address: row.business_address || null,
        landmark: row.landmark || null,
        city: row.city || null,
        area: row.area || row.locality || null,
        locality: row.locality || row.area || null,
        latitude: (row.latitude !== null && row.latitude !== undefined)
          ? Number(row.latitude)
          : null,
        longitude: (row.longitude !== null && row.longitude !== undefined)
          ? Number(row.longitude)
          : null,
        operating_info: row.operating_info || null,
        opening_time: row.opening_time || null,
        closing_time: row.closing_time || null,
        is_open_24_hours: Boolean(row.is_open_24_hours),
        location_accuracy: (row.location_accuracy !== null && row.location_accuracy !== undefined)
          ? Number(row.location_accuracy)
          : null,
        location_source: row.location_source || null,
        rating: row.rating !== undefined ? Number(row.rating) : null,
        review_count: row.review_count !== undefined ? Number(row.review_count) : 0,
        registered_since: row.registered_since || null,
        profile_image_url: row.profile_image_url || null,
        partner_reference: row.partner_reference || null,
        partner_code: row.partner_code || null,
      };
    } catch (err) {
      if (err.code === '42P01') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Resolves partner account by mobile phone number.
   *
   * @param {string} phone
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByPhone(phone, client = null) {
    if (mockPartnerResolver) {
      return mockPartnerResolver(phone);
    }

    try {
      const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);
      const text = `
        SELECT 
          p.id AS id,
          p.id AS partner_id,
          p.partner_reference,
          p.user_id,
          p.partner_status,
          p.kyc_status,
          p.profile_image_url,
          p.business_name,
          p.business_address,
          p.landmark,
          p.city,
          COALESCE(p.area, p.locality) AS area,
          COALESCE(p.locality, p.area) AS locality,
          p.latitude,
          p.longitude,
          p.operating_info,
          p.opening_time,
          p.closing_time,
          p.is_open_24_hours,
          p.location_accuracy,
          p.location_source,
          p.rating,
          p.review_count,
          p.registered_since,
          p.is_active AS partner_is_active,
          p.partner_reference,
          p.partner_code,
          u.id AS user_primary_id,
          u.auth_id,
          u.role,
          u.name,
          u.phone,
          u.email,
          u.is_active AS user_is_active,
          u.created_at AS user_created_at
        FROM users u
        JOIN ${this.tableName} p ON p.user_id = u.id
        WHERE (u.phone = $1 OR RIGHT(u.phone, 10) = $1 OR u.phone = $2)
        ORDER BY CASE WHEN LOWER(u.role) = 'partner' THEN 0 ELSE 1 END
        LIMIT 1
      `;
      const fullPhone = `+91${cleanPhone}`;
      const res = client ? await client.query(text, [cleanPhone, fullPhone]) : await this.query(text, [cleanPhone, fullPhone]);
      if (!res.rows[0]) return null;

      const row = res.rows[0];
      return {
        id: row.partner_id || row.user_primary_id,
        partnerId: row.partner_id || null,
        partnerReference: row.partner_reference || null,
        userId: row.user_primary_id,
        auth_id: row.auth_id,
        role: row.role ? String(row.role).toUpperCase() : 'PARTNER',
        name: row.name,
        phone: row.phone,
        email: row.email,
        is_active: row.partner_id
          ? (row.partner_is_active && row.user_is_active)
          : row.user_is_active,
        partner_status: row.partner_status ? String(row.partner_status).toUpperCase() : 'OFFLINE',
        kyc_status: row.kyc_status ? String(row.kyc_status).toUpperCase() : 'PENDING',
        business_name: row.business_name || null,
        business_address: row.business_address || null,
        landmark: row.landmark || null,
        city: row.city || null,
        area: row.area || row.locality || null,
        locality: row.locality || row.area || null,
        latitude: (row.latitude !== null && row.latitude !== undefined) ? Number(row.latitude) : null,
        longitude: (row.longitude !== null && row.longitude !== undefined) ? Number(row.longitude) : null,
        operating_info: row.operating_info || null,
        opening_time: row.opening_time || null,
        closing_time: row.closing_time || null,
        is_open_24_hours: Boolean(row.is_open_24_hours),
        location_accuracy: (row.location_accuracy !== null && row.location_accuracy !== undefined) ? Number(row.location_accuracy) : null,
        location_source: row.location_source || null,
        rating: row.rating !== undefined ? Number(row.rating) : null,
        review_count: row.review_count !== undefined ? Number(row.review_count) : 0,
        registered_since: row.registered_since || null,
        profile_image_url: row.profile_image_url || null,
        partner_reference: row.partner_reference || null,
        partner_code: row.partner_code || null,
      };
    } catch (err) {
      if (err.code === '42P01') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Resolves partner account by primary key ID.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findById(partnerId, client = null) {
    if (mockPartnerResolver) {
      return mockPartnerResolver(partnerId);
    }

    try {
      const text = `
        SELECT 
          p.id AS id,
          p.id AS partner_id,
          p.partner_reference,
          p.user_id,
          p.partner_status,
          p.kyc_status,
          p.profile_image_url,
          p.business_name,
          p.business_address,
          p.landmark,
          p.city,
          COALESCE(p.area, p.locality) AS area,
          COALESCE(p.locality, p.area) AS locality,
          p.latitude,
          p.longitude,
          p.operating_info,
          p.opening_time,
          p.closing_time,
          p.is_open_24_hours,
          p.location_accuracy,
          p.location_source,
          p.rating,
          p.review_count,
          p.registered_since,
          p.is_active AS partner_is_active,
          p.partner_reference,
          p.partner_code,
          u.id AS user_primary_id,
          u.auth_id,
          u.role,
          u.name,
          u.phone,
          u.email,
          u.is_active AS user_is_active
        FROM ${this.tableName} p
        JOIN users u ON u.id = p.user_id
        WHERE p.id = $1
        LIMIT 1
      `;
      const res = client
        ? await client.query(text, [partnerId])
        : await this.query(text, [partnerId]);
      if (!res.rows[0]) return null;

      const row = res.rows[0];
      return {
        id: row.partner_id,
        partnerId: row.partner_id,
        partnerReference: row.partner_reference || null,
        userId: row.user_primary_id,
        auth_id: row.auth_id,
        role: row.role ? String(row.role).toUpperCase() : 'PARTNER',
        name: row.name,
        phone: row.phone,
        email: row.email,
        is_active: row.partner_is_active && row.user_is_active,
        partner_status: row.partner_status ? String(row.partner_status).toUpperCase() : 'OFFLINE',
        kyc_status: row.kyc_status ? String(row.kyc_status).toUpperCase() : 'PENDING',
        business_name: row.business_name || null,
        business_address: row.business_address || null,
        landmark: row.landmark || null,
        city: row.city || null,
        area: row.area || row.locality || null,
        locality: row.locality || row.area || null,
        latitude: (row.latitude !== null && row.latitude !== undefined)
          ? Number(row.latitude)
          : null,
        longitude: (row.longitude !== null && row.longitude !== undefined)
          ? Number(row.longitude)
          : null,
        operating_info: row.operating_info || null,
        opening_time: row.opening_time || null,
        closing_time: row.closing_time || null,
        is_open_24_hours: Boolean(row.is_open_24_hours),
        location_accuracy: (row.location_accuracy !== null && row.location_accuracy !== undefined)
          ? Number(row.location_accuracy)
          : null,
        location_source: row.location_source || null,
        rating: Number(row.rating),
        review_count: Number(row.review_count),
        registered_since: row.registered_since,
        profile_image_url: row.profile_image_url,
        partner_reference: row.partner_reference || null,
        partner_code: row.partner_code || null,
      };
    } catch (err) {
      if (err.code === '42P01') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Retrieves fully consolidated partner profile including shop, vehicle count, and primary bank.
   * Eliminates 3 sequential round trips.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async getFullProfile(partnerId, client = null) {
    if (mockPartnerResolver) {
      return null;
    }

    try {
      const text = `
        SELECT 
          p.id AS id,
          p.id AS partner_id,
          p.user_id,
          p.partner_status,
          p.kyc_status,
          p.profile_image_url,
          p.business_name,
          p.business_address,
          p.landmark,
          p.city,
          COALESCE(p.area, p.locality) AS area,
          COALESCE(p.locality, p.area) AS locality,
          p.latitude,
          p.longitude,
          p.operating_info,
          p.opening_time,
          p.closing_time,
          p.is_open_24_hours,
          p.location_accuracy,
          p.location_source,
          p.rating,
          p.review_count,
          p.registered_since,
          p.is_active AS partner_is_active,
          u.id AS user_primary_id,
          u.auth_id,
          u.role,
          u.name,
          u.phone,
          u.email,
          u.is_active AS user_is_active,
          sh.id AS shop_id,
          sh.shop_name,
          sh.shop_address,
          sh.landmark AS shop_landmark,
          sh.city AS shop_city,
          COALESCE(sh.area, sh.locality) AS shop_area,
          COALESCE(sh.locality, sh.area) AS shop_locality,
          sh.latitude AS shop_latitude,
          sh.longitude AS shop_longitude,
          sh.operating_info AS shop_operating_info,
          sh.opening_time AS shop_opening_time,
          sh.closing_time AS shop_closing_time,
          sh.is_open_24_hours AS shop_is_open_24_hours,
          sh.location_accuracy AS shop_location_accuracy,
          sh.location_source AS shop_location_source,
          (SELECT COUNT(*)::int FROM vehicles WHERE partner_id = p.id AND is_archived = false) AS vehicle_count,
          ba.id AS bank_id,
          ba.bank_name,
          ba.account_holder_name,
          ba.account_number_masked,
          ba.ifsc_code,
          ba.is_primary AS bank_is_primary,
          ba.verification_status AS bank_verification_status
        FROM ${this.tableName} p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN shops sh ON sh.partner_id = p.id AND sh.is_active = true
        LEFT JOIN LATERAL (
          SELECT id, bank_name, account_holder_name, account_number_masked, ifsc_code, is_primary, verification_status
          FROM partner_bank_accounts
          WHERE partner_id = p.id AND is_primary = true
          LIMIT 1
        ) ba ON true
        WHERE p.id = $1
        LIMIT 1;
      `;
      const res = client
        ? await client.query(text, [partnerId])
        : await this.query(text, [partnerId]);
      if (!res.rows[0]) return null;

      const row = res.rows[0];
      return {
        partner: {
          id: row.partner_id,
          partnerId: row.partner_id,
          userId: row.user_primary_id,
          auth_id: row.auth_id,
          role: row.role ? String(row.role).toUpperCase() : 'PARTNER',
          name: row.name,
          phone: row.phone,
          email: row.email,
          is_active: row.partner_is_active && row.user_is_active,
          partner_status: row.partner_status ? String(row.partner_status).toUpperCase() : 'OFFLINE',
          kyc_status: row.kyc_status ? String(row.kyc_status).toUpperCase() : 'PENDING',
          business_name: row.business_name || null,
          business_address: row.business_address || null,
          landmark: row.landmark || null,
          city: row.city || null,
          area: row.area || row.locality || null,
          locality: row.locality || row.area || null,
          latitude: (row.latitude !== null && row.latitude !== undefined) ? Number(row.latitude) : null,
          longitude: (row.longitude !== null && row.longitude !== undefined) ? Number(row.longitude) : null,
          operating_info: row.operating_info || null,
          opening_time: row.opening_time || null,
          closing_time: row.closing_time || null,
          is_open_24_hours: Boolean(row.is_open_24_hours),
          location_accuracy: (row.location_accuracy !== null && row.location_accuracy !== undefined) ? Number(row.location_accuracy) : null,
          location_source: row.location_source || null,
          rating: Number(row.rating),
          review_count: Number(row.review_count),
          registered_since: row.registered_since,
          profile_image_url: row.profile_image_url,
        },
        shop: row.shop_id ? {
          id: row.shop_id,
          shop_name: row.shop_name,
          shop_address: row.shop_address,
          landmark: row.shop_landmark || null,
          city: row.shop_city,
          area: row.shop_area || row.shop_locality || null,
          locality: row.shop_locality || row.shop_area || null,
          latitude: row.shop_latitude,
          longitude: row.shop_longitude,
          operating_info: row.shop_operating_info,
          opening_time: row.shop_opening_time || null,
          closing_time: row.shop_closing_time || null,
          is_open_24_hours: Boolean(row.shop_is_open_24_hours),
          location_accuracy: row.shop_location_accuracy,
          location_source: row.shop_location_source || null,
        } : null,
        vehicleCount: Number(row.vehicle_count || 0),
        primaryBank: row.bank_id ? {
          id: row.bank_id,
          bank_name: row.bank_name,
          account_holder_name: row.account_holder_name,
          account_number_masked: row.account_number_masked,
          ifsc_code: row.ifsc_code,
          is_primary: row.bank_is_primary,
          verification_status: row.bank_verification_status,
        } : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Acquire an exclusive row-level lock on partner record (FOR UPDATE).
   * Used to serialize concurrent KYC document submissions or status transitions.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async lockForUpdate(partnerId, client) {
    if (mockPartnerResolver) {
      const mock = mockPartnerResolver(partnerId);
      if (mock) {
        return {
          id: mock.id,
          user_id: mock.userId || mock.user_id,
          partner_status: mock.partner_status,
          kyc_status: mock.kyc_status,
          is_active: mock.is_active,
        };
      }
    }
    if (!client) {
      throw new Error('Transaction client is required for lockForUpdate');
    }
    const text = `
      SELECT id, user_id, partner_status, kyc_status
      FROM ${this.tableName}
      WHERE id = $1
      FOR UPDATE;
    `;
    const res = await client.query(text, [partnerId]);
    return res.rows[0] || null;
  }

  /**
   * Resolves partner record by user ID.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByUserId(userId, client = null) {
    const text = `
      SELECT id, user_id, partner_status, kyc_status, profile_image_url, business_name, business_address, landmark, city, COALESCE(area, locality) AS area, COALESCE(locality, area) AS locality, latitude, longitude, operating_info, opening_time, closing_time, is_open_24_hours, location_accuracy, location_source, rating, review_count, registered_since, is_active, created_at, updated_at
      FROM ${this.tableName}
      WHERE user_id = $1
      LIMIT 1
    `;
    const res = client ? await client.query(text, [userId]) : await this.query(text, [userId]);
    return res.rows[0] || null;
  }

  /**
   * Create partner record within an existing transaction.
   *
   * @param {object} partnerData
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async createPartner(partnerData, client) {
    const partnerReference = partnerData.partnerReference ||
      `PTR-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const areaVal = partnerData.area !== undefined ? partnerData.area : (partnerData.locality || null);
    const localityVal = partnerData.locality !== undefined ? partnerData.locality : (partnerData.area || null);

    const text = `
      INSERT INTO ${this.tableName} (
        user_id, partner_status, kyc_status, profile_image_url, business_name, business_address, landmark, city, area, locality, latitude, longitude, operating_info, opening_time, closing_time, is_open_24_hours, location_accuracy, location_source, registered_since, is_active, partner_reference
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING id, user_id, partner_status, kyc_status, profile_image_url, business_name, business_address, landmark, city, COALESCE(area, locality) AS area, COALESCE(locality, area) AS locality, latitude, longitude, operating_info, opening_time, closing_time, is_open_24_hours, location_accuracy, location_source, rating, review_count, registered_since, is_active, partner_reference, created_at, updated_at
    `;
    const values = [
      partnerData.userId,
      partnerData.partnerStatus || 'OFFLINE',
      partnerData.kycStatus || 'PENDING',
      partnerData.profileImageUrl || null,
      partnerData.businessName || null,
      partnerData.businessAddress || null,
      partnerData.landmark || null,
      partnerData.city || null,
      areaVal || null,
      localityVal || null,
      (partnerData.latitude !== undefined && partnerData.latitude !== null)
        ? Number(partnerData.latitude)
        : null,
      (partnerData.longitude !== undefined && partnerData.longitude !== null)
        ? Number(partnerData.longitude)
        : null,
      partnerData.operatingInfo || null,
      partnerData.openingTime || null,
      partnerData.closingTime || null,
      Boolean(partnerData.isOpen24Hours),
      (partnerData.locationAccuracy !== undefined && partnerData.locationAccuracy !== null)
        ? Number(partnerData.locationAccuracy)
        : null,
      partnerData.locationSource || null,
      partnerData.registeredSince || new Date().toLocaleString('en-IN', { month: 'short', year: 'numeric' }),
      partnerData.isActive !== undefined ? partnerData.isActive : true,
      partnerReference,
    ];

    const res = await client.query(text, values);
    return res.rows[0];
  }

  /**
   * Update partner details (profile_image_url, business details, location, working hours).
   * Rating, review count, kyc_status, partner_status, registered_since are server-controlled.
   *
   * @param {string} partnerId
   * @param {object} updates
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updatePartner(partnerId, updates, client = null) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (updates.profileImageUrl !== undefined) {
      fields.push(`profile_image_url = $${idx}`);
      idx += 1;
      values.push(updates.profileImageUrl || null);
    }

    if (updates.businessName !== undefined) {
      fields.push(`business_name = $${idx}`);
      idx += 1;
      values.push(updates.businessName || null);
    }

    if (updates.businessAddress !== undefined) {
      fields.push(`business_address = $${idx}`);
      idx += 1;
      values.push(updates.businessAddress || null);
    }

    if (updates.landmark !== undefined) {
      fields.push(`landmark = $${idx}`);
      idx += 1;
      values.push(updates.landmark || null);
    }

    if (updates.city !== undefined) {
      fields.push(`city = $${idx}`);
      idx += 1;
      values.push(updates.city || null);
    }

    if (updates.area !== undefined || updates.locality !== undefined) {
      const areaVal = updates.area !== undefined ? updates.area : updates.locality;
      const locVal = updates.locality !== undefined ? updates.locality : updates.area;
      fields.push(`area = $${idx}`);
      idx += 1;
      values.push(areaVal || null);
      fields.push(`locality = $${idx}`);
      idx += 1;
      values.push(locVal || null);
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
      values.push(updates.operatingInfo || null);
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
      return this.findById(partnerId, client);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    values.push(partnerId);
    const text = `
      UPDATE ${this.tableName}
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING id, user_id, partner_status, kyc_status, profile_image_url, business_name, business_address, landmark, city, COALESCE(area, locality) AS area, COALESCE(locality, area) AS locality, latitude, longitude, operating_info, opening_time, closing_time, is_open_24_hours, location_accuracy, location_source, rating, review_count, registered_since, is_active, created_at, updated_at
    `;

    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows[0] || null;
  }

  /**
   * Update partner KYC status.
   *
   * @param {string} partnerId
   * @param {string} kycStatus
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateKycStatus(partnerId, kycStatus, client = null) {
    const text = `
      UPDATE ${this.tableName}
      SET kyc_status = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    const res = client ? await client.query(text, [partnerId, kycStatus]) : await this.query(text, [partnerId, kycStatus]);
    return res.rows[0] || null;
  }

  /**
   * Count active vehicles for partner to accurately derive isNewPartner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async countVehicles(partnerId, client = null) {
    try {
      const text = `
        SELECT COUNT(*)::int AS count 
        FROM vehicles 
        WHERE partner_id = $1 AND is_archived = false
      `;
      const res = client
        ? await client.query(text, [partnerId])
        : await this.query(text, [partnerId]);
      return res.rows[0] ? Number(res.rows[0].count) : 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * Aggregate dashboard statistics for a partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getDashboardStats(partnerId, client = null) {
    const runQuery = (sql, params) => (client
      ? client.query(sql, params)
      : this.query(sql, params));

    const consolidatedSql = `
      WITH v_stats AS (
        SELECT
          COUNT(*)::int AS total_vehicles,
          COUNT(CASE WHEN v.rental_status IN ('BOOKED', 'ACTIVE') OR EXISTS (
            SELECT 1 FROM bookings bk WHERE bk.vehicle_id = v.id AND (
              bk.booking_status IN ('UPCOMING', 'CONFIRMED', 'ACTIVE', 'IN_PROGRESS', 'BOOKED', 'PAYMENT_COMPLETED', 'PAID')
              OR COALESCE(bk.status, '') IN ('confirmed', 'payment_completed', 'pickup_scheduled', 'active', 'in_progress', 'vehicle_picked')
            )
          ) THEN 1 END)::int AS booked_vehicles,
          COUNT(CASE WHEN (v.rental_status = 'IDLE' OR v.rental_status IS NULL) AND (v.manual_status = 'ONLINE' OR v.manual_status IS NULL) AND NOT EXISTS (
            SELECT 1 FROM bookings bk WHERE bk.vehicle_id = v.id AND (
              bk.booking_status IN ('UPCOMING', 'CONFIRMED', 'ACTIVE', 'IN_PROGRESS', 'BOOKED', 'PAYMENT_COMPLETED', 'PAID')
              OR COALESCE(bk.status, '') IN ('confirmed', 'payment_completed', 'pickup_scheduled', 'active', 'in_progress', 'vehicle_picked')
            )
          ) THEN 1 END)::int AS available_vehicles,
          COUNT(CASE WHEN v.manual_status = 'OFFLINE' THEN 1 END)::int AS unavailable_vehicles
        FROM vehicles v
        WHERE v.partner_id = $1 AND v.is_archived = false
      ),
      b_stats AS (
        SELECT
          COUNT(CASE WHEN (b.booking_status IN ('UPCOMING', 'CONFIRMED', 'BOOKED', 'PAYMENT_COMPLETED', 'PAID') OR COALESCE(b.status, '') IN ('confirmed', 'payment_completed', 'pickup_scheduled')) THEN 1 END)::int AS upcoming_bookings,
          COUNT(CASE WHEN (b.booking_status IN ('ACTIVE', 'IN_PROGRESS') OR COALESCE(b.status, '') IN ('active', 'in_progress', 'vehicle_picked')) THEN 1 END)::int AS active_rentals,
          COUNT(CASE WHEN (b.booking_status = 'COMPLETED' OR COALESCE(b.status, '') IN ('completed', 'returned')) THEN 1 END)::int AS completed_bookings,
          COUNT(CASE WHEN (b.booking_status = 'CANCELLED' OR COALESCE(b.status, '') IN ('cancelled', 'refunded')) THEN 1 END)::int AS cancelled_bookings
        FROM bookings b
        JOIN vehicles v ON v.id = b.vehicle_id
        WHERE (b.partner_id = $1 OR v.partner_id = $1)
      ),
      e_stats AS (
        SELECT
          COALESCE(SUM(src.amount), 0)::numeric(12,2) AS total_earnings,
          COALESCE(SUM(CASE WHEN src.created_at >= date_trunc('month', CURRENT_TIMESTAMP) THEN src.amount ELSE 0 END), 0)::numeric(12,2) AS monthly_earnings,
          COALESCE(SUM(CASE WHEN src.created_at >= date_trunc('week', CURRENT_TIMESTAMP) THEN src.amount ELSE 0 END), 0)::numeric(12,2) AS weekly_earnings,
          COUNT(CASE WHEN src.settlement_status = 'PENDING' THEN 1 END)::int AS pending_settlements
        FROM (
          SELECT
            COALESCE(e.partner_net_amount, b.total_amount, 0) AS amount,
            COALESCE(e.settlement_status, CASE WHEN (b.booking_status = 'COMPLETED' OR COALESCE(b.status, '') IN ('completed', 'returned')) THEN 'SETTLED' ELSE 'PENDING' END) AS settlement_status,
            COALESCE(e.created_at, b.created_at) AS created_at
          FROM bookings b
          JOIN vehicles v ON v.id = b.vehicle_id
          LEFT JOIN earnings e ON e.booking_id = b.id
          WHERE (b.partner_id = $1 OR v.partner_id = $1)
            AND b.booking_status NOT IN ('CANCELLED', 'REFUNDED')
            AND COALESCE(b.status, '') NOT IN ('cancelled', 'refunded')
        ) src
      ),
      a_rentals AS (
        SELECT COALESCE(json_agg(ar), '[]'::json) AS active_rentals_json
        FROM (
          SELECT
            b.id,
            b.booking_number,
            b.customer_name,
            b.customer_phone,
            b.start_at,
            b.expected_return_at,
            v.brand,
            v.model,
            v.registration_number
          FROM bookings b
          JOIN vehicles v ON v.id = b.vehicle_id
          WHERE (b.partner_id = $1 OR v.partner_id = $1) AND (b.booking_status IN ('ACTIVE', 'IN_PROGRESS') OR COALESCE(b.status, '') IN ('active', 'in_progress', 'vehicle_picked'))
          ORDER BY b.start_at ASC
          LIMIT 5
        ) ar
      )
      SELECT
        v_stats.*,
        b_stats.*,
        e_stats.*,
        a_rentals.active_rentals_json
      FROM v_stats, b_stats, e_stats, a_rentals;
    `;

    const res = await runQuery(consolidatedSql, [partnerId]).catch(() => ({ rows: [{}] }));
    const row = res.rows[0] || {};
    const activeRentals = Array.isArray(row.active_rentals_json) ? row.active_rentals_json : [];

    return {
      totalVehicles: Number(row.total_vehicles || 0),
      bookedVehicles: Number(row.booked_vehicles || 0),
      availableVehicles: Number(row.available_vehicles || 0),
      unavailableVehicles: Number(row.unavailable_vehicles || 0),
      upcomingBookings: Number(row.upcoming_bookings || 0),
      activeRentals: Number(row.active_rentals || 0),
      completedBookings: Number(row.completed_bookings || 0),
      cancelledBookings: Number(row.cancelled_bookings || 0),
      earnings: {
        totalEarnings: Number(Number(row.total_earnings || 0).toFixed(2)),
        monthlyEarnings: Number(Number(row.monthly_earnings || 0).toFixed(2)),
        weeklyEarnings: Number(Number(row.weekly_earnings || 0).toFixed(2)),
        pendingSettlements: Number(row.pending_settlements || 0),
      },
      activeRentalsSummary: activeRentals.map((r) => ({
        id: r.id,
        bookingNumber: r.booking_number,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        vehicleName: `${r.brand} ${r.model}`,
        registrationNumber: r.registration_number,
        startAt: r.start_at,
        expectedReturnAt: r.expected_return_at,
      })),
    };
  }

  /**
   * Test-only resolver setter.
   */
  static setMockPartnerResolver(resolver) {
    mockPartnerResolver = resolver;
  }
}

module.exports = PartnerRepository;
