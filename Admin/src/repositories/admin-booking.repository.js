'use strict';

const BaseRepository = require('../db/base.repository');

let mockBookingResolver = null;

class AdminBookingRepository extends BaseRepository {
  constructor() {
    super('bookings', 'id');
  }

  /**
   * For unit testing: inject mock resolver
   * @param {object|null} resolver
   */
  static setMockBookingResolver(resolver) {
    mockBookingResolver = resolver;
  }

  static resetMockBookingResolver() {
    mockBookingResolver = null;
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
   * Lists bookings with parameterized filtering, search, pagination, and sorting.
   *
   * @param {object} params
   * @param {string} [params.search]
   * @param {string} [params.bookingStatus]
   * @param {string} [params.paymentStatus]
   * @param {string} [params.customerId]
   * @param {string} [params.partnerId]
   * @param {string} [params.vehicleId]
   * @param {Date} [params.startDate]
   * @param {Date} [params.endDate]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {string} [params.sortBy='created_at']
   * @param {string} [params.sortOrder='DESC']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ bookings: object[], total: number }>}
   */
  async listBookings({
    search = null,
    bookingStatus = null,
    paymentStatus = null,
    customerId = null,
    partnerId = null,
    vehicleId = null,
    startDate = null,
    endDate = null,
    limit = 10,
    offset = 0,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  } = {}, client = null) {
    if (mockBookingResolver && mockBookingResolver.listBookings) {
      return mockBookingResolver.listBookings({
        search,
        bookingStatus,
        paymentStatus,
        customerId,
        partnerId,
        vehicleId,
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

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(search.trim());

      if (isUuid) {
        conditions.push(`(
          b.booking_number ILIKE $${paramIdx} OR
          b.booking_reference ILIKE $${paramIdx} OR
          u.name ILIKE $${paramIdx} OR
          u.phone ILIKE $${paramIdx} OR
          p.business_name ILIKE $${paramIdx} OR
          v.registration_number ILIKE $${paramIdx} OR
          v.vehicle_reference ILIKE $${paramIdx} OR
          b.id = $${paramIdx + 1} OR
          b.customer_id = $${paramIdx + 1} OR
          b.partner_id = $${paramIdx + 1} OR
          b.vehicle_id = $${paramIdx + 1}
        )`);
        values.push(pattern, search.trim());
        paramIdx += 2;
      } else {
        conditions.push(`(
          b.booking_number ILIKE $${paramIdx} OR
          b.booking_reference ILIKE $${paramIdx} OR
          u.name ILIKE $${paramIdx} OR
          u.phone ILIKE $${paramIdx} OR
          p.business_name ILIKE $${paramIdx} OR
          v.registration_number ILIKE $${paramIdx} OR
          v.vehicle_reference ILIKE $${paramIdx}
        )`);
        values.push(pattern);
        paramIdx += 1;
      }
    }

    if (bookingStatus && typeof bookingStatus === 'string' && bookingStatus.trim()) {
      const normalizedStatus = bookingStatus.trim().toUpperCase();
      if (normalizedStatus === 'ACTIVE' || normalizedStatus === 'IN_PROGRESS') {
        conditions.push(`(b.booking_status = $${paramIdx} OR UPPER(COALESCE(b.booking_status, '')) IN ('ACTIVE', 'IN_PROGRESS') OR LOWER(COALESCE(b.status, '')) IN ('in_progress', 'active', 'vehicle_picked'))`);
      } else if (
        normalizedStatus === 'CONFIRMED'
        || normalizedStatus === 'BOOKED'
        || normalizedStatus === 'UPCOMING'
        || normalizedStatus === 'PICKUP_SCHEDULED'
        || normalizedStatus === 'CONFIRMED_UPCOMING'
      ) {
        conditions.push(`(b.booking_status = $${paramIdx} OR UPPER(COALESCE(b.booking_status, '')) IN ('CONFIRMED', 'BOOKED', 'UPCOMING', 'PICKUP_SCHEDULED') OR LOWER(COALESCE(b.status, '')) IN ('confirmed', 'payment_completed', 'upcoming', 'pickup_scheduled'))`);
      } else if (normalizedStatus === 'COMPLETED') {
        conditions.push(`(b.booking_status = $${paramIdx} OR LOWER(COALESCE(b.status, '')) IN ('completed', 'returned'))`);
      } else if (normalizedStatus === 'CANCELLED') {
        conditions.push(`(b.booking_status = $${paramIdx} OR LOWER(COALESCE(b.status, '')) IN ('cancelled', 'refunded'))`);
      } else if (normalizedStatus === 'PENDING' || normalizedStatus === 'PENDING_PAYMENT') {
        conditions.push(`(b.booking_status = $${paramIdx} OR UPPER(COALESCE(b.booking_status, '')) IN ('PENDING', 'PENDING_PAYMENT') OR LOWER(COALESCE(b.status, '')) IN ('initiated', 'pending'))`);
      } else {
        conditions.push(`(b.booking_status = $${paramIdx} OR LOWER(COALESCE(b.status, '')) = LOWER($${paramIdx}))`);
      }
      values.push(normalizedStatus);
      paramIdx += 1;
    }

    if (paymentStatus && typeof paymentStatus === 'string' && paymentStatus.trim()) {
      conditions.push(`b.payment_status = $${paramIdx}`);
      values.push(paymentStatus.trim().toUpperCase());
      paramIdx += 1;
    }

    if (customerId && typeof customerId === 'string' && customerId.trim()) {
      conditions.push(`b.customer_id = $${paramIdx}`);
      values.push(customerId.trim());
      paramIdx += 1;
    }

    if (partnerId && typeof partnerId === 'string' && partnerId.trim()) {
      conditions.push(`b.partner_id = $${paramIdx}`);
      values.push(partnerId.trim());
      paramIdx += 1;
    }

    if (vehicleId && typeof vehicleId === 'string' && vehicleId.trim()) {
      conditions.push(`b.vehicle_id = $${paramIdx}`);
      values.push(vehicleId.trim());
      paramIdx += 1;
    }

    if (startDate instanceof Date) {
      conditions.push(`b.created_at >= $${paramIdx}`);
      values.push(startDate);
      paramIdx += 1;
    }

    if (endDate instanceof Date) {
      conditions.push(`b.created_at < $${paramIdx}`);
      values.push(endDate);
      paramIdx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const ALLOWED_SORT_COLS = {
      created_at: 'b.created_at',
      updated_at: 'b.updated_at',
      start_at: 'b.start_at',
      expected_return_at: 'b.expected_return_at',
      booking_number: 'b.booking_number',
      booking_status: 'b.booking_status',
    };
    const sortCol = ALLOWED_SORT_COLS[sortBy] || 'b.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    values.push(safeLimit, safeOffset);
    const limitIdx = paramIdx;
    const offsetIdx = paramIdx + 1;

    const sql = `
      SELECT
        b.id,
        b.booking_reference,
        b.booking_number,
        b.customer_id,
        u.customer_reference,
        b.partner_id,
        p.partner_reference,
        b.shop_id,
        b.vehicle_id,
        v.vehicle_reference,
        b.start_at,
        b.expected_return_at,
        b.status,
        b.booking_status,
        b.payment_status,
        b.pickup_location,
        b.created_at,
        b.updated_at,
        u.name AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,
        p.business_name AS partner_name,
        p.city AS partner_city,
        v.registration_number AS vehicle_registration_number,
        v.brand AS vehicle_brand,
        v.model AS vehicle_model,
        v.category AS vehicle_category,
        COALESCE(img.image_url, img.storage_key, v.primary_image_url, '') AS vehicle_cover_image_url,
        img.storage_key AS vehicle_image_storage_key,
        COALESCE(bps.total_customer_amount, 0)::numeric AS total_amount,
        COALESCE(bps.security_deposit, 0)::numeric AS security_deposit,
        br.rating AS booking_rating,
        br.review_comment AS booking_review_comment,
        COUNT(*) OVER()::int AS full_count
      FROM bookings b
      LEFT JOIN users u ON u.id = b.customer_id
      LEFT JOIN partners p ON p.id = b.partner_id
      LEFT JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN (
        SELECT DISTINCT ON (vehicle_id) vehicle_id, image_url, storage_key
        FROM vehicle_images
        WHERE is_active = true
        ORDER BY vehicle_id, is_cover DESC, sort_order ASC, created_at ASC
      ) img ON img.vehicle_id = v.id
      LEFT JOIN booking_pricing_snapshots bps ON bps.booking_id = b.id
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
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}, b.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const res = await executor(sql, values);
    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;

    const bookings = res.rows.map((r) => ({
      id: r.id,
      bookingReference: r.booking_reference || r.booking_number,
      bookingNumber: r.booking_reference || r.booking_number,
      customerId: r.customer_id,
      customerReference: r.customer_reference || null,
      partnerId: r.partner_id,
      partnerReference: r.partner_reference || null,
      shopId: r.shop_id,
      vehicleId: r.vehicle_id,
      vehicleReference: r.vehicle_reference || null,
      startAt: r.start_at,
      expectedReturnAt: r.expected_return_at,
      status: r.status || (r.booking_status ? r.booking_status.toLowerCase() : 'confirmed'),
      bookingStatus: r.booking_status || (r.status ? r.status.toUpperCase() : 'CONFIRMED'),
      paymentStatus: r.payment_status,
      rating: r.booking_rating !== null && r.booking_rating !== undefined ? parseInt(r.booking_rating, 10) : null,
      review: r.booking_rating !== null && r.booking_rating !== undefined ? {
        rating: parseInt(r.booking_rating, 10),
        comment: r.booking_review_comment || null,
      } : null,
      reviewComment: r.booking_review_comment || null,
      pickupLocation: r.pickup_location,
      customer: {
        id: r.customer_id,
        customerReference: r.customer_reference || null,
        name: r.customer_name,
        email: r.customer_email,
        phone: r.customer_phone,
      },
      partner: {
        id: r.partner_id,
        partnerReference: r.partner_reference || null,
        businessName: r.partner_name,
        city: r.partner_city,
      },
      vehicle: {
        id: r.vehicle_id,
        vehicleReference: r.vehicle_reference || null,
        registrationNumber: r.vehicle_registration_number,
        brand: r.vehicle_brand,
        model: r.vehicle_model,
        category: r.vehicle_category,
        coverImageUrl: r.vehicle_cover_image_url || null,
        primaryImage: r.vehicle_cover_image_url || null,
        primaryImageUrl: r.vehicle_cover_image_url || null,
        storageKey: r.vehicle_image_storage_key || null,
      },
      coverImageUrl: r.vehicle_cover_image_url || null,
      vehicleImage: r.vehicle_cover_image_url || null,
      totalAmount: parseFloat(r.total_amount || 0),
      securityDeposit: parseFloat(r.security_deposit || 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return { bookings, total };
  }

  /**
   * Finds a booking by UUID with projection safety and joined entities.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findBookingById(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.findBookingById) {
      return mockBookingResolver.findBookingById(bookingId);
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}-[0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(bookingId).trim());
    const idCondition = isUuid ? 'b.id = $1' : '(b.booking_reference = $1 OR b.booking_number = $1)';

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        b.id,
        b.booking_reference,
        b.booking_number,
        b.customer_id,
        u.customer_reference,
        b.partner_id,
        p.partner_reference,
        b.shop_id,
        b.vehicle_id,
        v.vehicle_reference,
        b.start_at,
        b.expected_return_at,
        b.status,
        b.booking_status,
        b.payment_status,
        b.pickup_location,
        b.created_at,
        b.updated_at,
        u.name AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,
        u.country_code AS customer_country_code,
        p.business_name AS partner_name,
        p.city AS partner_city,
        pu.name AS partner_owner_name,
        pu.phone AS partner_owner_phone,
        v.registration_number AS vehicle_registration_number,
        v.brand AS vehicle_brand,
        v.model AS vehicle_model,
        v.variant AS vehicle_variant,
        v.category AS vehicle_category,
        v.fuel_type AS vehicle_fuel_type,
        NULL::text AS vehicle_transmission,
        COALESCE(img.image_url, img.storage_key, v.primary_image_url, '') AS vehicle_cover_image_url,
        img.storage_key AS vehicle_image_storage_key,
        br.rating AS booking_rating,
        br.review_comment AS booking_review_comment
      FROM bookings b
      LEFT JOIN users u ON u.id = b.customer_id
      LEFT JOIN partners p ON p.id = b.partner_id
      LEFT JOIN users pu ON pu.id = p.user_id
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
      WHERE ${idCondition}
      LIMIT 1;
    `;

    const res = await executor(sql, [bookingId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];

    let vehicleImages = [];
    if (r.vehicle_id) {
      try {
        const imgSql = `
          SELECT
            id, vehicle_id, storage_key, image_url, sort_order, is_cover, is_active, created_at
          FROM vehicle_images
          WHERE vehicle_id = $1 AND is_active = true
          ORDER BY is_cover DESC, sort_order ASC, created_at ASC;
        `;
        const imgRes = await executor(imgSql, [r.vehicle_id]);
        vehicleImages = (imgRes.rows || []).map((imgRow) => ({
          id: imgRow.id,
          vehicleId: imgRow.vehicle_id,
          storageKey: imgRow.storage_key,
          imageUrl: imgRow.image_url || imgRow.storage_key,
          sortOrder: imgRow.sort_order,
          isCover: imgRow.is_cover,
          isActive: imgRow.is_active,
          createdAt: imgRow.created_at,
        }));
      } catch (_) {
        // Safe fallback if vehicle_images table is not reachable
      }
    }

    return {
      id: r.id,
      bookingReference: r.booking_reference || r.booking_number,
      bookingNumber: r.booking_reference || r.booking_number,
      customerId: r.customer_id,
      customerReference: r.customer_reference || null,
      partnerId: r.partner_id,
      partnerReference: r.partner_reference || null,
      shopId: r.shop_id,
      vehicleId: r.vehicle_id,
      vehicleReference: r.vehicle_reference || null,
      startAt: r.start_at,
      expectedReturnAt: r.expected_return_at,
      status: r.status || (r.booking_status ? r.booking_status.toLowerCase() : 'confirmed'),
      bookingStatus: r.booking_status || (r.status ? r.status.toUpperCase() : 'CONFIRMED'),
      paymentStatus: r.payment_status,
      rating: r.booking_rating !== null && r.booking_rating !== undefined ? parseInt(r.booking_rating, 10) : null,
      review: r.booking_rating !== null && r.booking_rating !== undefined ? {
        rating: parseInt(r.booking_rating, 10),
        comment: r.booking_review_comment || null,
      } : null,
      reviewComment: r.booking_review_comment || null,
      pickupLocation: r.pickup_location,
      customer: {
        id: r.customer_id,
        customerReference: r.customer_reference || null,
        name: r.customer_name,
        email: r.customer_email,
        phone: r.customer_phone,
        countryCode: r.customer_country_code,
      },
      partner: {
        id: r.partner_id,
        partnerReference: r.partner_reference || null,
        businessName: r.partner_name,
        city: r.partner_city,
        ownerName: r.partner_owner_name,
        ownerPhone: r.partner_owner_phone,
      },
      vehicle: {
        id: r.vehicle_id,
        vehicleReference: r.vehicle_reference || null,
        registrationNumber: r.vehicle_registration_number,
        brand: r.vehicle_brand,
        model: r.vehicle_model,
        variant: r.vehicle_variant,
        category: r.vehicle_category,
        fuelType: r.vehicle_fuel_type,
        transmission: r.vehicle_transmission,
        coverImageUrl: r.vehicle_cover_image_url || (vehicleImages[0]?.imageUrl) || null,
        primaryImage: r.vehicle_cover_image_url || (vehicleImages[0]?.imageUrl) || null,
        primaryImageUrl: r.vehicle_cover_image_url || (vehicleImages[0]?.imageUrl) || null,
        storageKey: r.vehicle_image_storage_key || (vehicleImages[0]?.storageKey) || null,
        images: vehicleImages,
      },
      coverImageUrl: r.vehicle_cover_image_url || (vehicleImages[0]?.imageUrl) || null,
      vehicleImage: r.vehicle_cover_image_url || (vehicleImages[0]?.imageUrl) || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Locks and retrieves a booking row for atomic transaction updates.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findBookingByIdForUpdate(bookingId, client) {
    if (mockBookingResolver && mockBookingResolver.findBookingByIdForUpdate) {
      return mockBookingResolver.findBookingByIdForUpdate(bookingId);
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}-[0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(bookingId).trim());
    const idCondition = isUuid ? 'id = $1' : '(booking_reference = $1 OR booking_number = $1)';

    const sql = `
      SELECT
        id,
        booking_reference,
        booking_number,
        customer_id,
        partner_id,
        vehicle_id,
        start_at,
        expected_return_at,
        status,
        booking_status,
        payment_status,
        created_at,
        updated_at
      FROM bookings
      WHERE ${idCondition}
      FOR UPDATE;
    `;

    const executor = this._getExecutor(client);
    const res = await executor(sql, [bookingId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      bookingReference: r.booking_reference || r.booking_number,
      bookingNumber: r.booking_reference || r.booking_number,
      customerId: r.customer_id,
      partnerId: r.partner_id,
      vehicleId: r.vehicle_id,
      startAt: r.start_at,
      expectedReturnAt: r.expected_return_at,
      status: r.status || (r.booking_status ? String(r.booking_status).toLowerCase() : 'pending'),
      bookingStatus: r.booking_status || (r.status ? String(r.status).toUpperCase() : 'PENDING'),
      paymentStatus: r.payment_status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Retrieves full operational and financial summaries for a booking.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getBookingSummaries(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingSummaries) {
      return mockBookingResolver.getBookingSummaries(bookingId);
    }

    const executor = this._getExecutor(client);

    const pricingSql = `
      SELECT
        base_amount,
        rental_amount,
        security_deposit,
        extra_km_charge,
        late_fee,
        discount_amount,
        taxes_amount,
        total_customer_amount,
        price_per_hour,
        currency
      FROM booking_pricing_snapshots
      WHERE booking_id = $1
      LIMIT 1;
    `;

    const pickupSql = `
      SELECT
        is_verified,
        verified_at,
        odometer_start,
        fuel_level_start,
        photos,
        notes
      FROM booking_pickup_verifications
      WHERE booking_id = $1
      LIMIT 1;
    `;

    const returnSql = `
      SELECT
        returned_at,
        odometer_end,
        fuel_level_end,
        late_minutes,
        late_fee,
        extra_km,
        extra_km_fee,
        return_status,
        total_distance,
        notes,
        photos
      FROM booking_return_verifications
      WHERE booking_id = $1
      LIMIT 1;
    `;

    const [prRes, pkRes, retRes] = await Promise.all([
      executor(pricingSql, [bookingId]),
      executor(pickupSql, [bookingId]),
      executor(returnSql, [bookingId]),
    ]);

    const prRow = prRes.rows[0] || {};
    const pkRow = pkRes.rows[0] || {};
    const retRow = retRes.rows[0] || {};

    return {
      pricing: prRes.rows[0] ? {
        baseAmount: parseFloat(prRow.base_amount || 0),
        rentalAmount: parseFloat(prRow.rental_amount || 0),
        securityDeposit: parseFloat(prRow.security_deposit || 0),
        extraKmCharge: parseFloat(prRow.extra_km_charge || 0),
        lateFee: parseFloat(prRow.late_fee || 0),
        discountAmount: parseFloat(prRow.discount_amount || 0),
        taxesAmount: parseFloat(prRow.taxes_amount || 0),
        totalCustomerAmount: parseFloat(prRow.total_customer_amount || 0),
        pricePerHour: parseFloat(prRow.price_per_hour || 0),
        currency: prRow.currency || 'INR',
      } : null,
      pickupVerification: pkRes.rows[0] ? {
        isVerified: pkRow.is_verified,
        verifiedAt: pkRow.verified_at,
        odometerStart: pkRow.odometer_start ? parseFloat(pkRow.odometer_start) : null,
        fuelLevelStart: pkRow.fuel_level_start,
        photos: pkRow.photos || [],
        notes: pkRow.notes,
      } : null,
      returnVerification: retRes.rows[0] ? {
        returnedAt: retRow.returned_at,
        odometerEnd: retRow.odometer_end ? parseFloat(retRow.odometer_end) : null,
        fuelLevelEnd: retRow.fuel_level_end,
        lateMinutes: retRow.late_minutes || 0,
        lateFee: parseFloat(retRow.late_fee || 0),
        extraKm: parseFloat(retRow.extra_km || 0),
        extraKmFee: parseFloat(retRow.extra_km_fee || 0),
        returnStatus: retRow.return_status,
        totalDistance: retRow.total_distance ? parseFloat(retRow.total_distance) : null,
        notes: retRow.notes,
        photos: retRow.photos || [],
      } : null,
    };
  }

  /**
   * Updates booking status atomically.
   *
   * @param {string} bookingId
   * @param {string} bookingStatus
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async updateBookingStatus(bookingId, bookingStatus, client) {
    if (mockBookingResolver && mockBookingResolver.updateBookingStatus) {
      return mockBookingResolver.updateBookingStatus(bookingId, bookingStatus);
    }

    const sql = `
      UPDATE bookings
      SET status = LOWER($2::text), booking_status = UPPER($2::text), updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;

    const executor = this._getExecutor(client);
    await executor(sql, [bookingId, bookingStatus]);
    return this.findBookingById(bookingId, client);
  }

  /**
   * Updates vehicle rental status atomically.
   *
   * @param {string} vehicleId
   * @param {string} rentalStatus
   * @param {import('pg').PoolClient} client
   * @returns {Promise<void>}
   */
  async updateVehicleRentalStatus(vehicleId, rentalStatus, client) {
    if (mockBookingResolver && mockBookingResolver.updateVehicleRentalStatus) {
      return mockBookingResolver.updateVehicleRentalStatus(vehicleId, rentalStatus);
    }

    if (!vehicleId) return;

    try {
      const sql = `
        UPDATE vehicles
        SET rental_status = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1;
      `;
      const executor = this._getExecutor(client);
      await executor(sql, [vehicleId, rentalStatus]);
    } catch (_) {
      // Non-fatal if rental_status column is optional or not present
    }
  }

  /**
   * Retrieves payments for a booking.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getBookingPayments(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingPayments) {
      return mockBookingResolver.getBookingPayments(bookingId);
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}-[0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(bookingId).trim());
    const whereCond = isUuid
      ? 'WHERE booking_id = $1'
      : 'WHERE (booking_id = $1 OR booking_id IN (SELECT id FROM bookings WHERE booking_reference = $1 OR booking_number = $1))';

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id,
        order_reference,
        booking_id,
        customer_id,
        payment_method AS provider,
        provider_order_id,
        provider_payment_id,
        amount,
        currency,
        status,
        created_at,
        updated_at
      FROM payments
      ${whereCond}
      ORDER BY created_at DESC, id DESC;
    `;

    const res = await executor(sql, [bookingId]);
    return res.rows.map((r) => ({
      id: r.id,
      orderReference: r.order_reference || null,
      bookingId: r.booking_id,
      customerId: r.customer_id,
      provider: r.provider || r.payment_method || null,
      providerOrderId: r.provider_order_id,
      providerPaymentId: r.provider_payment_id,
      amount: parseFloat(r.amount || 0),
      currency: r.currency,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Retrieves commission records for a booking.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async getBookingCommission(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingCommission) {
      return mockBookingResolver.getBookingCommission(bookingId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id,
        booking_id,
        partner_id,
        commission_type,
        commission_rate,
        commission_amount,
        gross_booking_amount,
        partner_payable_amount,
        status,
        created_at,
        updated_at
      FROM commission_records
      WHERE booking_id = $1
      LIMIT 1;
    `;

    const res = await executor(sql, [bookingId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      bookingId: r.booking_id,
      partnerId: r.partner_id,
      commissionType: r.commission_type,
      commissionRate: parseFloat(r.commission_rate || 0),
      commissionAmount: parseFloat(r.commission_amount || 0),
      grossBookingAmount: parseFloat(r.gross_booking_amount || 0),
      partnerPayableAmount: parseFloat(r.partner_payable_amount || 0),
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Retrieves settlement / earnings record for a booking.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async getBookingSettlement(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingSettlement) {
      return mockBookingResolver.getBookingSettlement(bookingId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id,
        partner_id,
        booking_id,
        wallet_transaction_id,
        gross_amount,
        partner_net_amount,
        settlement_status,
        settled_at,
        created_at,
        updated_at
      FROM earnings
      WHERE booking_id = $1
      LIMIT 1;
    `;

    const res = await executor(sql, [bookingId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      partnerId: r.partner_id,
      bookingId: r.booking_id,
      walletTransactionId: r.wallet_transaction_id,
      grossAmount: parseFloat(r.gross_amount || 0),
      partnerNetAmount: parseFloat(r.partner_net_amount || 0),
      settlementStatus: r.settlement_status,
      settledAt: r.settled_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Retrieves damage reports for a booking.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getBookingDamages(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingDamages) {
      return mockBookingResolver.getBookingDamages(bookingId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id,
        booking_id,
        vehicle_id,
        damage_type,
        description,
        estimated_amount,
        approved_amount,
        status,
        photos,
        created_at
      FROM damage_reports
      WHERE booking_id = $1
      ORDER BY created_at ASC;
    `;

    const res = await executor(sql, [bookingId]);
    return res.rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      vehicleId: r.vehicle_id,
      damageType: r.damage_type,
      description: r.description,
      estimatedAmount: parseFloat(r.estimated_amount || 0),
      approvedAmount: r.approved_amount ? parseFloat(r.approved_amount) : null,
      status: r.status,
      photos: r.photos || [],
      createdAt: r.created_at,
    }));
  }

  /**
   * Retrieves administrative audit actions taken on this booking.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getBookingAdminActions(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingAdminActions) {
      return mockBookingResolver.getBookingAdminActions(bookingId);
    }

    const executor = this._getExecutor(client);
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
        created_at
      FROM admin_actions
      WHERE target_resource = 'BOOKING' AND target_resource_id = $1
      ORDER BY created_at ASC;
    `;

    const res = await executor(sql, [bookingId]);
    return res.rows.map((r) => ({
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
  }

  /**
   * Retrieves status history for a booking.
   */
  async getBookingStatusHistory(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingStatusHistory) {
      return mockBookingResolver.getBookingStatusHistory(bookingId);
    }
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, booking_id, old_status, new_status, changed_by, reason, created_at
        FROM booking_status_history
        WHERE booking_id = $1
        ORDER BY created_at ASC;
      `;
      const res = await executor(sql, [bookingId]);
      return res.rows;
    } catch (_) {
      return [];
    }
  }

  /**
   * Retrieves customer details snapshot for a booking.
   */
  async getBookingCustomerDetails(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingCustomerDetails) {
      return mockBookingResolver.getBookingCustomerDetails(bookingId);
    }
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, booking_id, full_name, phone, alternate_phone, id_type, id_reference, created_at
        FROM booking_customer_details
        WHERE booking_id = $1
        LIMIT 1;
      `;
      const res = await executor(sql, [bookingId]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Retrieves pickup details for a booking.
   */
  async getBookingPickup(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingPickup) {
      return mockBookingResolver.getBookingPickup(bookingId);
    }
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, booking_id, scheduled_at, picked_up_at, pickup_location, handed_over_by, odometer_reading, fuel_level, notes, created_at, updated_at
        FROM booking_pickup
        WHERE booking_id = $1
        LIMIT 1;
      `;
      const res = await executor(sql, [bookingId]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Retrieves return details for a booking.
   */
  async getBookingReturn(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingReturn) {
      return mockBookingResolver.getBookingReturn(bookingId);
    }
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, booking_id, scheduled_at, returned_at, return_location, received_by, odometer_reading, damage_notes, notes, created_at, updated_at
        FROM booking_return
        WHERE booking_id = $1
        LIMIT 1;
      `;
      const res = await executor(sql, [bookingId]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Retrieves rental agreement for a booking.
   */
  async getBookingAgreement(bookingId, client = null) {
    if (mockBookingResolver && mockBookingResolver.getBookingAgreement) {
      return mockBookingResolver.getBookingAgreement(bookingId);
    }
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT id, booking_id, customer_id, partner_id, vehicle_id, agreement_number, agreement_version,
               rental_start_at, rental_end_at, rental_amount, security_deposit, extra_charges, discount_amount,
               tax_amount, total_amount, cancellation_terms_snapshot, rental_terms_snapshot, customer_accepted,
               accepted_at, partner_acknowledged, acknowledged_at, document_url, storage_path, status, created_at, updated_at
        FROM rental_agreements
        WHERE booking_id = $1
        LIMIT 1;
      `;
      const res = await executor(sql, [bookingId]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }
}

module.exports = new AdminBookingRepository();
