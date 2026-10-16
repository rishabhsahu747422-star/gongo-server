'use strict';

const BaseRepository = require('../db/base.repository');

let mockPartnerResolver = null;

class AdminPartnerRepository extends BaseRepository {
  constructor() {
    super('partners', 'id');
  }

  /**
   * For unit testing: inject mock resolver
   * @param {object|null} resolver
   */
  static setMockPartnerResolver(resolver) {
    mockPartnerResolver = resolver;
  }

  static resetMockPartnerResolver() {
    mockPartnerResolver = null;
  }

  /**
   * Returns appropriate query executor (client or pool query).
   * @private
   */
  _getExecutor(client) {
    return client && typeof client.query === 'function'
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
  }

  /**
   * Escapes LIKE/ILIKE special wildcard characters to ensure literal matching.
   * @private
   */
  _escapeLikeWildcards(str) {
    return str.replace(/([%_\\])/g, '\\$1');
  }

  /**
   * Lists partners with parameterized filtering, search, pagination, and sorting.
   *
   * @param {object} params
   * @param {string} [params.search]
   * @param {string} [params.partnerStatus]
   * @param {string} [params.kycStatus]
   * @param {boolean} [params.isActive]
   * @param {string} [params.city]
   * @param {Date} [params.startDate]
   * @param {Date} [params.endDate]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {string} [params.sortBy='created_at']
   * @param {string} [params.sortOrder='DESC']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ partners: object[], total: number }>}
   */
  async listPartners({
    search = null,
    partnerStatus = null,
    kycStatus = null,
    isActive = null,
    city = null,
    startDate = null,
    endDate = null,
    limit = 10,
    offset = 0,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  } = {}, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.listPartners) {
      return mockPartnerResolver.listPartners({
        search,
        partnerStatus,
        kycStatus,
        isActive,
        city,
        startDate,
        endDate,
        limit,
        offset,
        sortBy,
        sortOrder,
      });
    }

    const executor = this._getExecutor(client);
    const conditions = [];
    const values = [];

    let paramIdx = 1;

    if (search && typeof search === 'string' && search.trim()) {
      const sanitized = this._escapeLikeWildcards(search.trim());
      const pattern = `%${sanitized}%`;

      // Check if search looks like a UUID
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(search.trim());

      if (isUuid) {
        conditions.push(`(
          u.name ILIKE $${paramIdx} OR
          u.email ILIKE $${paramIdx} OR
          u.phone ILIKE $${paramIdx} OR
          p.business_name ILIKE $${paramIdx} OR
          p.partner_reference ILIKE $${paramIdx} OR
          p.id = $${paramIdx + 1}
        )`);
        values.push(pattern, search.trim());
        paramIdx += 2;
      } else {
        conditions.push(`(
          u.name ILIKE $${paramIdx} OR
          u.email ILIKE $${paramIdx} OR
          u.phone ILIKE $${paramIdx} OR
          p.business_name ILIKE $${paramIdx} OR
          p.partner_reference ILIKE $${paramIdx}
        )`);
        values.push(pattern);
        paramIdx += 1;
      }
    }

    if (partnerStatus) {
      conditions.push(`p.partner_status = $${paramIdx}`);
      values.push(partnerStatus);
      paramIdx += 1;
    }

    if (kycStatus) {
      conditions.push(`p.kyc_status = $${paramIdx}`);
      values.push(kycStatus);
      paramIdx += 1;
    }

    if (typeof isActive === 'boolean') {
      conditions.push(`p.is_active = $${paramIdx}`);
      values.push(isActive);
      paramIdx += 1;
    }

    if (city && typeof city === 'string' && city.trim()) {
      conditions.push(`p.city ILIKE $${paramIdx}`);
      values.push(city.trim());
      paramIdx += 1;
    }

    if (startDate instanceof Date) {
      conditions.push(`p.created_at >= $${paramIdx}`);
      values.push(startDate);
      paramIdx += 1;
    }

