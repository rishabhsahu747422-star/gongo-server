'use strict';

const BaseRepository = require('../db/base.repository');

let mockVehicleResolver = null;

class AdminVehicleRepository extends BaseRepository {
  constructor() {
    super('vehicles', 'id');
  }

  /**
   * For unit testing: inject mock resolver
   * @param {object|null} resolver
   */
  static setMockVehicleResolver(resolver) {
    mockVehicleResolver = resolver;
  }

  static resetMockVehicleResolver() {
    mockVehicleResolver = null;
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
   * Lists vehicles with parameterized filtering, search, pagination, and sorting.
   *
   * @param {object} params
   * @param {string} [params.search]
   * @param {string} [params.partnerId]
   * @param {string} [params.category]
   * @param {string} [params.manualStatus]
   * @param {string} [params.rentalStatus]
   * @param {string} [params.verificationStatus]
   * @param {boolean} [params.isArchived=false]
   * @param {string} [params.city]
   * @param {Date} [params.startDate]
   * @param {Date} [params.endDate]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {string} [params.sortBy='created_at']
   * @param {string} [params.sortOrder='DESC']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ vehicles: object[], total: number }>}
   */
  async listVehicles({
    search = null,
    partnerId = null,
    shopId = null,
    category = null,
    manualStatus = null,
    rentalStatus = null,
    verificationStatus = null,
    isArchived = null,
    city = null,
    startDate = null,
    endDate = null,
    limit = 10,
    offset = 0,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  } = {}, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.listVehicles) {
      return mockVehicleResolver.listVehicles({
        search,
        partnerId,
        shopId,
        category,
        manualStatus,
        rentalStatus,
        verificationStatus,
        isArchived,
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

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(search.trim());

      if (isUuid) {
        conditions.push(`(
          v.registration_number ILIKE $${paramIdx} OR
          v.vehicle_reference ILIKE $${paramIdx} OR
          v.brand ILIKE $${paramIdx} OR
          v.model ILIKE $${paramIdx} OR
          p.business_name ILIKE $${paramIdx} OR
          v.id = $${paramIdx + 1} OR
          v.partner_id = $${paramIdx + 1}
        )`);
        values.push(pattern, search.trim());
        paramIdx += 2;
      } else {
        conditions.push(`(
          v.registration_number ILIKE $${paramIdx} OR
          v.vehicle_reference ILIKE $${paramIdx} OR
          v.brand ILIKE $${paramIdx} OR
          v.model ILIKE $${paramIdx} OR
          p.business_name ILIKE $${paramIdx}
        )`);
        values.push(pattern);
        paramIdx += 1;
      }
    }

    if (partnerId && typeof partnerId === 'string' && partnerId.trim()) {
      conditions.push(`v.partner_id = $${paramIdx}`);
      values.push(partnerId.trim());
      paramIdx += 1;
    }

    if (shopId && typeof shopId === 'string' && shopId.trim()) {
      conditions.push(`v.shop_id = $${paramIdx}`);
      values.push(shopId.trim());
      paramIdx += 1;
    }

    if (category && typeof category === 'string' && category.trim()) {
      const cleanCat = category.trim().toUpperCase();
      if (cleanCat === 'EV' || cleanCat === 'ELECTRIC' || cleanCat === 'EVS') {
        conditions.push(`(v.category ILIKE $${paramIdx} OR v.fuel_type ILIKE $${paramIdx + 1} OR v.fuel_type ILIKE $${paramIdx + 2})`);
        values.push('%ev%', 'ev%', 'electric%');
        paramIdx += 3;
      } else {
        conditions.push(`v.category ILIKE $${paramIdx}`);
        values.push(category.trim());
        paramIdx += 1;
      }
    }

    if (manualStatus && typeof manualStatus === 'string' && manualStatus.trim()) {
      conditions.push(`v.manual_status = $${paramIdx}`);
      values.push(manualStatus.trim().toUpperCase());
      paramIdx += 1;
    }

    if (rentalStatus && typeof rentalStatus === 'string' && rentalStatus.trim()) {
      conditions.push(`v.rental_status = $${paramIdx}`);
      values.push(rentalStatus.trim().toUpperCase());
      paramIdx += 1;
    }

    if (verificationStatus && typeof verificationStatus === 'string' && verificationStatus.trim()) {
      conditions.push(`v.verification_status = $${paramIdx}`);
      values.push(verificationStatus.trim().toUpperCase());
      paramIdx += 1;
    }

    if (typeof isArchived === 'boolean') {
      conditions.push(`v.is_archived = $${paramIdx}`);
      values.push(isArchived);
      paramIdx += 1;
    }

    if (city && typeof city === 'string' && city.trim()) {
      conditions.push(`p.city ILIKE $${paramIdx}`);
      values.push(`%${this._escapeLikeWildcards(city.trim())}%`);
      paramIdx += 1;
    }

    if (startDate instanceof Date) {
      conditions.push(`v.created_at >= $${paramIdx}`);
      values.push(startDate);
      paramIdx += 1;
    }

    if (endDate instanceof Date) {
      conditions.push(`v.created_at < $${paramIdx}`);
      values.push(endDate);
      paramIdx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const ALLOWED_SORT_COLS = {
      created_at: 'v.created_at',
      updated_at: 'v.updated_at',
      brand: 'v.brand',
      model: 'v.model',
      registration_number: 'v.registration_number',
      year: 'v.year',
    };
    const sortCol = ALLOWED_SORT_COLS[sortBy] || 'v.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    values.push(safeLimit, safeOffset);
    const limitIdx = paramIdx;
    const offsetIdx = paramIdx + 1;

    const sql = `
      SELECT
        v.id,
        v.vehicle_reference,
        v.partner_id,
        v.shop_id,
        v.category,
        v.brand,
        v.model,
        v.variant,
        v.registration_number,
        v.year,
        v.fuel_type,
        v.color,
        v.engine_capacity,
        v.current_odometer,
        v.helmet_included,
        v.manufacture_year,
        v.is_available,
        NULL::text AS transmission,
        NULL::int AS seats,
        v.vehicle_description AS description,
        v.manual_status,
        v.rental_status,
        v.verification_status,
        -- is_archived = permanent admin deactivation / partner archive; is_active = false with
        -- is_archived = false is a temporary admin block. Do not derive one from the other.
        COALESCE(v.is_archived, false) AS is_archived,
        COALESCE(v.is_active, true) AS is_active,
        COALESCE(NULLIF(v.offline_reason, ''), v.rejection_reason, '') AS offline_reason,
        v.created_at,
        v.updated_at,
        COALESCE(p.business_name, 'Mobility Partner') AS partner_name,
        COALESCE(p.city, 'Bengaluru') AS partner_city,
        COALESCE(s.shop_name, s.name, 'Central Hub') AS shop_name,
        COALESCE(img.image_url, img.storage_key, v.primary_image_url, '') AS cover_image_url,
        img.storage_key AS cover_storage_key,
        COALESCE(vp.price_per_day, vp.price, 0)::numeric AS price_per_day,
        COALESCE(vp.price_per_hour, 0)::numeric AS price_per_hour,
        COALESCE(vp.price_per_4_hours, 0)::numeric AS price_per_4_hours,
        COALESCE(vp.security_deposit, 0)::numeric AS security_deposit,
        COALESCE(vp.extra_km_charge, 0)::numeric AS extra_km_charge,
        COALESCE(b.booking_count, 0)::int AS booking_count,
        COALESCE(vr.rating_avg, v.rating_avg)::numeric AS rating,
        COALESCE(vr.rating_count, v.rating_count, 0)::int AS review_count,
        active_b.active_booking_id,
        active_b.active_booking_number,
        active_b.active_booking_status,
        active_b.active_booking_state,
        COUNT(*) OVER()::int AS full_count
      FROM vehicles v
      LEFT JOIN partners p ON p.id = v.partner_id
      LEFT JOIN shops s ON s.id = v.shop_id
      LEFT JOIN (
        SELECT DISTINCT ON (vehicle_id) vehicle_id, image_url, storage_key
        FROM vehicle_images
        WHERE is_active = true
        ORDER BY vehicle_id, is_cover DESC, sort_order ASC, created_at ASC
      ) img ON img.vehicle_id = v.id
      LEFT JOIN (
        SELECT DISTINCT ON (vehicle_id)
          vehicle_id,
          price_per_day,
          price_per_hour,
          price_per_4_hours,
          price,
          security_deposit,
          extra_km_charge,
          is_active
        FROM vehicle_pricing
        ORDER BY vehicle_id, is_active DESC, updated_at DESC, created_at DESC
      ) vp ON vp.vehicle_id = v.id
      LEFT JOIN (
        SELECT vehicle_id, COUNT(*)::int AS booking_count
        FROM bookings
        GROUP BY vehicle_id
      ) b ON b.vehicle_id = v.id
      LEFT JOIN (
        SELECT
          r.vehicle_id,
          ROUND(AVG(r.rating_score)::numeric, 1) AS rating_avg,
          COUNT(DISTINCT r.id)::int AS rating_count
        FROM ratings r
        JOIN bookings b ON b.id = r.booking_id
        WHERE r.target_type = 'VEHICLE'
          AND r.status = 'APPROVED'
          AND (
            UPPER(COALESCE(b.booking_status, '')) IN ('COMPLETED', 'CONFIRMED')
            OR LOWER(COALESCE(b.status, '')) IN ('completed', 'returned')
          )
        GROUP BY r.vehicle_id
      ) vr ON vr.vehicle_id = v.id
      LEFT JOIN LATERAL (
        SELECT
          id AS active_booking_id,
          booking_number AS active_booking_number,
          status AS active_booking_status,
          booking_status AS active_booking_state
        FROM bookings
        WHERE vehicle_id = v.id
          AND (UPPER(COALESCE(booking_status, '')) IN ('ACTIVE', 'CONFIRMED') OR LOWER(COALESCE(status, '')) IN ('in_progress', 'active', 'vehicle_picked', 'confirmed'))
        ORDER BY
          CASE WHEN UPPER(COALESCE(booking_status, '')) = 'ACTIVE' OR LOWER(COALESCE(status, '')) IN ('in_progress', 'active') THEN 1 ELSE 2 END,
          created_at DESC
        LIMIT 1
      ) active_b ON true
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}, v.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const res = await executor(sql, values);
    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;

    const vehicles = res.rows.map((r) => {
      const isManualOffline = String(r.manual_status || '').toUpperCase() === 'OFFLINE';
      const hasActive = !!r.active_booking_id;
      const isOngoing = hasActive && (r.active_booking_state === 'ACTIVE' || ['in_progress', 'active', 'vehicle_picked'].includes(String(r.active_booking_status).toLowerCase()));
      const isConfirmed = hasActive && !isOngoing && (r.active_booking_state === 'CONFIRMED' || String(r.active_booking_status).toLowerCase() === 'confirmed');

      let computedRentalStatus = r.rental_status;
      if (isManualOffline) {
        computedRentalStatus = 'BLOCKED';
      } else if (isOngoing) {
        computedRentalStatus = 'ACTIVE';
      } else if (isConfirmed) {
        computedRentalStatus = 'BOOKED';
      }

      return {
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
        description: r.description,
        manualStatus: r.manual_status,
        rentalStatus: computedRentalStatus,
        verificationStatus: r.verification_status,
        isArchived: r.is_archived,
        isActive: r.is_active !== false,
        isBlocked: r.is_active === false && r.is_archived !== true,
        offlineReason: r.offline_reason,
        partnerName: r.partner_name,
        partnerCity: r.partner_city,
        shopName: r.shop_name,
        coverImageUrl: r.cover_image_url,
        coverStorageKey: r.cover_storage_key || null,
        storageKey: r.cover_storage_key || null,
        pricePerDay: parseFloat(r.price_per_day || 0),
        pricePerHour: parseFloat(r.price_per_hour || 0),
        pricePer4Hours: parseFloat(r.price_per_4_hours || 0),
        securityDeposit: parseFloat(r.security_deposit || 0),
        extraKmCharge: parseFloat(r.extra_km_charge || 0),
        bookingCount: r.booking_count,
        rating: r.rating !== null && r.rating !== undefined ? parseFloat(r.rating) : null,
        reviewCount: r.review_count !== undefined ? parseInt(r.review_count, 10) : 0,
        color: r.color,
        engineCapacity: r.engine_capacity,
        currentOdometer: r.current_odometer,
        helmetIncluded: r.helmet_included,
        manufactureYear: r.manufacture_year || r.year,
        isAvailable: isManualOffline ? false : (hasActive ? false : r.is_available),
        isBooked: hasActive,
        activeBooking: hasActive ? {
          id: r.active_booking_id,
          bookingNumber: r.active_booking_number,
          status: r.active_booking_status,
          bookingStatus: r.active_booking_state,
          isOngoing,
        } : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });

    return { vehicles, total };
  }

  /**
   * Finds a vehicle by UUID with safe column projection and joined partner details.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findVehicleById(vehicleId, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.findVehicleById) {
      return mockVehicleResolver.findVehicleById(vehicleId);
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(vehicleId).trim());
    const idCond = isUuid ? 'v.id = $1' : 'v.vehicle_reference = $1';

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        v.id,
        v.vehicle_reference,
        v.partner_id,
        p.partner_reference,
        v.shop_id,
        v.category,
        v.brand,
        v.model,
        v.variant,
        v.registration_number,
        v.year,
        v.fuel_type,
        v.color,
        v.engine_capacity,
        v.current_odometer,
        v.helmet_included,
        v.manufacture_year,
        v.is_available,
        COALESCE(v.transmission, 'MANUAL') AS transmission,
        COALESCE(v.seats, 2) AS seats,
        COALESCE(v.description, v.vehicle_description, '') AS description,
        v.manual_status,
        v.rental_status,
        v.verification_status,
        -- is_archived = permanent admin deactivation / partner archive; is_active = false with
        -- is_archived = false is a temporary admin block. Do not derive one from the other.
        COALESCE(v.is_archived, false) AS is_archived,
        COALESCE(v.is_active, true) AS is_active,
        COALESCE(NULLIF(v.offline_reason, ''), v.rejection_reason, '') AS offline_reason,
        v.created_at,
        v.updated_at,
        p.business_name AS partner_name,
        p.city AS partner_city,
        u.name AS partner_owner_name,
        u.email AS partner_owner_email,
        u.phone AS partner_owner_phone,
        COALESCE(s.shop_name, s.name, 'Central Hub') AS shop_name,
        COALESCE(img.image_url, img.storage_key, v.primary_image_url, '') AS cover_image_url,
        img.storage_key AS cover_storage_key,
        img.is_cover AS cover_is_cover,
        COALESCE(vp.price_per_day, vp.price, 0)::numeric AS price_per_day,
        COALESCE(vp.price_per_hour, 0)::numeric AS price_per_hour,
        COALESCE(vp.price_per_4_hours, 0)::numeric AS price_per_4_hours,
        COALESCE(vp.security_deposit, 0)::numeric AS security_deposit,
        COALESCE(vp.extra_km_charge, 0)::numeric AS extra_km_charge,
        COALESCE(vp.currency, 'INR') AS currency,
        COALESCE(vr.rating_avg, v.rating_avg)::numeric AS rating,
        COALESCE(vr.rating_count, v.rating_count, 0)::int AS review_count
      FROM vehicles v
      LEFT JOIN partners p ON p.id = v.partner_id
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN shops s ON s.id = v.shop_id
      LEFT JOIN (
        SELECT DISTINCT ON (vehicle_id) vehicle_id, image_url, storage_key, is_cover
        FROM vehicle_images
        WHERE is_active = true
        ORDER BY vehicle_id, is_cover DESC, sort_order ASC, created_at ASC
      ) img ON img.vehicle_id = v.id
      LEFT JOIN (
        SELECT DISTINCT ON (vehicle_id)
          vehicle_id,
          price_per_day,
          price_per_hour,
          price_per_4_hours,
          price,
          security_deposit,
          extra_km_charge,
          currency,
          is_active
        FROM vehicle_pricing
        ORDER BY vehicle_id, is_active DESC, updated_at DESC, created_at DESC
      ) vp ON vp.vehicle_id = v.id
      LEFT JOIN (
        SELECT
          r.vehicle_id,
          ROUND(AVG(r.rating_score)::numeric, 1) AS rating_avg,
          COUNT(DISTINCT r.id)::int AS rating_count
        FROM ratings r
        JOIN bookings b ON b.id = r.booking_id
        WHERE r.target_type = 'VEHICLE'
          AND r.status = 'APPROVED'
          AND (
            UPPER(COALESCE(b.booking_status, '')) IN ('COMPLETED', 'CONFIRMED')
            OR LOWER(COALESCE(b.status, '')) IN ('completed', 'returned')
          )
        GROUP BY r.vehicle_id
      ) vr ON vr.vehicle_id = v.id
      WHERE ${idCond}
      LIMIT 1;
    `;

    const res = await executor(sql, [vehicleId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      vehicleReference: r.vehicle_reference || null,
      partnerId: r.partner_id,
      partnerReference: r.partner_reference || null,
      shopId: r.shop_id,
      shopName: r.shop_name,
      shop: {
        id: r.shop_id,
        name: r.shop_name,
      },
      category: r.category,
      brand: r.brand,
      model: r.model,
      variant: r.variant,
      registrationNumber: r.registration_number,
      year: r.year,
      fuelType: r.fuel_type,
      color: r.color,
      engineCapacity: r.engine_capacity,
      currentOdometer: r.current_odometer,
      helmetIncluded: r.helmet_included,
      manufactureYear: r.manufacture_year || r.year,
      isAvailable: r.is_available,
      transmission: r.transmission,
      seats: r.seats,
      description: r.description,
      manualStatus: r.manual_status,
      rentalStatus: r.rental_status,
      verificationStatus: r.verification_status,
      isArchived: r.is_archived,
      isActive: r.is_active !== false,
      isBlocked: r.is_active === false && r.is_archived !== true,
      offlineReason: r.offline_reason,
      coverImageUrl: r.cover_image_url,
      coverStorageKey: r.cover_storage_key || null,
      storageKey: r.cover_storage_key || null,
      pricePerDay: parseFloat(r.price_per_day || 0),
      pricePerHour: parseFloat(r.price_per_hour || 0),
      pricePer4Hours: parseFloat(r.price_per_4_hours || 0),
      securityDeposit: parseFloat(r.security_deposit || 0),
      extraKmCharge: parseFloat(r.extra_km_charge || 0),
      currency: r.currency || 'INR',
      rating: r.rating !== null && r.rating !== undefined ? parseFloat(r.rating) : null,
      reviewCount: r.review_count !== undefined ? parseInt(r.review_count, 10) : 0,
      partnerName: r.partner_name,
      partnerCity: r.partner_city,
      partner: {
        id: r.partner_id,
        name: r.partner_name,
        businessName: r.partner_name,
        city: r.partner_city,
        ownerName: r.partner_owner_name,
        ownerEmail: r.partner_owner_email,
        ownerPhone: r.partner_owner_phone,
      },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Retrieves operational summaries for a single vehicle (bookings, documents, images, pricing).
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getVehicleSummaries(vehicleId, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.getVehicleSummaries) {
      return mockVehicleResolver.getVehicleSummaries(vehicleId);
    }

    const executor = this._getExecutor(client);

    const bookingSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(booking_status, status, '')) IN ('UPCOMING', 'CONFIRMED', 'PICKUP_SCHEDULED', 'PENDING', 'PAYMENT_PENDING'))::int AS upcoming,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(booking_status, status, '')) IN ('ACTIVE', 'IN_PROGRESS', 'VEHICLE_PICKED'))::int AS active,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(booking_status, status, '')) IN ('COMPLETED', 'RETURNED'))::int AS completed,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(booking_status, status, '')) IN ('CANCELLED', 'REJECTED'))::int AS cancelled,
        COALESCE(SUM(COALESCE(total_amount, 0)) FILTER (WHERE UPPER(COALESCE(booking_status, status, '')) IN ('COMPLETED', 'RETURNED')), 0)::numeric AS revenue
      FROM bookings
      WHERE vehicle_id = $1;
    `;

    const docSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE verification_status = 'VERIFIED')::int AS verified,
        COUNT(*) FILTER (WHERE verification_status IN ('PENDING', 'UNDER_REVIEW'))::int AS pending,
        COUNT(*) FILTER (WHERE verification_status = 'REJECTED')::int AS rejected
      FROM vehicle_documents
      WHERE vehicle_id = $1;
    `;

    const imgSql = `
      SELECT COUNT(*)::int AS count
      FROM vehicle_images
      WHERE vehicle_id = $1 AND is_active = true;
    `;

    const pricingSql = `
      SELECT
        price_per_hour,
        price_per_4_hours,
        price_per_day,
        price,
        security_deposit,
        extra_km_charge,
        currency,
        is_active
      FROM vehicle_pricing
      WHERE vehicle_id = $1
      ORDER BY is_active DESC, updated_at DESC, created_at DESC
      LIMIT 1;
    `;

    const availSql = `
      SELECT COUNT(*)::int AS active_blocks
      FROM vehicle_availability_blocks
      WHERE vehicle_id = $1 AND is_active = true AND end_time > CURRENT_TIMESTAMP;
    `;

    const bRes = await executor(bookingSql, [vehicleId]);
    const dRes = await executor(docSql, [vehicleId]);
    const iRes = await executor(imgSql, [vehicleId]);
    const pRes = await executor(pricingSql, [vehicleId]);
    const aRes = await executor(availSql, [vehicleId]);

    const bRow = bRes.rows[0] || {};
    const dRow = dRes.rows[0] || {};
    const iRow = iRes.rows[0] || {};
    const pRow = pRes.rows[0] || {};
    const aRow = aRes.rows[0] || {};

    return {
      bookingSummary: {
        total: bRow.total || 0,
        upcoming: bRow.upcoming || 0,
        active: bRow.active || 0,
        completed: bRow.completed || 0,
        cancelled: bRow.cancelled || 0,
        revenue: parseFloat(bRow.revenue || 0),
      },
      documentsSummary: {
        total: dRow.total || 0,
        verified: dRow.verified || 0,
        pending: dRow.pending || 0,
        rejected: dRow.rejected || 0,
      },
      imagesCount: iRow.count || 0,
      pricing: pRow && (pRow.price_per_day != null || pRow.price_per_hour != null || pRow.price != null) ? {
        pricePerHour: parseFloat(pRow.price_per_hour || 0),
        pricePer4Hours: parseFloat(pRow.price_per_4_hours || 0),
        pricePerDay: parseFloat(pRow.price_per_day ?? pRow.price ?? 0),
        securityDeposit: parseFloat(pRow.security_deposit || 0),
        extraKmCharge: parseFloat(pRow.extra_km_charge || 0),
        currency: pRow.currency || 'INR',
        isActive: pRow.is_active !== undefined ? Boolean(pRow.is_active) : true,
      } : null,
      availability: {
        activeBlocksCount: aRow.active_blocks || 0,
      },
    };
  }

  /**
   * Counts active bookings currently associated with this vehicle.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async getActiveBookingCount(vehicleId, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.getActiveBookingCount) {
      return mockVehicleResolver.getActiveBookingCount(vehicleId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT COUNT(*)::int AS count
      FROM bookings
      WHERE vehicle_id = $1
        AND booking_status IN ('UPCOMING', 'ACTIVE', 'CONFIRMED');
    `;
    const res = await executor(sql, [vehicleId]);
    return res.rows[0] ? res.rows[0].count : 0;
  }

  /**
   * Retrieves vehicle row with row-level lock (FOR UPDATE) for concurrent safety.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findVehicleByIdForUpdate(vehicleId, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.findVehicleByIdForUpdate) {
      return mockVehicleResolver.findVehicleByIdForUpdate(vehicleId, client);
    }

    if (!client || typeof client.query !== 'function') {
      return this.findVehicleById(vehicleId, client);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id, partner_id, shop_id, category, brand, model,
        registration_number, manual_status, rental_status,
        verification_status,
        COALESCE(is_archived, false) AS is_archived,
        COALESCE(is_active, true) AS is_active,
        COALESCE(NULLIF(offline_reason, ''), rejection_reason) AS offline_reason
      FROM vehicles
      WHERE id = $1
      FOR UPDATE;
    `;
    const res = await executor(sql, [vehicleId]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      partnerId: r.partner_id,
      shopId: r.shop_id,
      category: r.category,
      brand: r.brand,
      model: r.model,
      registrationNumber: r.registration_number,
      manualStatus: r.manual_status,
      rentalStatus: r.rental_status,
      verificationStatus: r.verification_status,
      isArchived: r.is_archived,
      isActive: r.is_active !== false,
      offlineReason: r.offline_reason,
    };
  }

  /**
   * Updates vehicle status fields (manual_status, offline_reason, is_archived) atomically.
   *
   * @param {string} vehicleId
   * @param {object} updates
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async updateVehicleStatus(vehicleId, updates, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.updateVehicleStatus) {
      return mockVehicleResolver.updateVehicleStatus(vehicleId, updates);
    }

    const executor = this._getExecutor(client);
    const setParts = ['updated_at = CURRENT_TIMESTAMP'];
    const values = [vehicleId];
    let idx = 2;

    if (updates.manualStatus !== undefined) {
      setParts.push(`manual_status = $${idx}`);
      values.push(updates.manualStatus);
      idx += 1;

      if (updates.manualStatus === 'OFFLINE') {
        setParts.push('is_available = false');
      } else if (updates.manualStatus === 'ONLINE') {
        setParts.push('is_available = true');
      }
    }

    if (updates.offlineReason !== undefined) {
      // offline_reason is the operational column (also written by the Partner toggle).
      // rejection_reason belongs to verification rejection and must not be overwritten here.
      setParts.push(`offline_reason = $${idx}`);
      values.push(updates.offlineReason);
      idx += 1;
    }

    // is_active defaults to !isArchived, but callers may set it explicitly: an admin BLOCK is
    // is_active = false with is_archived = false (temporary hold; Partner AD-2 refuses ONLINE).
    let isActiveValue;
    if (updates.isActive !== undefined) {
      isActiveValue = Boolean(updates.isActive);
    } else if (updates.isArchived !== undefined) {
      isActiveValue = !updates.isArchived;
    }
    if (isActiveValue !== undefined) {
      setParts.push(`is_active = $${idx}`);
      values.push(isActiveValue);
      idx += 1;
    }

    if (updates.isArchived !== undefined) {
      // is_archived is the flag the Partner online toggle and Customer booking checks
      // enforce (AD-2); is_active alone does not stop a partner re-listing the vehicle.
      setParts.push(`is_archived = $${idx}`);
      values.push(Boolean(updates.isArchived));
      idx += 1;
    }

    const sql = `
      UPDATE vehicles
      SET ${setParts.join(', ')}
      WHERE id = $1
      RETURNING *;
    `;

    await executor(sql, values);
    return this.findVehicleById(vehicleId, client);
  }

  /**
   * Updates vehicle verification status atomically.
   *
   * @param {string} vehicleId
   * @param {string} verificationStatus
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async updateVehicleVerification(vehicleId, verificationStatus, client = null, rejectionReason = null) {
    if (mockVehicleResolver && mockVehicleResolver.updateVehicleVerification) {
      return mockVehicleResolver.updateVehicleVerification(vehicleId, verificationStatus);
    }

    const executor = this._getExecutor(client);
    let sql;
    let params;
    if (verificationStatus === 'REJECTED') {
      sql = `
        UPDATE vehicles
        SET verification_status = $2, rejection_reason = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
      params = [vehicleId, verificationStatus, rejectionReason];
    } else if (verificationStatus === 'PENDING') {
      sql = `
        UPDATE vehicles
        SET verification_status = $2, rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
      params = [vehicleId, verificationStatus];
    } else {
      sql = `UPDATE vehicles
      SET verification_status = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;`;
      params = [vehicleId, verificationStatus];
    }

    await executor(sql, params);
    return this.findVehicleById(vehicleId, client);
  }

  /**
   * Retrieves vehicle documents with safe metadata.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getVehicleDocuments(vehicleId, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.getVehicleDocuments) {
      return mockVehicleResolver.getVehicleDocuments(vehicleId);
    }

    const executor = this._getExecutor(client);
    const sql = `
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

    const res = await executor(sql, [vehicleId]);
    return res.rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
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
    }));
  }

  /**
   * Find vehicle document by ID and vehicle ID to enforce server-side ownership validation.
   *
   * @param {string} documentId
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findVehicleDocumentById(documentId, vehicleId, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.findVehicleDocumentById) {
      return mockVehicleResolver.findVehicleDocumentById(documentId, vehicleId);
    }

    const executor = this._getExecutor(client);
    const sql = `
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
      WHERE id = $1 AND vehicle_id = $2
      LIMIT 1;
    `;

    const res = await executor(sql, [documentId, vehicleId]);
    if (!res.rows || res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
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
    };
  }

  /**
   * Retrieves active images for a vehicle.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getVehicleImages(vehicleId, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.getVehicleImages) {
      return mockVehicleResolver.getVehicleImages(vehicleId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id,
        vehicle_id,
        storage_key,
        image_url,
        sort_order,
        is_cover,
        is_active,
        created_at,
        updated_at
      FROM vehicle_images
      WHERE vehicle_id = $1 AND is_active = true
      ORDER BY is_cover DESC, sort_order ASC, created_at ASC;
    `;

    const res = await executor(sql, [vehicleId]);
    return res.rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
      storageKey: r.storage_key,
      imageUrl: r.image_url,
      sortOrder: r.sort_order,
      isCover: r.is_cover,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Retrieves bookings for a vehicle with pagination and filters.
   *
   * @param {string} vehicleId
   * @param {object} params
   * @param {string} [params.status]
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ bookings: object[], total: number }>}
   */
  async getVehicleBookings(
    vehicleId,
    { status = null, limit = 10, offset = 0 } = {},
    client = null,
  ) {
    if (mockVehicleResolver && mockVehicleResolver.getVehicleBookings) {
      return mockVehicleResolver.getVehicleBookings(vehicleId, { status, limit, offset });
    }

    const executor = this._getExecutor(client);
    const conditions = ['b.vehicle_id = $1'];
    const values = [vehicleId];
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
        b.booking_number,
        b.customer_id,
        b.partner_id,
        b.shop_id,
        b.vehicle_id,
        b.start_at,
        b.expected_return_at,
        b.end_at,
        b.status,
        b.booking_status,
        b.payment_status,
        b.pickup_location,
        COALESCE(b.total_amount, 0)::numeric AS total_amount,
        b.created_at,
        b.updated_at,
        COALESCE(u.name, b.customer_name, 'Customer') AS customer_name,
        COALESCE(u.phone, b.customer_phone, '—') AS customer_phone,
        COALESCE(u.email, '') AS customer_email,
        COALESCE(p.business_name, 'Partner') AS partner_name,
        COALESCE(s.shop_name, s.name, 'Shop') AS shop_name,
        v.brand AS vehicle_brand,
        v.model AS vehicle_model,
        v.registration_number AS vehicle_registration_number,
        COALESCE(img.image_url, img.storage_key, v.primary_image_url, '') AS vehicle_cover_image_url,
        img.storage_key AS vehicle_image_storage_key,
        br.rating AS rating,
        br.review_comment AS review_comment,
        COUNT(*) OVER()::int AS full_count
      FROM bookings b
      LEFT JOIN users u ON u.id = b.customer_id
      LEFT JOIN partners p ON p.id = b.partner_id
      LEFT JOIN shops s ON s.id = b.shop_id
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
      bookingNumber: r.booking_number,
      customerId: r.customer_id,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      customer: {
        id: r.customer_id,
        name: r.customer_name,
        phone: r.customer_phone,
        email: r.customer_email,
      },
      partnerId: r.partner_id,
      partnerName: r.partner_name,
      partner: {
        id: r.partner_id,
        name: r.partner_name,
        businessName: r.partner_name,
      },
      shopId: r.shop_id,
      shopName: r.shop_name,
      shop: {
        id: r.shop_id,
        name: r.shop_name,
      },
      vehicleId: r.vehicle_id,
      vehicle: {
        id: r.vehicle_id,
        brand: r.vehicle_brand,
        model: r.vehicle_model,
        registrationNumber: r.vehicle_registration_number,
        coverImageUrl: r.vehicle_cover_image_url || null,
        storageKey: r.vehicle_image_storage_key || null,
        primaryImage: r.vehicle_cover_image_url || null,
        primaryImageUrl: r.vehicle_cover_image_url || null,
      },
      coverImageUrl: r.vehicle_cover_image_url || null,
      storageKey: r.vehicle_image_storage_key || null,
      vehicleImage: r.vehicle_cover_image_url || null,
      startAt: r.start_at,
      expectedReturnAt: r.expected_return_at,
      pickupDate: r.start_at,
      returnDate: r.expected_return_at || r.end_at,
      bookingStatus: (r.booking_status || r.status || 'CONFIRMED').toLowerCase(),
      status: r.status,
      paymentStatus: (r.payment_status || 'pending').toLowerCase(),
      pickupLocation: r.pickup_location,
      amount: parseFloat(r.total_amount || 0),
      totalAmount: parseFloat(r.total_amount || 0),
      rating: r.rating !== null && r.rating !== undefined ? Number(r.rating) : null,
      reviewComment: r.review_comment || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return { bookings, total };
  }

  /**
   * Retrieves active availability blocks for a vehicle.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async getVehicleAvailability(vehicleId, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.getVehicleAvailability) {
      return mockVehicleResolver.getVehicleAvailability(vehicleId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id,
        vehicle_id,
        start_time,
        end_time,
        reason,
        is_active,
        created_at,
        updated_at
      FROM vehicle_availability_blocks
      WHERE vehicle_id = $1 AND is_active = true
      ORDER BY start_time ASC;
    `;

    const res = await executor(sql, [vehicleId]);
    return res.rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
      startTime: r.start_time,
      endTime: r.end_time,
      reason: r.reason,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Retrieves vehicle pricing config.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async getVehiclePricing(vehicleId, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.getVehiclePricing) {
      return mockVehicleResolver.getVehiclePricing(vehicleId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        id,
        vehicle_id,
        price_per_hour,
        price_per_4_hours,
        price_per_day,
        price,
        security_deposit,
        extra_km_charge,
        currency,
        is_active,
        created_at,
        updated_at
      FROM vehicle_pricing
      WHERE vehicle_id = $1
      ORDER BY is_active DESC, updated_at DESC, created_at DESC
      LIMIT 1;
    `;

    const res = await executor(sql, [vehicleId]);
    if (!res.rows[0]) return null;

    const r = res.rows[0];
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      pricePerHour: parseFloat(r.price_per_hour || 0),
      pricePer4Hours: parseFloat(r.price_per_4_hours || 0),
      pricePerDay: parseFloat(r.price_per_day ?? r.price ?? 0),
      securityDeposit: parseFloat(r.security_deposit || 0),
      extraKmCharge: parseFloat(r.extra_km_charge || 0),
      currency: r.currency,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Retrieves financial / earnings summary for a vehicle.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getVehicleEarnings(vehicleId, client = null) {
    if (mockVehicleResolver && mockVehicleResolver.getVehicleEarnings) {
      return mockVehicleResolver.getVehicleEarnings(vehicleId);
    }

    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        COUNT(p.id)::int AS total_payments,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'SUCCESS'), 0)::numeric AS gross_revenue,
        COUNT(p.id) FILTER (WHERE p.status = 'SUCCESS')::int AS successful_bookings,
        COUNT(p.id) FILTER (WHERE p.status = 'REFUNDED')::int AS refunded_bookings
      FROM payments p
      JOIN bookings b ON b.id = p.booking_id
      WHERE b.vehicle_id = $1;
    `;

    const res = await executor(sql, [vehicleId]);
    const r = res.rows[0] || {};
    return {
      totalPayments: r.total_payments || 0,
      grossRevenue: parseFloat(r.gross_revenue || 0),
      successfulBookings: r.successful_bookings || 0,
      refundedBookings: r.refunded_bookings || 0,
    };
  }

  /**
   * Retrieves administrative audit actions taken on this vehicle.
   *
   * @param {string} vehicleId
   * @param {object} params
   * @param {number} [params.limit=10]
   * @param {number} [params.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ history: object[], total: number }>}
   */
  async getVehicleHistory(
    vehicleId,
    { limit = 10, offset = 0 } = {},
    client = null,
  ) {
    if (mockVehicleResolver && mockVehicleResolver.getVehicleHistory) {
      return mockVehicleResolver.getVehicleHistory(vehicleId, { limit, offset });
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
      WHERE target_resource = 'VEHICLE' AND target_resource_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3;
    `;

    const res = await executor(sql, [vehicleId, safeLimit, safeOffset]);
    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;

    const history = res.rows.map((r) => ({
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

    return { history, total };
  }
}

module.exports = new AdminVehicleRepository();
