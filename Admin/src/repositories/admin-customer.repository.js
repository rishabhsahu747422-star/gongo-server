'use strict';

const BaseRepository = require('../db/base.repository');

let mockCustomerResolver = null;

class AdminCustomerRepository extends BaseRepository {
  constructor() {
    super('users', 'id');
  }

  /**
   * For unit testing: inject mock resolver
   * @param {object|null} resolver
   */
  static setMockCustomerResolver(resolver) {
    mockCustomerResolver = resolver;
  }

  static resetMockCustomerResolver() {
    mockCustomerResolver = null;
  }

  /**
   * Returns query executor (client or pool query).
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
   * Lists customers with parameterized filtering, search, pagination, and sorting.
   *
   * @param {object} params
   * @param {string} [params.search]
   * @param {boolean} [params.isActive]
   * @param {Date} [params.startDate]
   * @param {Date} [params.endDate]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {string} [params.sortBy='created_at']
   * @param {string} [params.sortOrder='DESC']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ customers: object[], total: number }>}
   */
  async listCustomers({
    search = null,
    isActive = null,
    startDate = null,
    endDate = null,
    limit = 10,
    offset = 0,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  } = {}, client = null) {
    if (mockCustomerResolver && mockCustomerResolver.listCustomers) {
      return mockCustomerResolver.listCustomers({
        search,
        isActive,
        startDate,
        endDate,
        limit,
        offset,
        sortBy,
        sortOrder,
      });
    }

    const executor = this._getExecutor(client);
    const conditions = ["(u.role = 'CUSTOMER' OR u.role = 'customer')"];
    const values = [];

    let paramIdx = 1;

    if (search && typeof search === 'string' && search.trim()) {
      const sanitized = this._escapeLikeWildcards(search.trim());
      const pattern = `%${sanitized}%`;

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(search.trim());

      if (isUuid) {
        conditions.push(`(
          u.name ILIKE $${paramIdx} OR
          u.email ILIKE $${paramIdx} OR
          u.phone ILIKE $${paramIdx} OR
          u.customer_reference ILIKE $${paramIdx} OR
          cp.customer_reference ILIKE $${paramIdx} OR
          u.id = $${paramIdx + 1}
        )`);
        values.push(pattern, search.trim());
        paramIdx += 2;
      } else {
        conditions.push(`(
          u.name ILIKE $${paramIdx} OR
          u.email ILIKE $${paramIdx} OR
          u.phone ILIKE $${paramIdx} OR
          u.customer_reference ILIKE $${paramIdx} OR
          cp.customer_reference ILIKE $${paramIdx}
        )`);
        values.push(pattern);
        paramIdx += 1;
      }
    }

    if (typeof isActive === 'boolean') {
      conditions.push(`u.is_active = $${paramIdx}`);
      values.push(isActive);
      paramIdx += 1;
    }

    if (startDate instanceof Date) {
      conditions.push(`u.created_at >= $${paramIdx}`);
      values.push(startDate);
      paramIdx += 1;
    }

    if (endDate instanceof Date) {
      conditions.push(`u.created_at < $${paramIdx}`);
      values.push(endDate);
      paramIdx += 1;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const ALLOWED_SORT_COLS = {
      created_at: 'u.created_at',
      updated_at: 'u.updated_at',
      name: 'u.name',
      email: 'u.email',
      phone: 'u.phone',
    };
    const sortCol = ALLOWED_SORT_COLS[sortBy] || 'u.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    values.push(safeLimit, safeOffset);
    const limitIdx = paramIdx;
    const offsetIdx = paramIdx + 1;

    const sql = `
      SELECT
        u.id,
        COALESCE(u.customer_reference, cp.customer_reference) AS customer_reference,
        COALESCE(cp.full_name, u.name) AS name,
        u.email,
        u.phone,
        u.country_code,
        cp.profile_photo_url,
        cp.profile_photo_path,
        u.is_active,
        u.created_at,
        u.updated_at,
        COALESCE(b.booking_count, 0)::int AS booking_count,
        COALESCE(p.total_spend, 0)::numeric AS total_spend,
        COUNT(*) OVER()::int AS full_count
      FROM users u
      LEFT JOIN customer_profiles cp ON cp.user_id = u.id
      LEFT JOIN (
        SELECT customer_id, COUNT(*)::int AS booking_count
        FROM bookings
        GROUP BY customer_id
      ) b ON b.customer_id = u.id
      LEFT JOIN (
        SELECT customer_id, SUM(amount) AS total_spend
        FROM payments
        WHERE status = 'SUCCESS'
        GROUP BY customer_id
      ) p ON p.customer_id = u.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}, u.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const res = await executor(sql, values);
    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;

    const customers = res.rows.map((r) => {
      const photo = r.profile_photo_url || r.profile_photo_path || null;
      return {
        id: r.id,
        customerReference: r.customer_reference || null,
        name: r.name,
        email: r.email,
        phone: r.phone,
        countryCode: r.country_code,
        avatarStorageKey: r.profile_photo_path || null,
        avatarUrl: photo,
        photoUrl: photo,
        profilePhotoUrl: photo,
        isActive: r.is_active,
        bookingCount: r.booking_count,
        totalSpend: parseFloat(r.total_spend || 0),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });

    return { customers, total };
  }

  /**
   * Finds a customer by UUID with projection safety.
   *
   * @param {string} customerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findCustomerById(customerId, client = null) {
    if (mockCustomerResolver && mockCustomerResolver.findCustomerById) {
      return mockCustomerResolver.findCustomerById(customerId);
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(customerId).trim());
    const idCond = isUuid ? 'u.id = $1' : '(u.customer_reference = $1 OR cp.customer_reference = $1)';

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        u.id,
        COALESCE(u.customer_reference, cp.customer_reference) AS customer_reference,
        COALESCE(cp.full_name, u.name) AS name,
        u.email,
        u.phone,
        u.country_code,
        cp.profile_photo_url,
        cp.profile_photo_path,
        u.is_active,
        u.created_at,
        u.updated_at
      FROM users u
      LEFT JOIN customer_profiles cp ON cp.user_id = u.id
      WHERE (${idCond}) AND (u.role ILIKE 'CUSTOMER')
      LIMIT 1;
    `;

    const res = await executor(sql, [customerId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    const photo = r.profile_photo_url || r.profile_photo_path || null;
    return {
      id: r.id,
      customerReference: r.customer_reference || null,
      name: r.name,
      email: r.email,
      phone: r.phone,
      countryCode: r.country_code,
      avatarStorageKey: r.profile_photo_path || null,
      avatarUrl: photo,
      photoUrl: photo,
      profilePhotoUrl: photo,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Retrieves operational summaries for a single customer
   * (bookings, payments, documents, addresses).
   *
   * @param {string} customerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getCustomerSummaries(customerId, client = null) {
    if (mockCustomerResolver && mockCustomerResolver.getCustomerSummaries) {
      return mockCustomerResolver.getCustomerSummaries(customerId);
    }

    const executor = this._getExecutor(client);

    const bookingSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE booking_status IN ('UPCOMING', 'CONFIRMED'))::int AS upcoming,
        COUNT(*) FILTER (WHERE booking_status = 'ACTIVE')::int AS active,
        COUNT(*) FILTER (WHERE booking_status = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE booking_status = 'CANCELLED')::int AS cancelled
      FROM bookings
      WHERE customer_id = $1;
    `;

    const paymentSql = `
      SELECT
        COUNT(*)::int AS total_payments,
        COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS successful_payments,
        COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_payments,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_payments,
        COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCESS'), 0)::numeric AS total_spent
      FROM payments
      WHERE customer_id = $1;
    `;

    const documentSql = `
      SELECT
        COUNT(*)::int AS total_documents,
        COUNT(*) FILTER (WHERE UPPER(verification_status) = 'VERIFIED')::int AS verified_documents,
        COUNT(*) FILTER (WHERE UPPER(verification_status) = 'PENDING')::int AS pending_documents,
        COUNT(*) FILTER (WHERE UPPER(verification_status) = 'REJECTED')::int AS rejected_documents
      FROM customer_documents
      WHERE customer_id = $1;
    `;

    const addressSql = `
      SELECT COUNT(*)::int AS address_count
      FROM customer_addresses
      WHERE user_id = $1;
    `;

    const [bRes, pRes, dRes, aRes] = await Promise.all([
      executor(bookingSql, [customerId]),
      executor(paymentSql, [customerId]),
      executor(documentSql, [customerId]),
      executor(addressSql, [customerId]),
    ]);

    const bRow = bRes.rows[0] || {};
    const pRow = pRes.rows[0] || {};
    const dRow = dRes.rows[0] || {};
    const aRow = aRes.rows[0] || {};

    return {
      bookingSummary: {
        total: bRow.total || 0,
        upcoming: bRow.upcoming || 0,
        active: bRow.active || 0,
        completed: bRow.completed || 0,
        cancelled: bRow.cancelled || 0,
      },
      paymentSummary: {
        totalPayments: pRow.total_payments || 0,
        successfulPayments: pRow.successful_payments || 0,
        pendingPayments: pRow.pending_payments || 0,
        failedPayments: pRow.failed_payments || 0,
        totalSpent: parseFloat(pRow.total_spent || 0),
      },
      documentSummary: {
        totalDocuments: dRow.total_documents || 0,
        verifiedDocuments: dRow.verified_documents || 0,
        pendingDocuments: dRow.pending_documents || 0,
        rejectedDocuments: dRow.rejected_documents || 0,
      },
      addressCount: aRow.address_count || 0,
    };
  }

  /**
   * Counts active bookings currently associated with this customer.
   *
   * @param {string} customerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async getActiveBookingCount(customerId, client = null) {
    if (mockCustomerResolver && mockCustomerResolver.getActiveBookingCount) {
      return mockCustomerResolver.getActiveBookingCount(customerId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT COUNT(*)::int AS count
      FROM bookings
      WHERE customer_id = $1
        AND booking_status IN ('UPCOMING', 'ACTIVE', 'CONFIRMED');
    `;
    const res = await executor(sql, [customerId]);
    return res.rows[0] ? res.rows[0].count : 0;
  }

  /**
   * Retrieves customer row with row-level lock (FOR UPDATE) for concurrency safety.
   *
   * @param {string} customerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findCustomerByIdForUpdate(customerId, client = null) {
    if (mockCustomerResolver && mockCustomerResolver.findCustomerByIdForUpdate) {
      return mockCustomerResolver.findCustomerByIdForUpdate(customerId, client);
    }

    if (!client || typeof client.query !== 'function') {
      return this.findCustomerById(customerId, client);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT id, name, email, phone, is_active, role
      FROM users
      WHERE id = $1 AND role = 'CUSTOMER' OR (id = $1 AND role = 'customer')
      FOR UPDATE;
    `;
    const res = await executor(sql, [customerId]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      isActive: r.is_active,
      role: r.role,
    };
  }

  /**
   * Updates customer active status atomically.
   *
   * @param {string} customerId
   * @param {boolean} isActive
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async updateCustomerStatus(customerId, isActive, client = null) {
    if (mockCustomerResolver && mockCustomerResolver.updateCustomerStatus) {
      return mockCustomerResolver.updateCustomerStatus(customerId, isActive);
    }

    const executor = this._getExecutor(client);
    const sql = `
      UPDATE users
      SET is_active = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND role = 'CUSTOMER' OR (id = $1 AND role = 'customer')
      RETURNING *;
    `;

    await executor(sql, [customerId, isActive]);
    return this.findCustomerById(customerId, client);
  }

  /**
   * Retrieves bookings for a customer with pagination and filters.
   *
   * @param {string} customerId
   * @param {object} params
   * @param {string} [params.status]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ bookings: object[], total: number }>}
   */
  async getCustomerBookings(
    customerId,
    { status = null, limit = 10, offset = 0 } = {},
    client = null,
  ) {
    if (mockCustomerResolver && mockCustomerResolver.getCustomerBookings) {
      return mockCustomerResolver.getCustomerBookings(customerId, { status, limit, offset });
    }

    const executor = this._getExecutor(client);
    const conditions = ['b.customer_id = $1'];
    const values = [customerId];
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
        b.id,
        b.booking_reference,
        b.booking_number,
        b.customer_id,
        b.partner_id,
        b.vehicle_id,
        v.vehicle_reference,
        b.start_at,
        b.expected_return_at,
        b.booking_status,
        b.payment_status,
        b.pickup_location,
        b.created_at,
        b.updated_at,
        v.brand AS vehicle_brand,
        v.model AS vehicle_model,
        v.registration_number AS vehicle_registration_number,
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
          COALESCE(rev.rating, rat_v.rating_score, rat_p.rating_score)::int AS rating,
          COALESCE(rev.review_text, rat_v.review_comment, rat_p.review_comment) AS review_comment
        FROM (SELECT 1) _dummy
        LEFT JOIN reviews rev ON rev.booking_id = b.id
        LEFT JOIN ratings rat_v ON rat_v.booking_id = b.id AND rat_v.target_type = 'VEHICLE'
        LEFT JOIN ratings rat_p ON rat_p.booking_id = b.id AND rat_p.target_type = 'PARTNER'
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
      partnerId: r.partner_id,
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
   * Retrieves payments for a customer with pagination and filters.
   *
   * @param {string} customerId
   * @param {object} params
   * @param {string} [params.status]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ payments: object[], total: number }>}
   */
  async getCustomerPayments(
    customerId,
    { status = null, limit = 10, offset = 0 } = {},
    client = null,
  ) {
    if (mockCustomerResolver && mockCustomerResolver.getCustomerPayments) {
      return mockCustomerResolver.getCustomerPayments(customerId, { status, limit, offset });
    }

    const executor = this._getExecutor(client);
    const conditions = ['p.customer_id = $1'];
    const values = [customerId];
    let idx = 2;

    if (status) {
      conditions.push(`p.status = $${idx}`);
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
        p.id,
        p.order_reference,
        p.booking_id,
        p.customer_id,
        p.provider,
        p.amount,
        p.currency,
        p.status,
        p.payment_method,
        p.payment_type,
        p.failure_reason,
        p.created_at,
        p.updated_at,
        COUNT(*) OVER()::int AS full_count
      FROM payments p
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const res = await executor(sql, values);
    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;

    const payments = res.rows.map((r) => ({
      id: r.id,
      orderReference: r.order_reference || null,
      bookingId: r.booking_id,
      customerId: r.customer_id,
      provider: r.provider,
      amount: parseFloat(r.amount || 0),
      currency: r.currency,
      status: r.status,
      paymentMethod: r.payment_method,
      paymentType: r.payment_type,
      failureReason: r.failure_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return { payments, total };
  }

  /**
   * Retrieves customer documents with safe metadata.
   *
   * @param {string} customerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getCustomerDocuments(customerId, client = null) {
    if (mockCustomerResolver && mockCustomerResolver.getCustomerDocuments) {
      return mockCustomerResolver.getCustomerDocuments(customerId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id,
        customer_id,
        document_type,
        document_number,
        file_url,
        COALESCE(storage_path, file_url) AS storage_path,
        file_name,
        file_type,
        file_size_bytes,
        verification_status,
        rejection_reason,
        verified_at,
        created_at,
        updated_at
      FROM customer_documents
      WHERE customer_id = $1
      ORDER BY created_at DESC, id DESC;
    `;

    const res = await executor(sql, [customerId]);
    const supabaseStorage = require('../providers/supabase-storage');

    const documents = await Promise.all(
      res.rows.map(async (r) => {
        const rawType = r.document_type || '';
        let formattedType = rawType;
        if (rawType.toLowerCase() === 'aadhaar') formattedType = 'Aadhaar Card';
        else if (rawType.toLowerCase() === 'driving_license') formattedType = 'Driving License';
        else if (rawType) formattedType = rawType.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

        const storageKey = r.storage_path || r.file_url || null;
        let viewUrl = r.file_url || null;

        if (storageKey && (!viewUrl || (!viewUrl.startsWith('http://') && !viewUrl.startsWith('https://')))) {
          try {
            const presigned = await supabaseStorage.createPresignedDownloadUrl({
              path: storageKey,
              expiresInSeconds: 3600,
            });
            if (presigned?.downloadUrl) {
              viewUrl = presigned.downloadUrl;
            }
          } catch (_) {
            viewUrl = supabaseStorage.getPublicUrl(storageKey);
          }
        }

        return {
          id: r.id,
          customerId: r.customer_id,
          userId: r.customer_id,
          documentType: formattedType,
          documentName: formattedType,
          rawDocumentType: rawType,
          documentNumber: r.document_number || '—',
          status: (r.verification_status || 'pending').toLowerCase(),
          verificationStatus: (r.verification_status || 'pending').toLowerCase(),
          fileUrl: viewUrl,
          downloadUrl: viewUrl,
          documentUrl: viewUrl,
          storageKey,
          storagePath: storageKey,
          fileName: r.file_name,
          fileType: r.file_type,
          fileSizeBytes: r.file_size_bytes,
          rejectionReason: r.rejection_reason,
          verifiedAt: r.verified_at,
          createdAt: r.created_at,
          uploadedAt: r.created_at,
          updatedAt: r.updated_at,
          category: rawType.toLowerCase() === 'driving_license' ? 'Driving License' : 'Identity',
        };
      }),
    );

    return documents;
  }

  /**
   * Retrieves saved customer addresses.
   *
   * @param {string} customerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getCustomerAddresses(customerId, client = null) {
    if (mockCustomerResolver && mockCustomerResolver.getCustomerAddresses) {
      return mockCustomerResolver.getCustomerAddresses(customerId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id,
        user_id,
        label,
        full_address,
        address_line1,
        address_line2,
        landmark,
        city,
        state,
        postal_code,
        country_code,
        latitude,
        longitude,
        is_default,
        created_at,
        updated_at
      FROM customer_addresses
      WHERE user_id = $1
      ORDER BY is_default DESC, created_at DESC;
    `;

    const res = await executor(sql, [customerId]);
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      label: r.label,
      fullAddress: r.full_address,
      addressLine1: r.address_line1,
      addressLine2: r.address_line2,
      landmark: r.landmark,
      city: r.city,
      state: r.state,
      postalCode: r.postal_code,
      countryCode: r.country_code,
      latitude: r.latitude ? parseFloat(r.latitude) : null,
      longitude: r.longitude ? parseFloat(r.longitude) : null,
      isDefault: r.is_default,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Retrieves identity verifications for a customer.
   *
   * @param {string} customerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getCustomerVerifications(customerId, client = null) {
    if (mockCustomerResolver && mockCustomerResolver.getCustomerVerifications) {
      return mockCustomerResolver.getCustomerVerifications(customerId);
    }

    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT
          id,
          customer_id,
          document_type,
          verification_provider,
          verification_method,
          verification_status,
          provider_reference,
          verified_name,
          verified_date_of_birth,
          verified_gender,
          verified_address,
          verified_state,
          verified_city,
          verified_postal,
          document_reference,
          aadhaar_registered_mobile,
          submitted_at,
          verified_at,
          failed_at,
          failure_reason,
          created_at,
          updated_at
        FROM customer_identity_verifications
        WHERE customer_id = $1
        ORDER BY created_at DESC;
      `;
      const res = await executor(sql, [customerId]);
      return res.rows;
    } catch (_) {
      return [];
    }
  }

  /**
   * Retrieves support tickets created by a customer.
   *
   * @param {string} customerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getCustomerSupportTickets(customerId, client = null) {
    if (mockCustomerResolver && mockCustomerResolver.getCustomerSupportTickets) {
      return mockCustomerResolver.getCustomerSupportTickets(customerId);
    }

    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT
          id,
          ticket_number,
          user_id,
          booking_id,
          partner_id,
          subject,
          description,
          category,
          priority,
          status,
          assigned_to,
          resolved_at,
          closed_at,
          created_at,
          updated_at
        FROM support_tickets
        WHERE user_id = $1
        ORDER BY created_at DESC;
      `;
      const res = await executor(sql, [customerId]);
      return res.rows;
    } catch (_) {
      return [];
    }
  }

  /**
   * Retrieves recent administrative actions taken on this customer.
   *
   * @param {string} customerId
   * @param {object} params
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ activity: object[], total: number }>}
   */
  async getCustomerActivity(
    customerId,
    { limit = 10, offset = 0 } = {},
    client = null,
  ) {
    if (mockCustomerResolver && mockCustomerResolver.getCustomerActivity) {
      return mockCustomerResolver.getCustomerActivity(customerId, { limit, offset });
    }

    const executor = this._getExecutor(client);
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    const sql = `
      SELECT
        id,
        actor_id,
        actor_role,
        permission,
        action,
        target_resource,
        target_resource_id,
        request_id,
        before_state,
        after_state,
        metadata,
        created_at,
        COUNT(*) OVER()::int AS full_count
      FROM admin_actions
      WHERE target_resource = 'CUSTOMER' AND target_resource_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3;
    `;

    const res = await executor(sql, [customerId, safeLimit, safeOffset]);
    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;

    const activity = res.rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorRole: r.actor_role,
      permission: r.permission,
      action: r.action,
      targetResource: r.target_resource,
      targetResourceId: r.target_resource_id,
      requestId: r.request_id,
      beforeState: r.before_state,
      afterState: r.after_state,
      metadata: r.metadata,
      createdAt: r.created_at,
    }));

    return { activity, total };
  }
}

module.exports = new AdminCustomerRepository();