    if (endDate instanceof Date) {
      conditions.push(`p.created_at < $${paramIdx}`);
      values.push(endDate);
      paramIdx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Whitelist sort column
    const ALLOWED_SORT_COLS = {
      created_at: 'p.created_at',
      updated_at: 'p.updated_at',
      rating: 'p.rating',
      review_count: 'p.review_count',
      business_name: 'p.business_name',
    };
    const sortCol = ALLOWED_SORT_COLS[sortBy] || 'p.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    values.push(safeLimit, safeOffset);
    const limitIdx = paramIdx;
    const offsetIdx = paramIdx + 1;

    const sql = `
      SELECT
        p.id,
        p.partner_reference,
        p.user_id,
        p.business_name,
        p.business_address,
        p.city,
        p.latitude,
        p.longitude,
        p.operating_info,
        p.status,
        p.partner_status,
        p.kyc_status,
        p.profile_image_url,
        COALESCE(pr.rating_avg, pvr.rating_avg)::numeric AS rating,
        COALESCE(pr.rating_count, pvr.rating_count, 0)::int AS review_count,
        p.registered_since,
        p.is_active,
        p.created_at,
        p.updated_at,
        u.name AS user_name,
        u.email AS user_email,
        u.phone AS user_phone,
        u.country_code AS user_country_code,
        COALESCE(v.vehicle_count, 0)::int AS vehicle_count,
        COALESCE(b.booking_count, 0)::int AS booking_count,
        COUNT(*) OVER()::int AS full_count
      FROM partners p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN (
        SELECT partner_id, COUNT(*)::int AS vehicle_count
        FROM vehicles
        WHERE is_active = true
        GROUP BY partner_id
      ) v ON v.partner_id = p.id
      LEFT JOIN (
        SELECT partner_id, COUNT(*)::int AS booking_count
        FROM bookings
        GROUP BY partner_id
      ) b ON b.partner_id = p.id
      LEFT JOIN (
        SELECT
          r.partner_id,
          ROUND(AVG(r.rating_score)::numeric, 1) AS rating_avg,
          COUNT(DISTINCT r.id)::int AS rating_count
        FROM ratings r
        JOIN bookings b ON b.id = r.booking_id
        WHERE r.target_type = 'PARTNER'
          AND r.status = 'APPROVED'
          AND (
            UPPER(COALESCE(b.booking_status, '')) IN ('COMPLETED', 'CONFIRMED')
            OR LOWER(COALESCE(b.status, '')) IN ('completed', 'returned')
          )
        GROUP BY r.partner_id
      ) pr ON pr.partner_id = p.id
      LEFT JOIN (
        SELECT
          v.partner_id,
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
        GROUP BY v.partner_id
      ) pvr ON pvr.partner_id = p.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}, p.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const res = await executor(sql, values);
    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;

    const partners = res.rows.map((r) => ({
      id: r.id,
      partnerReference: r.partner_reference || null,
      userId: r.user_id,
      name: r.user_name,
      email: r.user_email,
      phone: r.user_phone,
      countryCode: r.user_country_code,
      businessName: r.business_name,
      businessAddress: r.business_address,
      city: r.city,
      latitude: r.latitude ? parseFloat(r.latitude) : null,
      longitude: r.longitude ? parseFloat(r.longitude) : null,
      operatingInfo: r.operating_info,
      status: r.status ? String(r.status).toLowerCase() : (r.is_active === false ? 'suspended' : 'active'),
      partnerStatus: r.partner_status,
      kycStatus: r.kyc_status,
      profileImageUrl: r.profile_image_url,
      rating: r.rating !== null && r.rating !== undefined ? parseFloat(r.rating) : null,
      reviewCount: r.review_count !== undefined ? parseInt(r.review_count, 10) : 0,
      registeredSince: r.registered_since,
      isActive: r.is_active,
      vehicleCount: r.vehicle_count,
      bookingCount: r.booking_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return { partners, total };
  }

  /**
   * Finds a partner by UUID with user identity projection.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findPartnerById(partnerId, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.findPartnerById) {
      return mockPartnerResolver.findPartnerById(partnerId);
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(partnerId).trim());
    const idCond = isUuid ? 'p.id = $1' : 'p.partner_reference = $1';

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        p.id,
        p.partner_reference,
        p.user_id,
        p.business_name,
        p.business_address,
        p.city,
        p.latitude,
        p.longitude,
        p.operating_info,
        p.status,
        p.partner_status,
        p.kyc_status,
        p.profile_image_url,
        COALESCE(pr.rating_avg, pvr.rating_avg)::numeric AS rating,
        COALESCE(pr.rating_count, pvr.rating_count, 0)::int AS review_count,
        p.registered_since,
        p.is_active,
        p.created_at,
        p.updated_at,
        COALESCE(u.name, p.business_name, 'Partner') AS user_name,
        COALESCE(p.contact_email, u.email, '') AS user_email,
        COALESCE(p.contact_phone, u.phone, '') AS user_phone,
        u.country_code AS user_country_code,
        COALESCE(u.is_active, p.is_active) AS user_is_active,
        u.created_at AS user_created_at
      FROM partners p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN (
        SELECT
          r.partner_id,
          ROUND(AVG(r.rating_score)::numeric, 1) AS rating_avg,
          COUNT(DISTINCT r.id)::int AS rating_count
        FROM ratings r
        JOIN bookings b ON b.id = r.booking_id
        WHERE r.target_type = 'PARTNER'
          AND r.status = 'APPROVED'
          AND (
            UPPER(COALESCE(b.booking_status, '')) IN ('COMPLETED', 'CONFIRMED')
            OR LOWER(COALESCE(b.status, '')) IN ('completed', 'returned')
          )
        GROUP BY r.partner_id
      ) pr ON pr.partner_id = p.id
      LEFT JOIN (
        SELECT
          v.partner_id,
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
        GROUP BY v.partner_id
      ) pvr ON pvr.partner_id = p.id
      WHERE ${idCond}
      LIMIT 1;
    `;

    const res = await executor(sql, [partnerId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      partnerReference: r.partner_reference || null,
      userId: r.user_id,
      name: r.user_name,
      email: r.user_email,
      phone: r.user_phone,
      countryCode: r.user_country_code,
      businessName: r.business_name,
      businessAddress: r.business_address,
      city: r.city,
      latitude: r.latitude ? parseFloat(r.latitude) : null,
      longitude: r.longitude ? parseFloat(r.longitude) : null,
      operatingInfo: r.operating_info,
      status: r.status ? String(r.status).toLowerCase() : (r.is_active === false ? 'suspended' : 'active'),
      partnerStatus: r.partner_status,
      kycStatus: r.kyc_status,
      profileImageUrl: r.profile_image_url,
      rating: r.rating !== null && r.rating !== undefined ? parseFloat(r.rating) : null,
      reviewCount: r.review_count !== undefined ? parseInt(r.review_count, 10) : 0,
      registeredSince: r.registered_since,
      isActive: r.is_active,
      userIsActive: r.user_is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      userCreatedAt: r.user_created_at,
    };
  }

  /**
   * Retrieves operational summaries for a single partner (fleet, bookings, KYC, earnings).
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getPartnerSummaries(partnerId, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.getPartnerSummaries) {
      return mockPartnerResolver.getPartnerSummaries(partnerId);
    }

    const executor = this._getExecutor(client);

    const vehicleSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE manual_status = 'ONLINE')::int AS active,
        COUNT(*) FILTER (WHERE rental_status = 'IDLE')::int AS idle,
        COUNT(*) FILTER (WHERE rental_status IN ('BOOKED', 'ACTIVE'))::int AS booked
      FROM vehicles
      WHERE partner_id = $1 AND is_active = true;
    `;

    const bookingSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE booking_status = 'UPCOMING')::int AS upcoming,
        COUNT(*) FILTER (WHERE booking_status = 'ACTIVE')::int AS active,
        COUNT(*) FILTER (WHERE booking_status = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE booking_status = 'CANCELLED')::int AS cancelled
      FROM bookings
      WHERE partner_id = $1;
    `;

    const kycSql = `
      SELECT
        COUNT(*)::int AS total_documents,
        COUNT(*) FILTER (WHERE verification_status = 'PENDING')::int AS pending_documents,
        COUNT(*) FILTER (WHERE verification_status = 'VERIFIED')::int AS verified_documents,
        COUNT(*) FILTER (WHERE verification_status = 'REJECTED')::int AS rejected_documents
      FROM partner_documents
      WHERE partner_id = $1;
    `;

    const earningsSql = `
      SELECT
        COALESCE(SUM(gross_amount), 0)::numeric AS gross_amount,
        COALESCE(SUM(partner_net_amount), 0)::numeric AS net_amount,
        COALESCE(SUM(gross_amount) FILTER (WHERE settlement_status = 'SETTLED'), 0)::numeric
          AS settled_amount,
        COALESCE(SUM(gross_amount) FILTER (WHERE settlement_status = 'PENDING'), 0)::numeric
          AS pending_amount
      FROM earnings
      WHERE partner_id = $1;
    `;

    const payoutSql = `
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'COMPLETED'), 0)::numeric AS completed_payouts,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('REQUESTED', 'PROCESSING')), 0)::numeric
          AS pending_payouts
      FROM payouts
      WHERE partner_id = $1;
    `;

    const [vRes, bRes, kRes, eRes, pRes] = await Promise.all([
      executor(vehicleSql, [partnerId]),
      executor(bookingSql, [partnerId]),
      executor(kycSql, [partnerId]),
      executor(earningsSql, [partnerId]),
      executor(payoutSql, [partnerId]),
    ]);

    const vRow = vRes.rows[0] || {};
    const bRow = bRes.rows[0] || {};
    const kRow = kRes.rows[0] || {};
    const eRow = eRes.rows[0] || {};
    const pRow = pRes.rows[0] || {};

    return {
      fleetSummary: {
        total: vRow.total || 0,
        active: vRow.active || 0,
        idle: vRow.idle || 0,
        booked: vRow.booked || 0,
      },
      bookingSummary: {
        total: bRow.total || 0,
        upcoming: bRow.upcoming || 0,
        active: bRow.active || 0,
        completed: bRow.completed || 0,
        cancelled: bRow.cancelled || 0,
      },
      kycSummary: {
        totalDocuments: kRow.total_documents || 0,
        pendingDocuments: kRow.pending_documents || 0,
        verifiedDocuments: kRow.verified_documents || 0,
        rejectedDocuments: kRow.rejected_documents || 0,
      },
      financialSummary: {
        grossAmount: parseFloat(eRow.gross_amount || 0),
        netAmount: parseFloat(eRow.net_amount || 0),
        settledAmount: parseFloat(eRow.settled_amount || 0),
        pendingAmount: parseFloat(eRow.pending_amount || 0),
        completedPayouts: parseFloat(pRow.completed_payouts || 0),
        pendingPayouts: parseFloat(pRow.pending_payouts || 0),
      },
    };
  }

  /**
   * Counts active bookings currently associated with this partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async getActiveBookingCount(partnerId, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.getActiveBookingCount) {
      return mockPartnerResolver.getActiveBookingCount(partnerId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT COUNT(*)::int AS count
      FROM bookings
      WHERE partner_id = $1
        AND booking_status IN ('UPCOMING', 'ACTIVE', 'CONFIRMED');
    `;
    const res = await executor(sql, [partnerId]);
    return res.rows[0] ? res.rows[0].count : 0;
  }

  /**
   * Retrieves partner row with row-level lock (FOR UPDATE) for concurrency safety.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findPartnerByIdForUpdate(partnerId, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.findPartnerByIdForUpdate) {
      return mockPartnerResolver.findPartnerByIdForUpdate(partnerId, client);
    }

    if (!client || typeof client.query !== 'function') {
      return this.findPartnerById(partnerId, client);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT id, user_id, business_name, is_active, status, partner_status, kyc_status
      FROM partners
      WHERE id = $1
      FOR UPDATE;
    `;
    const res = await executor(sql, [partnerId]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      businessName: r.business_name,
      isActive: r.is_active,
      status: r.status ? String(r.status).toLowerCase() : (r.is_active === false ? 'suspended' : 'active'),
      partnerStatus: r.partner_status,
      kycStatus: r.kyc_status,
    };
  }

  /**
   * Updates partner status and/or active flag atomically.
   *
   * @param {string} partnerId
   * @param {object} updates
   * @param {boolean} [updates.isActive]
   * @param {string} [updates.partnerStatus]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async updatePartnerStatus(partnerId, { isActive = null, partnerStatus = null, status = null }, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.updatePartnerStatus) {
      return mockPartnerResolver.updatePartnerStatus(partnerId, { isActive, partnerStatus, status });
    }

    const executor = this._getExecutor(client);
    const sets = [];
    const values = [partnerId];
    let idx = 2;

    if (typeof isActive === 'boolean') {
      sets.push(`is_active = $${idx}`);
      values.push(isActive);
      idx += 1;

      sets.push(`status = $${idx}`);
      values.push(isActive ? 'active' : 'suspended');
      idx += 1;
    } else if (status) {
      sets.push(`status = $${idx}`);
      values.push(String(status).toLowerCase());
      idx += 1;

      if (String(status).toLowerCase() === 'suspended') {
        sets.push(`is_active = $${idx}`);
        values.push(false);
        idx += 1;
      } else if (String(status).toLowerCase() === 'active') {
        sets.push(`is_active = $${idx}`);
        values.push(true);
        idx += 1;
      }
    }

    if (partnerStatus) {
      sets.push(`partner_status = $${idx}`);
      values.push(partnerStatus);
      idx += 1;
    }

    if (sets.length === 0) {
      return this.findPartnerById(partnerId, client);
    }

    sets.push('updated_at = CURRENT_TIMESTAMP');

    const updateSql = `
      UPDATE partners
      SET ${sets.join(', ')}
      WHERE id = $1
      RETURNING *;
    `;

    await executor(updateSql, values);
    return this.findPartnerById(partnerId, client);
  }

  /**
   * Updates partner KYC status.
   *
   * @param {string} partnerId
   * @param {string} kycStatus
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async updateKycStatus(partnerId, kycStatus, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.updateKycStatus) {
      return mockPartnerResolver.updateKycStatus(partnerId, kycStatus);
    }

    const executor = this._getExecutor(client);
    await executor(
      `UPDATE partners 
       SET kyc_status = $2, 
           verification_status = CASE WHEN $2 IN ('VERIFIED', 'APPROVED') THEN 'VERIFIED' ELSE verification_status END,
           status = CASE WHEN $2 IN ('VERIFIED', 'APPROVED') AND status = 'pending' THEN 'active' ELSE status END,
           is_active = true,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [partnerId, kycStatus],
    );

    return this.findPartnerById(partnerId, client);
  }

  /**
   * Retrieves partner documents with safe metadata.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getPartnerDocuments(partnerId, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.getPartnerDocuments) {
      return mockPartnerResolver.getPartnerDocuments(partnerId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id, partner_id, document_type, document_number, storage_key,
        verification_status, version, rejection_reason, created_at, updated_at
      FROM partner_documents
      WHERE partner_id = $1
      ORDER BY created_at DESC, id DESC;
    `;
    const res = await executor(sql, [partnerId]);
    return res.rows.map((r) => ({
      id: r.id,
      partnerId: r.partner_id,
      documentType: r.document_type,
      documentNumber: r.document_number,
      storageKey: r.storage_key,
      verificationStatus: r.verification_status,
      version: r.version,
      rejectionReason: r.rejection_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Retrieves partner bank accounts with masked account numbers.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getPartnerBankAccounts(partnerId, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.getPartnerBankAccounts) {
      return mockPartnerResolver.getPartnerBankAccounts(partnerId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id, partner_id, account_holder_name, account_number_masked,
        ifsc_code, bank_name, is_primary, verification_status, created_at, updated_at
      FROM partner_bank_accounts
      WHERE partner_id = $1
      ORDER BY is_primary DESC, created_at DESC;
    `;
    const res = await executor(sql, [partnerId]);
    return res.rows.map((r) => ({
      id: r.id,
      partnerId: r.partner_id,
      accountHolderName: r.account_holder_name,
      accountNumberMasked: r.account_number_masked,
      ifscCode: r.ifsc_code,
      bankName: r.bank_name,
      isPrimary: r.is_primary,
      verificationStatus: r.verification_status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Retrieves legacy shops for a partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getPartnerShops(partnerId, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.getPartnerShops) {
      return mockPartnerResolver.getPartnerShops(partnerId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id, partner_id, shop_name, shop_address, city, latitude, longitude,
        operating_info, is_active, created_at, updated_at,
        (SELECT COUNT(v.id)::int FROM vehicles v WHERE v.shop_id = shops.id AND v.is_active = true) AS vehicle_count
      FROM shops
      WHERE partner_id = $1
      ORDER BY created_at DESC;
    `;
    const res = await executor(sql, [partnerId]);
    return res.rows.map((r) => ({
      id: r.id,
      partnerId: r.partner_id,
      name: r.shop_name,
      shopName: r.shop_name,
      address: r.shop_address,
      shopAddress: r.shop_address,
      area: r.city || '',
      city: r.city,
      latitude: r.latitude ? parseFloat(r.latitude) : null,
      longitude: r.longitude ? parseFloat(r.longitude) : null,
      operatingInfo: r.operating_info,
      isActive: r.is_active,
      status: r.is_active ? 'active' : 'suspended',
      verificationStatus: 'verified',
      vehicleCount: r.vehicle_count !== undefined ? parseInt(r.vehicle_count, 10) : 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Retrieves partner vehicles fleet with pagination and filters.
   *
   * @param {string} partnerId
   * @param {object} params
   * @param {string} [params.category]
   * @param {string} [params.manualStatus]
   * @param {string} [params.rentalStatus]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ vehicles: object[], total: number }>}
   */
  async getPartnerVehicles(
    partnerId,
    { category = null, manualStatus = null, rentalStatus = null, limit = 10, offset = 0 } = {},
    client = null,
  ) {
    if (mockPartnerResolver && mockPartnerResolver.getPartnerVehicles) {
      return mockPartnerResolver.getPartnerVehicles(partnerId, {
        category, manualStatus, rentalStatus, limit, offset,
      });
    }

    const executor = this._getExecutor(client);
    const conditions = ['v.partner_id = $1', 'v.is_active = true'];
    const values = [partnerId];
    let idx = 2;

    if (category) {
      conditions.push(`v.category = $${idx}`);
      values.push(category);
      idx += 1;
    }

    if (manualStatus) {
      conditions.push(`v.manual_status = $${idx}`);
      values.push(manualStatus);
      idx += 1;
    }

    if (rentalStatus) {
      conditions.push(`v.rental_status = $${idx}`);
      values.push(rentalStatus);
      idx += 1;
    }

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    values.push(safeLimit, safeOffset);
    const limitIdx = idx;
    const offsetIdx = idx + 1;

    const sql = `
      SELECT
        v.id, v.vehicle_reference, v.partner_id, v.shop_id, v.category, v.brand, v.model, v.variant,
        v.registration_number, v.year, v.fuel_type, NULL::text AS transmission, NULL::int AS seats,
        v.manual_status, v.rental_status, v.verification_status, (NOT v.is_active) AS is_archived,
        NULL::text AS offline_reason, v.created_at, v.updated_at,
        COUNT(*) OVER()::int AS full_count
      FROM vehicles v
      WHERE ${conditions.join(' AND ')}
      ORDER BY v.created_at DESC, v.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const res = await executor(sql, values);
    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;

    const vehicles = res.rows.map((r) => ({
      id: r.id,
      vehicleReference: r.vehicle_reference || null,
      partnerId: r.partner_id,
      shopId: r.shop_id,
      category: r.category,
      brand: r.brand,
      model: r.model,
      variant: r.variant,
      registrationNumber: r.registration_number,
      year: r.year,
      fuelType: r.fuel_type,
      transmission: r.transmission,
      seats: r.seats,
      manualStatus: r.manual_status,
      rentalStatus: r.rental_status,
      verificationStatus: r.verification_status,
      isArchived: r.is_archived,
      offlineReason: r.offline_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return { vehicles, total };
  }

  /**
   * Retrieves partner bookings with pagination and filters.
   *
   * @param {string} partnerId
   * @param {object} params
   * @param {string} [params.status]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ bookings: object[], total: number }>}
   */
  async getPartnerBookings(
    partnerId,
    { status = null, limit = 10, offset = 0 } = {},
    client = null,
  ) {
    if (mockPartnerResolver && mockPartnerResolver.getPartnerBookings) {
      return mockPartnerResolver.getPartnerBookings(partnerId, { status, limit, offset });
    }

    const executor = this._getExecutor(client);
    const conditions = ['b.partner_id = $1'];
    const values = [partnerId];
    let idx = 2;

    if (status) {
      conditions.push(`b.booking_status = $${idx}`);
      values.push(status);
      idx += 1;
    }

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    values.push(safeLimit, safeOffset);
    const limitIdx = idx;
    const offsetIdx = idx + 1;

    const sql = `
      SELECT
        b.id, b.booking_reference, b.booking_number, b.customer_id, b.customer_name, b.customer_phone,
        b.partner_id, b.shop_id, b.vehicle_id, v.vehicle_reference, b.start_at, b.expected_return_at,
        b.booking_status, b.payment_status, b.pickup_location, b.created_at, b.updated_at,
        v.brand AS vehicle_brand, v.model AS vehicle_model, v.registration_number AS vehicle_registration_number,
        COALESCE(img.image_url, img.storage_key, v.primary_image_url, '') AS vehicle_cover_image_url,
        br.rating AS rating,
        br.review_comment AS review_comment,
        COUNT(*) OVER()::int AS full_count
      FROM bookings b
      LEFT JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN (
        SELECT DISTINCT ON (vehicle_id) vehicle_id, image_url, storage_key
        FROM vehicle_images
        WHERE is_active = true
        ORDER BY vehicle_id, is_cover DESC, sort_order ASC, created_at ASC
      ) img ON img.vehicle_id = v.id
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(rev.rating, rat_p.rating_score, rat_v.rating_score)::int AS rating,
          COALESCE(rev.review_text, rat_p.review_comment, rat_v.review_comment) AS review_comment
        FROM (SELECT 1) _dummy
        LEFT JOIN reviews rev ON rev.booking_id = b.id
        LEFT JOIN ratings rat_p ON rat_p.booking_id = b.id AND rat_p.target_type = 'PARTNER'
        LEFT JOIN ratings rat_v ON rat_v.booking_id = b.id AND rat_v.target_type = 'VEHICLE'
        LIMIT 1
      ) br ON true
      WHERE ${conditions.join(' AND ')}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const res = await executor(sql, values);
    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;

    const bookings = res.rows.map((r) => ({
      id: r.id,
      bookingReference: r.booking_reference || r.booking_number,
      bookingNumber: r.booking_reference || r.booking_number,
      customerId: r.customer_id,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      partnerId: r.partner_id,
      shopId: r.shop_id,
      vehicleId: r.vehicle_id,
      vehicleReference: r.vehicle_reference || null,
      vehicle: {
        id: r.vehicle_id,
        brand: r.vehicle_brand,
        model: r.vehicle_model,
        registrationNumber: r.vehicle_registration_number,
        coverImageUrl: r.vehicle_cover_image_url || null,
        primaryImage: r.vehicle_cover_image_url || null,
        primaryImageUrl: r.vehicle_cover_image_url || null,
      },
      coverImageUrl: r.vehicle_cover_image_url || null,
      vehicleImage: r.vehicle_cover_image_url || null,
      startAt: r.start_at,
      expectedReturnAt: r.expected_return_at,
      bookingStatus: r.booking_status,
      paymentStatus: r.payment_status,
      pickupLocation: r.pickup_location,
      rating: r.rating !== null && r.rating !== undefined ? Number(r.rating) : null,
      reviewComment: r.review_comment || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return { bookings, total };
  }

  /**
   * Retrieves verification audit history for a partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getPartnerVerificationHistory(partnerId, client = null) {
    if (mockPartnerResolver && mockPartnerResolver.getPartnerVerificationHistory) {
      return mockPartnerResolver.getPartnerVerificationHistory(partnerId);
    }

    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, partner_id, verification_type, old_status, new_status, reason, verified_by, created_at
        FROM partner_verification_history
        WHERE partner_id = $1
        ORDER BY created_at DESC;
      `;
      const res = await executor(sql, [partnerId]);
      return res.rows;
    } catch (_) {
      return [];
    }
  }

  /**
   * Inserts a record into partner_verification_history.
   *
   * @param {object} params
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async insertVerificationHistory({
    partnerId,
    verificationType = 'KYC',
    oldStatus = null,
    newStatus,
    reason = null,
    verifiedBy = null,
  }, client = null) {
    const executor = this._getExecutor(client);
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const safeVerifiedBy = (typeof verifiedBy === 'string' && UUID_REGEX.test(verifiedBy.trim())) ? verifiedBy.trim() : null;
    try {
      const sql = `
        INSERT INTO partner_verification_history (
          id, partner_id, verification_type, old_status, new_status, reason, verified_by, created_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP
        )
        RETURNING *;
      `;
      const res = await executor(sql, [
        partnerId,
        verificationType,
        oldStatus,
        newStatus,
        reason,
        safeVerifiedBy,
      ]);
      return res.rows[0];
    } catch (_) {
      return null;
    }
  }
}

module.exports = new AdminPartnerRepository();
