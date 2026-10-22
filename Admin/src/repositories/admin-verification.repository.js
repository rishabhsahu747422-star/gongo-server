'use strict';

const BaseRepository = require('../db/base.repository');

let mockVerificationResolver = null;

class AdminVerificationRepository extends BaseRepository {
  constructor() {
    super('partners', 'id');
  }

  /**
   * For unit testing: inject mock resolver
   * @param {object|null} resolver
   */
  static setMockVerificationResolver(resolver) {
    mockVerificationResolver = resolver;
  }

  static resetMockVerificationResolver() {
    mockVerificationResolver = null;
  }

  /**
   * Returns query executor (client or pool query).
   * @private
   */
  _getExecutor(client) {
    return client
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
   * Lists partners with verification/KYC status, search, and filtering.
   *
   * @param {object} params
   * @param {string} [params.search]
   * @param {string} [params.kycStatus]
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
  async listPartnerVerifications({
    search = null,
    kycStatus = null,
    city = null,
    startDate = null,
    endDate = null,
    limit = 10,
    offset = 0,
    sortBy = 'created_at',
    sortOrder = 'DESC',
    unverifiedOnly = false,
  } = {}, client = null) {
    if (mockVerificationResolver && mockVerificationResolver.listPartnerVerifications) {
      return mockVerificationResolver.listPartnerVerifications({
        search, kycStatus, city, startDate, endDate, limit, offset, sortBy, sortOrder, unverifiedOnly,
      });
    }

    const executor = this._getExecutor(client);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (search && search.trim()) {
      const term = `%${this._escapeLikeWildcards(search.trim())}%`;
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search.trim());

      if (isUuid) {
        conditions.push(`(p.id = $${idx} OR p.user_id = $${idx})`);
        values.push(search.trim());
        idx += 1;
      } else {
        conditions.push(`(
          p.business_name ILIKE $${idx} OR
          u.name ILIKE $${idx} OR
          u.phone ILIKE $${idx} OR
          u.email ILIKE $${idx}
        )`);
        values.push(term);
        idx += 1;
      }
    }

    if (unverifiedOnly || kycStatus === 'UNVERIFIED') {
      conditions.push(`(
        LOWER(p.kyc_status) != 'verified' OR 
        LOWER(p.verification_status) != 'verified'
      )`);
    } else if (kycStatus && kycStatus !== 'ALL') {
      conditions.push(`UPPER(p.kyc_status) = $${idx}`);
      values.push(kycStatus.toUpperCase());
      idx += 1;
    }

    if (city && city.trim()) {
      conditions.push(`p.city ILIKE $${idx}`);
      values.push(`%${this._escapeLikeWildcards(city.trim())}%`);
      idx += 1;
    }

    if (startDate) {
      conditions.push(`p.created_at >= $${idx}`);
      values.push(startDate);
      idx += 1;
    }

    if (endDate) {
      conditions.push(`p.created_at < $${idx}`);
      values.push(endDate);
      idx += 1;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeSortCol = ['created_at', 'updated_at', 'business_name', 'kyc_status'].includes(sortBy)
      ? sortBy
      : 'created_at';
    const safeSortDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT
        p.id,
        p.partner_code,
        p.partner_reference,
        p.user_id,
        p.business_name,
        p.business_type,
        p.city,
        p.status,
        p.partner_status,
        p.kyc_status,
        p.verification_status,
        p.is_active,
        p.verified_at,
        p.created_at,
        p.updated_at,
        u.name AS owner_name,
        u.email AS owner_email,
        u.phone AS owner_phone,
        ba.bank_name,
        ba.account_number_masked,
        ba.ifsc_code,
        ba.account_holder_name,
        COUNT(pd.id)::int AS total_documents,
        COUNT(pd.id) FILTER (WHERE UPPER(pd.verification_status) = 'VERIFIED')::int AS verified_documents,
        COUNT(pd.id) FILTER (WHERE UPPER(pd.verification_status) = 'PENDING')::int AS pending_documents,
        COUNT(pd.id) FILTER (WHERE UPPER(pd.verification_status) = 'REJECTED')::int AS rejected_documents,
        COUNT(*) OVER()::int AS full_count
      FROM partners p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN partner_documents pd ON pd.partner_id = p.id
      LEFT JOIN (
        SELECT DISTINCT ON (partner_id)
          partner_id,
          bank_name,
          account_number_masked,
          ifsc_code,
          account_holder_name
        FROM partner_bank_accounts
        ORDER BY partner_id, is_primary DESC, created_at DESC
      ) ba ON ba.partner_id = p.id
      ${whereClause}
      GROUP BY p.id, u.id, ba.bank_name, ba.account_number_masked, ba.ifsc_code, ba.account_holder_name
      ORDER BY p.${safeSortCol} ${safeSortDir}, p.id DESC
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    values.push(limit, offset);
    const res = await executor(sql, values);

    const total = res.rows[0] ? res.rows[0].full_count : 0;
    const partners = res.rows.map((r) => ({
      id: r.id,
      partnerId: r.id,
      partnerReference: r.partner_reference || r.partner_code || null,
      partnerCode: r.partner_code || r.partner_reference || null,
      userId: r.user_id,
      businessName: r.business_name,
      businessType: r.business_type,
      city: r.city,
      status: r.status ? String(r.status).toLowerCase() : (r.is_active ? 'active' : 'suspended'),
      partnerStatus: r.partner_status,
      kycStatus: r.kyc_status,
      verificationStatus: r.verification_status || r.kyc_status,
      verifiedAt: r.verified_at,
      isActive: r.is_active,
      owner: {
        name: r.owner_name,
        email: r.owner_email,
        phone: r.owner_phone,
      },
      bankAccount: r.bank_name || r.account_number_masked ? {
        bankName: r.bank_name || '',
        accountNumber: r.account_number_masked || '',
        accountNumberMasked: r.account_number_masked || '',
        ifsc: r.ifsc_code || '',
        accountHolder: r.account_holder_name || '',
      } : null,
      documentCounts: {
        total: r.total_documents,
        verified: r.verified_documents,
        pending: r.pending_documents,
        rejected: r.rejected_documents,
      },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return { partners, total };
  }

  /**
   * Retrieves partner verification detail with owner info and list of partner documents.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findPartnerVerificationById(partnerId, client = null) {
    if (mockVerificationResolver && mockVerificationResolver.findPartnerVerificationById) {
      return mockVerificationResolver.findPartnerVerificationById(partnerId);
    }

    const executor = this._getExecutor(client);
    const partnerSql = `
      SELECT
        p.id,
        p.partner_code,
        p.partner_reference,
        p.user_id,
        p.business_name,
        p.business_type,
        p.city,
        p.business_address,
        p.status,
        p.partner_status,
        p.kyc_status,
        p.verification_status,
        p.is_active,
        p.verified_at,
        p.created_at,
        p.updated_at,
        u.name AS owner_name,
        u.email AS owner_email,
        u.phone AS owner_phone
      FROM partners p
      JOIN users u ON u.id = p.user_id
      WHERE p.id = $1
      LIMIT 1;
    `;

    const docSql = `
      SELECT
        id,
        partner_id,
        document_type,
        document_number,
        storage_key,
        verification_status,
        version,
        rejection_reason,
        created_at,
        updated_at
      FROM partner_documents
      WHERE partner_id = $1
      ORDER BY created_at DESC, id DESC;
    `;

    const bankSql = `
      SELECT
        id,
        partner_id,
        account_holder_name,
        account_number_masked,
        ifsc_code,
        bank_name,
        is_primary,
        verification_status,
        created_at
      FROM partner_bank_accounts
      WHERE partner_id = $1
      ORDER BY is_primary DESC, created_at DESC
      LIMIT 1;
    `;

    const [pRes, dRes, bRes] = await Promise.all([
      executor(partnerSql, [partnerId]),
      executor(docSql, [partnerId]),
      executor(bankSql, [partnerId]).catch(() => ({ rows: [] })),
    ]);

    if (!pRes.rows[0]) return null;

    const p = pRes.rows[0];
    const documents = dRes.rows.map((d) => ({
      id: d.id,
      partnerId: d.partner_id,
      documentType: d.document_type,
      documentNumber: d.document_number,
      storageKey: d.storage_key,
      verificationStatus: d.verification_status,
      version: d.version,
      rejectionReason: d.rejection_reason,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    }));

    const bank = (bRes && bRes.rows && bRes.rows[0]) ? {
      id: bRes.rows[0].id,
      bankName: bRes.rows[0].bank_name,
      accountHolder: bRes.rows[0].account_holder_name,
      accountHolderName: bRes.rows[0].account_holder_name,
      accountNumber: bRes.rows[0].account_number_masked,
      accountNumberMasked: bRes.rows[0].account_number_masked,
      ifsc: bRes.rows[0].ifsc_code,
      ifscCode: bRes.rows[0].ifsc_code,
      isPrimary: bRes.rows[0].is_primary,
      verificationStatus: bRes.rows[0].verification_status,
    } : null;

    return {
      id: p.id,
      partnerId: p.id,
      partnerReference: p.partner_reference || p.partner_code || null,
      partnerCode: p.partner_code || p.partner_reference || null,
      userId: p.user_id,
      businessName: p.business_name,
      businessType: p.business_type,
      city: p.city,
      businessAddress: p.business_address || null,
      state: null,
      pincode: null,
      status: p.status ? String(p.status).toLowerCase() : (p.is_active ? 'active' : 'suspended'),
      partnerStatus: p.partner_status,
      kycStatus: p.kyc_status,
      verificationStatus: p.verification_status || p.kyc_status,
      verifiedAt: p.verified_at,
      isActive: p.is_active,
      owner: {
        name: p.owner_name,
        email: p.owner_email,
        phone: p.owner_phone,
      },
      bankAccount: bank,
      documents,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  }

  /**
   * Acquires row-level lock on partner for atomic KYC verification decisions.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findPartnerByIdForUpdate(partnerId, client) {
    if (mockVerificationResolver && mockVerificationResolver.findPartnerByIdForUpdate) {
      return mockVerificationResolver.findPartnerByIdForUpdate(partnerId);
    }

    const sql = `
      SELECT id, user_id, business_name, status, partner_status, kyc_status, verification_status, is_active, verified_at, created_at, updated_at
      FROM partners
      WHERE id = $1
      FOR UPDATE;
    `;
    const res = await client.query(sql, [partnerId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      businessName: r.business_name,
      status: r.status,
      partnerStatus: r.partner_status,
      kycStatus: r.kyc_status,
      verificationStatus: r.verification_status,
      verifiedAt: r.verified_at,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Updates partner KYC status and cascades verification/rejection to documents and audit history.
   *
   * @param {string} partnerId
   * @param {string} kycStatus
   * @param {import('pg').PoolClient} client
   * @param {object} [metadata]
   * @returns {Promise<object>}
   */
  async updatePartnerKycStatus(partnerId, kycStatus, client, metadata = {}) {
    if (mockVerificationResolver && mockVerificationResolver.updatePartnerKycStatus) {
      return mockVerificationResolver.updatePartnerKycStatus(partnerId, kycStatus, client, metadata);
    }

    const executor = this._getExecutor(client);
    const upperKyc = String(kycStatus).toUpperCase().trim();
    const isApprove = (upperKyc === 'VERIFIED' || upperKyc === 'APPROVED');
    const finalKycStatus = isApprove ? 'VERIFIED' : 'REJECTED';
    const finalVerificationStatus = isApprove ? 'VERIFIED' : 'REJECTED';
    const reason = metadata.reason || null;
    const verifiedBy = metadata.verifiedBy || null;

    if (isApprove) {
      // 1. Update partners table
      // Preserve existing suspension (do NOT unsuspend if suspended or inactive)
      // Only advance 'pending' status to 'active'
      const partnerSql = `
        UPDATE partners
        SET kyc_status = 'VERIFIED',
            verification_status = 'VERIFIED',
            status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
            verified_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
      await executor(partnerSql, [partnerId]);

      // 2. Cascade verification to pending partner documents
      const docsSql = `
        UPDATE partner_documents
        SET verification_status = 'VERIFIED',
            verified_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE partner_id = $1 AND verification_status IN ('PENDING', 'UNDER_REVIEW');
      `;
      await executor(docsSql, [partnerId]);
    } else {
      // 1. Update partners table
      // If status was 'pending', set to 'rejected'
      // Set operational status to 'OFFLINE' so unverified partner cannot receive bookings
      // Clear verified_at
      const partnerSql = `
        UPDATE partners
        SET kyc_status = 'REJECTED',
            verification_status = 'REJECTED',
            status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END,
            partner_status = 'OFFLINE',
            verified_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
      await executor(partnerSql, [partnerId]);

      // 2. Cascade rejection to partner documents with rejection reason
      const docsSql = `
        UPDATE partner_documents
        SET verification_status = 'REJECTED',
            rejection_reason = COALESCE($2, rejection_reason, 'Verification rejected by administrator'),
            updated_at = CURRENT_TIMESTAMP
        WHERE partner_id = $1 AND verification_status IN ('PENDING', 'UNDER_REVIEW');
      `;
      await executor(docsSql, [partnerId, reason]);
    }

    // 3. Record in partner_verification_history
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const safeVerifiedBy = (typeof verifiedBy === 'string' && UUID_REGEX.test(verifiedBy.trim())) ? verifiedBy.trim() : null;
    try {
      await executor(`
        INSERT INTO partner_verification_history (
          partner_id, verification_type, old_status, new_status, reason, verified_by, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP);
      `, [
        partnerId,
        'KYC',
        metadata.previousStatus || null,
        finalKycStatus,
        reason,
        safeVerifiedBy,
      ]);
    } catch (_) {
      // Tolerant in environments without history table
    }

    return this.findPartnerVerificationById(partnerId, client);
  }

  /**
   * Lists vehicles with verification status, search, and filtering.
   *
   * @param {object} params
   * @param {string} [params.search]
   * @param {string} [params.verificationStatus]
   * @param {string} [params.partnerId]
   * @param {string} [params.category]
   * @param {Date} [params.startDate]
   * @param {Date} [params.endDate]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {string} [params.sortBy='created_at']
   * @param {string} [params.sortOrder='DESC']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ vehicles: object[], total: number }>}
   */
  async listVehicleVerifications({
    search = null,
    verificationStatus = null,
    partnerId = null,
    category = null,
    startDate = null,
    endDate = null,
    limit = 10,
    offset = 0,
    sortBy = 'created_at',
    sortOrder = 'DESC',
    unverifiedOnly = false,
  } = {}, client = null) {
    if (mockVerificationResolver && mockVerificationResolver.listVehicleVerifications) {
      return mockVerificationResolver.listVehicleVerifications({
        search,
        verificationStatus,
        partnerId,
        category,
        startDate,
        endDate,
        limit,
        offset,
        sortBy,
        sortOrder,
        unverifiedOnly,
      });
    }

    const executor = this._getExecutor(client);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (search && search.trim()) {
      const term = `%${this._escapeLikeWildcards(search.trim())}%`;
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search.trim());

      if (isUuid) {
        conditions.push(`(v.id = $${idx} OR v.partner_id = $${idx})`);
        values.push(search.trim());
        idx += 1;
      } else {
        conditions.push(`(
          v.registration_number ILIKE $${idx} OR
          v.brand ILIKE $${idx} OR
          v.model ILIKE $${idx} OR
          p.business_name ILIKE $${idx} OR
          u.name ILIKE $${idx} OR
          s.shop_name ILIKE $${idx}
        )`);
        values.push(term);
        idx += 1;
      }
    }

    if (unverifiedOnly || verificationStatus === 'UNVERIFIED') {
      conditions.push(`(
        LOWER(v.verification_status) != 'verified'
      )`);
    } else if (verificationStatus && verificationStatus !== 'ALL') {
      conditions.push(`v.verification_status = $${idx}`);
      values.push(verificationStatus);
      idx += 1;
    }

    if (partnerId) {
      conditions.push(`v.partner_id = $${idx}`);
      values.push(partnerId);
      idx += 1;
    }

    if (category) {
      conditions.push(`v.category = $${idx}`);
      values.push(category);
      idx += 1;
    }

    if (startDate) {
      conditions.push(`v.created_at >= $${idx}`);
      values.push(startDate);
      idx += 1;
    }

    if (endDate) {
      conditions.push(`v.created_at < $${idx}`);
      values.push(endDate);
      idx += 1;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeSortCol = ['created_at', 'updated_at', 'registration_number', 'verification_status'].includes(sortBy)
      ? sortBy
      : 'created_at';
    const safeSortDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT
        v.id,
        v.partner_id,
        v.shop_id,
        v.category,
        v.brand,
        v.model,
        v.variant,
        v.registration_number,
        v.year,
        v.fuel_type,
        NULL::text AS transmission,
        v.manual_status,
        v.rental_status,
        v.verification_status,
        (NOT v.is_active) AS is_archived,
        v.created_at,
        v.updated_at,
        p.business_name AS partner_business_name,
        p.city AS partner_city,
        u.name AS partner_owner_name,
        COALESCE(s.shop_name, s.name, p.business_name, 'Central Hub') AS shop_name,
        COUNT(vd.id)::int AS total_documents,
        COUNT(vd.id) FILTER (WHERE vd.verification_status = 'VERIFIED')::int AS verified_documents,
        COUNT(vd.id) FILTER (WHERE vd.verification_status = 'PENDING')::int AS pending_documents,
        COUNT(vd.id) FILTER (WHERE vd.verification_status = 'REJECTED')::int AS rejected_documents,
        COUNT(*) OVER()::int AS full_count
      FROM vehicles v
      JOIN partners p ON p.id = v.partner_id
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN shops s ON s.id = v.shop_id
      LEFT JOIN vehicle_documents vd ON vd.vehicle_id = v.id
      ${whereClause}
      GROUP BY v.id, p.id, u.id, s.id
      ORDER BY v.${safeSortCol} ${safeSortDir}, v.id DESC
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    values.push(limit, offset);
    const res = await executor(sql, values);

    const total = res.rows[0] ? res.rows[0].full_count : 0;
    const vehicles = res.rows.map((r) => {
      const primaryPartnerName = r.partner_owner_name || r.partner_business_name || 'Fleet Operator';
      const shopDisplayName = r.shop_name || r.partner_business_name || 'Main Station';
      return {
        id: r.id,
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
        manualStatus: r.manual_status,
        rentalStatus: r.rental_status,
        verificationStatus: r.verification_status,
        isArchived: r.is_archived,
        partnerName: primaryPartnerName,
        shopName: shopDisplayName,
        partner: {
          id: r.partner_id,
          name: primaryPartnerName,
          ownerName: primaryPartnerName,
          businessName: r.partner_business_name || primaryPartnerName,
          city: r.partner_city,
        },
        shop: {
          id: r.shop_id,
          name: shopDisplayName,
        },
        documentCounts: {
          total: r.total_documents,
          verified: r.verified_documents,
          pending: r.pending_documents,
          rejected: r.rejected_documents,
        },
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });

    return { vehicles, total };
  }

  /**
   * Retrieves vehicle verification detail with partner info, vehicle docs, and gallery images.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findVehicleVerificationById(vehicleId, client = null) {
    if (mockVerificationResolver && mockVerificationResolver.findVehicleVerificationById) {
      return mockVerificationResolver.findVehicleVerificationById(vehicleId);
    }

    const executor = this._getExecutor(client);
    const vehicleSql = `
      SELECT
        v.id,
        v.partner_id,
        v.category,
        v.brand,
        v.model,
        v.variant,
        v.registration_number,
        v.year,
        v.fuel_type,
        NULL::text AS transmission,
        v.manual_status,
        v.rental_status,
        v.verification_status,
        (NOT v.is_active) AS is_archived,
        v.created_at,
        v.updated_at,
        p.business_name AS partner_name,
        p.city AS partner_city,
        u.name AS partner_owner_name,
        u.phone AS partner_owner_phone
      FROM vehicles v
      JOIN partners p ON p.id = v.partner_id
      JOIN users u ON u.id = p.user_id
      WHERE v.id = $1
      LIMIT 1;
    `;

    const docSql = `
      SELECT
        id,
        vehicle_id,
        document_type,
        document_name,
        document_number,
        valid_till,
        storage_key,
        verification_status,
        is_required,
        version,
        rejection_reason,
        created_at,
        updated_at
      FROM vehicle_documents
      WHERE vehicle_id = $1
      ORDER BY created_at DESC, id DESC;
    `;

    const imgSql = `
      SELECT
        id,
        vehicle_id,
        storage_key,
        image_url,
        is_cover,
        sort_order,
        verification_status,
        rejection_reason,
        version,
        parent_image_id,
        verified_at,
        verified_by,
        rejected_at,
        created_at,
        updated_at
      FROM vehicle_images
      WHERE vehicle_id = $1 AND is_active = true
      ORDER BY is_cover DESC, sort_order ASC, created_at ASC;
    `;

    const vRes = await executor(vehicleSql, [vehicleId]);
    if (!vRes.rows[0]) return null;

    let dRes = await executor(docSql, [vehicleId]);
    const iRes = await executor(imgSql, [vehicleId]);

    const v = vRes.rows[0];
    let docRows = dRes.rows || [];

    if (docRows.length === 0) {
      try {
        const rcNum = v.registration_number || 'PENDING';
        const partnerFolder = v.partner_id || 'general';
        const autoDocSql = `
          INSERT INTO vehicle_documents (vehicle_id, document_type, document_name, document_number, storage_key, verification_status, is_required)
          VALUES 
            ($1, 'RC', 'Registration Certificate (RC)', $2, $3, 'PENDING', true),
            ($1, 'Insurance', 'Comprehensive Insurance', $4, $5, 'PENDING', true)
          RETURNING *;
        `;
        const inserted = await executor(autoDocSql, [
          vehicleId,
          rcNum,
          `partners/${partnerFolder}/vehicles/${vehicleId}/documents/rc.pdf`,
          `POL-${rcNum}`,
          `partners/${partnerFolder}/vehicles/${vehicleId}/documents/insurance.pdf`,
        ]);
        if (inserted && inserted.rows && inserted.rows.length > 0) {
          docRows = inserted.rows;
        }
      } catch (autoErr) {
        // fallback gracefully without error
      }
    }

    const documents = docRows.map((d) => ({
      id: d.id,
      vehicleId: d.vehicle_id,
      documentType: d.document_type,
      documentName: d.document_name,
      documentNumber: d.document_number,
      validTill: d.valid_till,
      storageKey: d.storage_key,
      verificationStatus: d.verification_status,
      isRequired: d.is_required,
      version: d.version,
      rejectionReason: d.rejection_reason,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    }));

    const images = iRes.rows.map((i) => ({
      id: i.id,
      vehicleId: i.vehicle_id,
      storageKey: i.storage_key,
      imageUrl: i.image_url,
      isCover: i.is_cover,
      sortOrder: i.sort_order,
      verificationStatus: i.verification_status || 'PENDING',
      rejectionReason: i.rejection_reason || null,
      version: i.version || 1,
      parentImageId: i.parent_image_id || null,
      verifiedAt: i.verified_at || null,
      verifiedBy: i.verified_by || null,
      rejectedAt: i.rejected_at || null,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
    }));

    return {
      id: v.id,
      partnerId: v.partner_id,
      category: v.category,
      brand: v.brand,
      model: v.model,
      variant: v.variant,
      registrationNumber: v.registration_number,
      year: v.year,
      fuelType: v.fuel_type,
      transmission: v.transmission,
      manualStatus: v.manual_status,
      rentalStatus: v.rental_status,
      verificationStatus: v.verification_status,
      isArchived: v.is_archived,
      partner: {
        id: v.partner_id,
        businessName: v.partner_name,
        city: v.partner_city,
        ownerName: v.partner_owner_name,
        ownerPhone: v.partner_owner_phone,
      },
      documents,
      images,
      createdAt: v.created_at,
      updatedAt: v.updated_at,
    };
  }

  /**
   * Acquires row-level lock on vehicle for atomic verification decisions.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findVehicleByIdForUpdate(vehicleId, client) {
    if (mockVerificationResolver && mockVerificationResolver.findVehicleByIdForUpdate) {
      return mockVerificationResolver.findVehicleByIdForUpdate(vehicleId);
    }

    const sql = `
      SELECT id, partner_id, registration_number, verification_status, (NOT is_active) AS is_archived,
             manual_status, rental_status, created_at, updated_at
      FROM vehicles
      WHERE id = $1
      FOR UPDATE;
    `;
    const res = await client.query(sql, [vehicleId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      partnerId: r.partner_id,
      registrationNumber: r.registration_number,
      verificationStatus: r.verification_status,
      isArchived: r.is_archived,
      manualStatus: r.manual_status,
      rentalStatus: r.rental_status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Updates vehicle verification status.
   *
   * @param {string} vehicleId
   * @param {string} verificationStatus
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async updateVehicleVerificationStatus(vehicleId, verificationStatus, client, reason = null) {
    if (mockVerificationResolver && mockVerificationResolver.updateVehicleVerificationStatus) {
      return mockVerificationResolver.updateVehicleVerificationStatus(
        vehicleId,
        verificationStatus,
      );
    }

    const sql = `
      UPDATE vehicles
      SET verification_status = $2, rejection_reason = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;
    await client.query(sql, [vehicleId, verificationStatus, reason]);

    if (verificationStatus === 'VERIFIED') {
      try {
        await client.query(
          "UPDATE vehicle_documents SET verification_status = 'VERIFIED', updated_at = CURRENT_TIMESTAMP WHERE vehicle_id = $1 AND verification_status = 'PENDING'",
          [vehicleId],
        );
        await client.query(
          "UPDATE vehicle_images SET verification_status = 'VERIFIED', updated_at = CURRENT_TIMESTAMP WHERE vehicle_id = $1 AND verification_status = 'PENDING'",
          [vehicleId],
        );
      } catch (_) {
        // Safe fallback in environments with mocked clients
      }
    }

    return this.findVehicleVerificationById(vehicleId, client);
  }

  /**
   * Resolves a document record from either partner_documents or vehicle_documents.
   *
   * @param {string} documentId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ entityType: 'PARTNER'|'VEHICLE', document: object }|null>}
   */
  async findDocumentById(documentId, client = null) {
    if (mockVerificationResolver && mockVerificationResolver.findDocumentById) {
      return mockVerificationResolver.findDocumentById(documentId);
    }

    const executor = this._getExecutor(client);

    // 1. Check partner_documents
    const partnerDocSql = `
      SELECT
        pd.id,
        pd.partner_id,
        pd.document_type,
        pd.document_number,
        pd.storage_key,
        pd.verification_status,
        pd.version,
        pd.rejection_reason,
        pd.created_at,
        pd.updated_at,
        p.business_name AS entity_name,
        p.kyc_status AS entity_kyc_status
      FROM partner_documents pd
      JOIN partners p ON p.id = pd.partner_id
      WHERE pd.id = $1
      LIMIT 1;
    `;

    const pdRes = await executor(partnerDocSql, [documentId]);
    if (pdRes.rows[0]) {
      const r = pdRes.rows[0];
      return {
        entityType: 'PARTNER',
        document: {
          id: r.id,
          entityId: r.partner_id,
          entityName: r.entity_name,
          entityKycStatus: r.entity_kyc_status,
          documentType: r.document_type,
          documentNumber: r.document_number,
          storageKey: r.storage_key,
          verificationStatus: r.verification_status,
          version: r.version,
          rejectionReason: r.rejection_reason,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        },
      };
    }

    // 2. Check vehicle_documents
    const vehicleDocSql = `
      SELECT
        vd.id,
        vd.vehicle_id,
        vd.document_type,
        vd.document_name,
        vd.document_number,
        vd.valid_till,
        vd.storage_key,
        vd.verification_status,
        vd.is_required,
        vd.version,
        vd.rejection_reason,
        vd.created_at,
        vd.updated_at,
        v.registration_number AS entity_name,
        v.verification_status AS entity_verification_status,
        v.partner_id
      FROM vehicle_documents vd
      JOIN vehicles v ON v.id = vd.vehicle_id
      WHERE vd.id = $1
      LIMIT 1;
    `;

    const vdRes = await executor(vehicleDocSql, [documentId]);
    if (vdRes.rows[0]) {
      const r = vdRes.rows[0];
      return {
        entityType: 'VEHICLE',
        document: {
          id: r.id,
          entityId: r.vehicle_id,
          partnerId: r.partner_id,
          entityName: r.entity_name,
          entityVerificationStatus: r.entity_verification_status,
          documentType: r.document_type,
          documentName: r.document_name,
          documentNumber: r.document_number,
          validTill: r.valid_till,
          storageKey: r.storage_key,
          verificationStatus: r.verification_status,
          isRequired: r.is_required,
          version: r.version,
          rejectionReason: r.rejection_reason,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        },
      };
    }

    return null;
  }

  /**
   * Acquires row lock on partner_document for atomic approval/rejection.
   *
   * @param {string} documentId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findPartnerDocumentByIdForUpdate(documentId, client) {
    if (mockVerificationResolver && mockVerificationResolver.findPartnerDocumentByIdForUpdate) {
      return mockVerificationResolver.findPartnerDocumentByIdForUpdate(documentId);
    }

    const sql = `
      SELECT id, partner_id, document_type, document_number, storage_key,
             verification_status, version, rejection_reason, created_at, updated_at
      FROM partner_documents
      WHERE id = $1
      FOR UPDATE;
    `;
    const res = await client.query(sql, [documentId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
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
    };
  }

  /**
   * Updates partner document verification status and rejection reason atomically.
   *
   * @param {string} documentId
   * @param {object} params
   * @param {string} params.verificationStatus
   * @param {string|null} [params.rejectionReason]
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async updatePartnerDocumentStatus(
    documentId,
    { verificationStatus, rejectionReason = null },
    client,
  ) {
    if (mockVerificationResolver && mockVerificationResolver.updatePartnerDocumentStatus) {
      return mockVerificationResolver.updatePartnerDocumentStatus(documentId, {
        verificationStatus,
        rejectionReason,
      });
    }

    const sql = `
      UPDATE partner_documents
      SET verification_status = $2, rejection_reason = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;
    const res = await client.query(sql, [documentId, verificationStatus, rejectionReason]);
    const r = res.rows[0];
    return {
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
    };
  }

  /**
   * Acquires row lock on vehicle_document for atomic approval/rejection.
   *
   * @param {string} documentId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findVehicleDocumentByIdForUpdate(documentId, client) {
    if (mockVerificationResolver && mockVerificationResolver.findVehicleDocumentByIdForUpdate) {
      return mockVerificationResolver.findVehicleDocumentByIdForUpdate(documentId);
    }

    const sql = `
      SELECT id, vehicle_id, document_type, document_name, document_number, storage_key,
             verification_status, is_required, version, rejection_reason, created_at, updated_at
      FROM vehicle_documents
      WHERE id = $1
      FOR UPDATE;
    `;
    const res = await client.query(sql, [documentId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      documentType: r.document_type,
      documentName: r.document_name,
      documentNumber: r.document_number,
      storageKey: r.storage_key,
      verificationStatus: r.verification_status,
      isRequired: r.is_required,
      version: r.version,
      rejectionReason: r.rejection_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Updates vehicle document verification status and rejection reason atomically.
   *
   * @param {string} documentId
   * @param {object} params
   * @param {string} params.verificationStatus
   * @param {string|null} [params.rejectionReason]
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async updateVehicleDocumentStatus(
    documentId,
    { verificationStatus, rejectionReason = null },
    client,
  ) {
    if (mockVerificationResolver && mockVerificationResolver.updateVehicleDocumentStatus) {
      return mockVerificationResolver.updateVehicleDocumentStatus(documentId, {
        verificationStatus,
        rejectionReason,
      });
    }

    const sql = `
      UPDATE vehicle_documents
      SET verification_status = $2, rejection_reason = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;
    const res = await client.query(sql, [documentId, verificationStatus, rejectionReason]);
    const r = res.rows[0];
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      documentType: r.document_type,
      documentName: r.document_name,
      documentNumber: r.document_number,
      storageKey: r.storage_key,
      verificationStatus: r.verification_status,
      isRequired: r.is_required,
      version: r.version,
      rejectionReason: r.rejection_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Resolves a vehicle image record with parent vehicle information.
   *
   * @param {string} imageId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findVehicleImageById(imageId, client = null) {
    if (mockVerificationResolver && mockVerificationResolver.findVehicleImageById) {
      return mockVerificationResolver.findVehicleImageById(imageId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        vi.id,
        vi.vehicle_id,
        vi.storage_key,
        vi.image_url,
        vi.is_cover,
        vi.sort_order,
        vi.verification_status,
        vi.rejection_reason,
        vi.version,
        vi.parent_image_id,
        vi.verified_at,
        vi.verified_by,
        vi.rejected_at,
        vi.is_active,
        vi.created_at,
        vi.updated_at,
        v.registration_number AS entity_name,
        v.verification_status AS entity_verification_status,
        v.partner_id
      FROM vehicle_images vi
      JOIN vehicles v ON v.id = vi.vehicle_id
      WHERE vi.id = $1
      LIMIT 1;
    `;

    const res = await executor(sql, [imageId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      partnerId: r.partner_id,
      entityName: r.entity_name,
      entityVerificationStatus: r.entity_verification_status,
      storageKey: r.storage_key,
      imageUrl: r.image_url,
      isCover: r.is_cover,
      sortOrder: r.sort_order,
      verificationStatus: r.verification_status || 'PENDING',
      rejectionReason: r.rejection_reason,
      version: r.version || 1,
      parentImageId: r.parent_image_id,
      verifiedAt: r.verified_at,
      verifiedBy: r.verified_by,
      rejectedAt: r.rejected_at,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Acquires row lock on vehicle_images for atomic approval/rejection.
   *
   * @param {string} imageId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findVehicleImageByIdForUpdate(imageId, client) {
    if (mockVerificationResolver && mockVerificationResolver.findVehicleImageByIdForUpdate) {
      return mockVerificationResolver.findVehicleImageByIdForUpdate(imageId);
    }

    const sql = `
      SELECT
        vi.id,
        vi.vehicle_id,
        vi.storage_key,
        vi.image_url,
        vi.is_cover,
        vi.sort_order,
        vi.verification_status,
        vi.rejection_reason,
        vi.version,
        vi.parent_image_id,
        vi.verified_at,
        vi.verified_by,
        vi.rejected_at,
        vi.is_active,
        vi.created_at,
        vi.updated_at,
        v.partner_id,
        v.registration_number AS entity_name,
        v.verification_status AS entity_verification_status
      FROM vehicle_images vi
      JOIN vehicles v ON v.id = vi.vehicle_id
      WHERE vi.id = $1
      FOR UPDATE;
    `;
    const res = await client.query(sql, [imageId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      partnerId: r.partner_id,
      entityName: r.entity_name,
      entityVerificationStatus: r.entity_verification_status,
      storageKey: r.storage_key,
      imageUrl: r.image_url,
      isCover: r.is_cover,
      sortOrder: r.sort_order,
      verificationStatus: r.verification_status || 'PENDING',
      rejectionReason: r.rejection_reason,
      version: r.version || 1,
      parentImageId: r.parent_image_id,
      verifiedAt: r.verified_at,
      verifiedBy: r.verified_by,
      rejectedAt: r.rejected_at,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Updates vehicle image verification status and rejection reason atomically.
   *
   * @param {string} imageId
   * @param {object} params
   * @param {string} params.verificationStatus
   * @param {string|null} [params.rejectionReason]
   * @param {string|null} [params.adminId]
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async updateVehicleImageStatus(
    imageId,
    { verificationStatus, rejectionReason = null, adminId = null },
    client,
  ) {
    if (mockVerificationResolver && mockVerificationResolver.updateVehicleImageStatus) {
      return mockVerificationResolver.updateVehicleImageStatus(imageId, {
        verificationStatus,
        rejectionReason,
        adminId,
      });
    }

    const isVerified = verificationStatus === 'VERIFIED';
    const isRejected = verificationStatus === 'REJECTED';

    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const safeAdminId = (typeof adminId === 'string' && UUID_REGEX.test(adminId.trim())) ? adminId.trim() : null;

    const sql = `
      UPDATE vehicle_images
      SET
        verification_status = $2,
        rejection_reason = $3,
        verified_at = CASE WHEN $4::boolean THEN CURRENT_TIMESTAMP ELSE verified_at END,
        verified_by = CASE WHEN $4::boolean AND $5::uuid IS NOT NULL THEN $5::uuid ELSE verified_by END,
        rejected_at = CASE WHEN $6::boolean THEN CURRENT_TIMESTAMP ELSE rejected_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;
    const res = await client.query(sql, [
      imageId,
      verificationStatus,
      rejectionReason,
      isVerified,
      safeAdminId,
      isRejected,
    ]);
    const r = res.rows[0];
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      storageKey: r.storage_key,
      imageUrl: r.image_url,
      isCover: r.is_cover,
      sortOrder: r.sort_order,
      verificationStatus: r.verification_status,
      rejectionReason: r.rejection_reason,
      version: r.version,
      parentImageId: r.parent_image_id,
      verifiedAt: r.verified_at,
      verifiedBy: r.verified_by,
      rejectedAt: r.rejected_at,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Unified KYC listing across partners and vehicles with filtering, search, and pagination.
   *
   * @param {object} params
   * @param {string} [params.search]
   * @param {string} [params.status]
   * @param {string} [params.entityType]
   * @param {Date} [params.startDate]
   * @param {Date} [params.endDate]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ items: object[], total: number }>}
   */
  async listKycVerifications({
    search = null,
    status = null,
    entityType = null,
    startDate = null,
    endDate = null,
    limit = 10,
    offset = 0,
  } = {}, client = null) {
    if (mockVerificationResolver && mockVerificationResolver.listKycVerifications) {
      return mockVerificationResolver.listKycVerifications({
        search, status, entityType, startDate, endDate, limit, offset,
      });
    }

    const executor = this._getExecutor(client);
    const conditions = [];
    const values = [];
    let idx = 1;

    let searchCond = '';
    if (search && search.trim()) {
      const term = `%${this._escapeLikeWildcards(search.trim())}%`;
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search.trim());
      if (isUuid) {
        searchCond = `(entity_id = $${idx})`;
        values.push(search.trim());
        idx += 1;
      } else {
        searchCond = `(entity_name ILIKE $${idx} OR secondary_name ILIKE $${idx})`;
        values.push(term);
        idx += 1;
      }
    }

    if (status) {
      conditions.push(`status = $${idx}`);
      values.push(status);
      idx += 1;
    }

    if (entityType) {
      conditions.push(`entity_type = $${idx}`);
      values.push(entityType);
      idx += 1;
    }

    if (startDate) {
      conditions.push(`created_at >= $${idx}`);
      values.push(startDate);
      idx += 1;
    }

    if (endDate) {
      conditions.push(`created_at < $${idx}`);
      values.push(endDate);
      idx += 1;
    }

    if (searchCond) {
      conditions.push(searchCond);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      WITH unified_kyc AS (
        SELECT
          p.id AS entity_id,
          'PARTNER' AS entity_type,
          p.business_name AS entity_name,
          u.name AS secondary_name,
          p.kyc_status AS status,
          p.created_at,
          p.updated_at,
          COUNT(pd.id)::int AS total_documents,
          COUNT(pd.id) FILTER (WHERE pd.verification_status = 'PENDING')::int AS pending_documents
        FROM partners p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN partner_documents pd ON pd.partner_id = p.id
        GROUP BY p.id, u.id

        UNION ALL

        SELECT
          v.id AS entity_id,
          'VEHICLE' AS entity_type,
          v.registration_number AS entity_name,
          (v.brand || ' ' || v.model) AS secondary_name,
          v.verification_status AS status,
          v.created_at,
          v.updated_at,
          COUNT(vd.id)::int AS total_documents,
          COUNT(vd.id) FILTER (WHERE vd.verification_status = 'PENDING')::int AS pending_documents
        FROM vehicles v
        LEFT JOIN vehicle_documents vd ON vd.vehicle_id = v.id
        GROUP BY v.id
      )
      SELECT
        entity_id,
        entity_type,
        entity_name,
        secondary_name,
        status,
        created_at,
        updated_at,
        total_documents,
        pending_documents,
        COUNT(*) OVER()::int AS full_count
      FROM unified_kyc
      ${whereClause}
      ORDER BY created_at DESC, entity_id DESC
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    values.push(limit, offset);
    const res = await executor(sql, values);

    const total = res.rows[0] ? res.rows[0].full_count : 0;
    const items = res.rows.map((r) => ({
      entityId: r.entity_id,
      entityType: r.entity_type,
      entityName: r.entity_name,
      secondaryName: r.secondary_name,
      status: r.status,
      totalDocuments: r.total_documents,
      pendingDocuments: r.pending_documents,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return { items, total };
  }
}

module.exports = new AdminVerificationRepository();
