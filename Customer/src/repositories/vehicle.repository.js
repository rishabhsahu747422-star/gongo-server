'use strict';

const BaseRepository = require('./base.repository');
const {
  SORT_CLAUSES,
  SORT_OPTIONS,
  PARTNER_ELIGIBLE_STATUSES,
  VEHICLE_STATUS,
} = require('../constants/vehicle');

/**
 * VehicleRepository — all vehicle discovery SQL queries.
 * Fully integrated with authoritative Supabase schema:
 *   vehicles, vehicle_models, vehicle_brands, vehicle_categories, vehicle_pricing, vehicle_images, shops, partners, cities.
 *
 * All parameters bound, no registration_number exposed, storage keys protected.
 */
class VehicleRepository extends BaseRepository {
  /**
   * Maps a vehicle row to the public customer-safe vehicle summary shape.
   *
   * @param {object} row
   * @returns {object}
   */
  static mapVehicleSummary(row) {
    if (!row) return null;
    return {
      id: row.id,
      vehicleReference: row.vehicle_reference || null,
      vehicleName: row.vehicle_name,
      brand: row.brand,
      model: row.model,
      year: row.year !== undefined && row.year !== null ? Number(row.year) : null,
      category: row.category_slug || null,
      categoryName: row.category_name || null,
      vehicleSubtype: row.vehicle_subtype || null,
      fuelType: row.fuel_type || 'PETROL',
      transmission: row.transmission || 'MANUAL',
      engineCapacityCc: row.engine_capacity_cc !== null && row.engine_capacity_cc !== undefined ? Number(row.engine_capacity_cc) : null,
      color: row.color || null,
      seats: row.seats !== undefined && row.seats !== null ? Number(row.seats) : 2,
      mileageKmpl: row.mileage_kmpl !== null && row.mileage_kmpl !== undefined ? Number(row.mileage_kmpl) : null,
      pricePerHour: row.price_per_hour !== null && row.price_per_hour !== undefined ? Number(row.price_per_hour) : null,
      pricePerDay: row.price_per_day !== null && row.price_per_day !== undefined ? Number(row.price_per_day) : null,
      pricePerWeek: row.price_per_week !== null && row.price_per_week !== undefined ? Number(row.price_per_week) : null,
      pricePerMonth: row.price_per_month !== null && row.price_per_month !== undefined ? Number(row.price_per_month) : null,
      securityDeposit: Number(row.security_deposit || 0),
      lateFeePerHour: Number(row.late_fee_per_hour || 0),
      extraKmCharge: Number(row.extra_km_charge || 0),
      city: row.city_name || null,
      cityState: row.city_state || null,
      pickupAddress: row.pickup_address || null,
      latitude: row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : null,
      longitude: row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : null,
      ratingAvg: Number(row.rating_avg || 5.0),
      ratingCount: Number(row.rating_count || 0),
      isAvailable: row.is_available !== undefined && row.is_available !== null ? Boolean(row.is_available) : true,
      listingStatus: row.listing_status || 'ACTIVE',
      verificationStatus: row.verification_status || 'PENDING',
      isVerified: Boolean(row.is_verified || (row.verification_status && ['VERIFIED', 'APPROVED', 'verified', 'approved'].includes(row.verification_status))),
      isGongoVerified: Boolean(row.is_verified || (row.verification_status && ['VERIFIED', 'APPROVED', 'verified', 'approved'].includes(row.verification_status))),
      shopName: row.shop_name || null,
      primaryImageUrl: row.primary_image_url || null,
      createdAt: row.created_at,
      ...(row.distance_km !== undefined ? { distanceKm: Number(row.distance_km) } : {}),
    };
  }

  /**
   * Maps a vehicle row to the full public customer-safe detail shape.
   *
   * @param {object} row
   * @param {Array<object>} images
   * @returns {object}
   */
  static mapVehicleDetail(row, images = []) {
    const summary = VehicleRepository.mapVehicleSummary(row);
    return {
      ...summary,
      description: row.description || null,
      images: images.map((img) => ({
        id: img.id,
        displayOrder: Number(img.display_order || 0),
        isPrimary: Boolean(img.is_primary),
        imageUrl: img.imageUrl || img.file_url || null,
      })),
    };
  }

  /**
   * Base eligibility JOIN fragment reused across all discovery queries.
   * Joins normalized Supabase tables: shops, partners, vehicle_models, vehicle_brands, vehicle_categories, cities, vehicle_pricing.
   *
   * @returns {string}
   */
  static eligibilityJoins() {
    return `
      JOIN shops sh ON sh.id = v.shop_id AND sh.is_active = true
      JOIN partners p ON p.id = sh.partner_id
        AND (
          p.verification_status = ANY($1::text[])
          OR p.verification_status IN ('verified', 'approved', 'VERIFIED', 'APPROVED')
          OR p.kyc_status IN ('verified', 'approved', 'VERIFIED', 'APPROVED')
        )
        AND p.is_active = true
        AND (p.status IS NULL OR LOWER(p.status) NOT IN ('suspended', 'deactivated', 'rejected'))
        AND (p.partner_status IS NULL OR UPPER(p.partner_status) != 'SUSPENDED')
      LEFT JOIN vehicle_models vm ON vm.id = v.model_id
      LEFT JOIN vehicle_brands vb ON vb.id = vm.brand_id
      LEFT JOIN vehicle_categories vc ON (vc.id = vm.category_id OR vc.code = UPPER(v.category) OR UPPER(vc.name) = UPPER(v.category))
      LEFT JOIN cities c ON c.id = sh.city_id
      LEFT JOIN vehicle_pricing vp ON (vp.vehicle_id = v.id AND vp.is_active = true)
    `;
  }

  /**
   * Base SELECT fragment for public vehicle list view.
   * NEVER selects registration_number.
   *
   * @returns {string}
   */
  static summarySelect() {
    return `
      v.id,
      v.vehicle_reference,
      COALESCE(CONCAT(v.brand, ' ', v.model), v.vehicle_description, 'GONGO Vehicle') AS vehicle_name,
      COALESCE(vb.name, v.brand, 'GONGO') AS brand,
      COALESCE(vm.name, v.model, 'Model') AS model,
      COALESCE(v.manufacture_year, v.year) AS year,
      COALESCE(vc.code, UPPER(v.category), 'BIKE') AS category_slug,
      COALESCE(vc.name, v.category, 'Bike') AS category_name,
      v.variant AS vehicle_subtype,
      COALESCE(v.fuel_type, 'PETROL') AS fuel_type,
      COALESCE(v.transmission, 'MANUAL') AS transmission,
      v.engine_capacity AS engine_capacity_cc,
      v.color,
      COALESCE(v.seats, CASE WHEN LOWER(v.category) = 'car' THEN 5 ELSE 2 END) AS seats,
      NULL::numeric AS mileage_kmpl,
      COALESCE(vp.price_per_hour, (vp.price / 10.0))::numeric AS price_per_hour,
      COALESCE(vp.price_per_day, vp.price, 500)::numeric AS price_per_day,
      NULL::numeric AS price_per_week,
      NULL::numeric AS price_per_month,
      COALESCE(vp.security_deposit, 1000)::numeric AS security_deposit,
      50::numeric AS late_fee_per_hour,
      COALESCE(vp.extra_km_charge, 10)::numeric AS extra_km_charge,
      COALESCE(c.name, sh.city) AS city_name,
      COALESCE(sh.city, c.name) AS city_state,
      COALESCE(sh.address_line1, sh.shop_address, v.pickup_location) AS pickup_address,
      COALESCE(sh.latitude, 23.2599) AS latitude,
      COALESCE(sh.longitude, 77.4126) AS longitude,
      COALESCE(v.description, v.vehicle_description) AS description,
      COALESCE(p.rating, 5.0) AS rating_avg,
      COALESCE(p.review_count, 0) AS rating_count,
      COALESCE(v.is_available, true) AS is_available,
      CASE
        WHEN v.is_available IS FALSE THEN 'UNAVAILABLE'
        WHEN (v.status = 'active' OR v.status = 'pending' OR v.verification_status IN ('VERIFIED', 'APPROVED', 'verified', 'approved')) THEN 'ACTIVE'
        ELSE UPPER(COALESCE(v.status, 'ACTIVE'))
      END AS listing_status,
      COALESCE(v.verification_status, 'PENDING') AS verification_status,
      (v.verification_status IN ('VERIFIED', 'APPROVED', 'verified', 'approved')) AS is_verified,
      COALESCE(sh.name, sh.shop_name) AS shop_name,
      v.created_at,
      COALESCE(v.primary_image_url, (
        SELECT COALESCE(vi.file_url, vi.image_url, vi.storage_key)
        FROM vehicle_images vi
        WHERE vi.vehicle_id = v.id AND (vi.is_active = true OR vi.is_active IS NULL)
        ORDER BY COALESCE(vi.is_cover, false) DESC, vi.is_primary DESC, COALESCE(vi.sort_order, vi.display_order, 0) ASC
        LIMIT 1
      )) AS primary_image_url
    `;
  }

  static legacyEligibilityJoins() {
    return `
      JOIN shops sh ON sh.id = v.shop_id AND sh.is_active = true
      JOIN partners p ON p.id = sh.partner_id
        AND (p.verification_status = ANY($1::text[]) OR p.verification_status IN ('verified', 'approved'))
        AND p.is_active = true
      JOIN vehicle_categories vc ON (vc.id = v.category_id)
      LEFT JOIN cities c ON (c.id = v.city_id)
    `;
  }

  static legacySummarySelect() {
    return `
      v.id,
      v.vehicle_name,
      v.brand,
      v.model,
      v.year,
      vc.slug AS category_slug,
      vc.name AS category_name,
      v.vehicle_subtype,
      v.fuel_type,
      v.transmission,
      v.engine_capacity_cc,
      v.color,
      v.seats,
      v.mileage_kmpl,
      v.price_per_hour,
      v.price_per_day,
      v.price_per_week,
      v.price_per_month,
      v.security_deposit,
      v.late_fee_per_hour,
      v.extra_km_charge,
      c.name AS city_name,
      c.state AS city_state,
      v.pickup_address,
      v.latitude,
      v.longitude,
      v.rating_avg,
      v.rating_count,
      v.listing_status,
      'VERIFIED' AS verification_status,
      true AS is_verified,
      sh.shop_name,
      v.created_at,
      NULL::text AS primary_image_url
    `;
  }

  /**
   * Search vehicles with dynamic filters and safe sort.
   *
   * @param {object} filters
   * @returns {Promise<{rows: object[], total: number}>}
   */
  async searchVehicles(filters) {
    const {
      eligibleStatuses = PARTNER_ELIGIBLE_STATUSES,
      categorySlug,
      brand,
      shopId,
      cityId,
      fuelType,
      transmission,
      minPrice,
      maxPrice,
      minRating,
      sort = SORT_OPTIONS.RELEVANCE,
      page = 1,
      limit = 20,
      startAt,
      endAt,
    } = filters;

    const params = [eligibleStatuses];
    let paramIdx = 2;

    const conditions = [
      "(v.is_archived IS NOT TRUE)",
      // Admin block/deactivate hold (vehicles.is_active = false). NULL is treated as active.
      "(v.is_active IS NOT FALSE)",
      "(v.manual_status IS NULL OR UPPER(v.manual_status) != 'OFFLINE')",
      "(v.verification_status IN ('VERIFIED', 'APPROVED', 'verified', 'approved', 'PENDING', 'pending') OR v.status IN ('active', 'pending'))",
      "(v.verification_status IS NULL OR UPPER(v.verification_status) NOT IN ('REJECTED', 'SUSPENDED'))",
      "(v.status NOT IN ('inactive', 'rejected', 'suspended', 'INACTIVE', 'REJECTED', 'SUSPENDED'))",
    ];

    if (startAt && endAt) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM bookings b
        WHERE b.vehicle_id = v.id
          AND b.start_at < $${paramIdx + 1}::timestamptz
          AND (b.end_at + interval '1 hour') > $${paramIdx}::timestamptz
          AND b.status NOT IN ('cancelled', 'refunded', 'completed', 'returned', 'CANCELLED', 'REFUNDED', 'COMPLETED', 'RETURNED')
          AND (b.booking_status IS NULL OR b.booking_status NOT IN ('CANCELLED', 'REFUNDED', 'COMPLETED', 'RETURNED', 'cancelled', 'refunded', 'completed', 'returned'))
      )`);
      params.push(startAt);
      params.push(endAt);
      paramIdx += 2;
    }

    if (categorySlug) {
      const normCat = categorySlug.toLowerCase();
      if (normCat === 'bike' || normCat === 'motorcycle' || normCat === 'two_wheeler') {
        conditions.push(`(
          vc.code IN ('BIKE', 'MOTORCYCLE', 'SCOOTER', 'SCOOTY') 
          OR LOWER(v.category) IN ('bike', 'motorcycle', 'scooter', 'scooty')
        )`);
      } else if (normCat === 'car' || normCat === 'four_wheeler') {
        conditions.push(`(
          vc.code = 'CAR' 
          OR LOWER(v.category) = 'car'
        )`);
      } else if (normCat === 'scooter' || normCat === 'scooty') {
        conditions.push(`(
          vc.code = 'SCOOTY' 
          OR LOWER(v.category) IN ('scooter', 'scooty')
        )`);
      } else if (normCat === 'ev' || normCat === 'electric') {
        conditions.push(`(
          vc.code = 'EV' 
          OR LOWER(v.category) = 'ev'
          OR LOWER(v.fuel_type) = 'electric'
        )`);
      } else {
        conditions.push(`(vc.code = UPPER($${paramIdx}) OR LOWER(v.category) = LOWER($${paramIdx}))`);
        params.push(categorySlug);
        paramIdx += 1;
      }
    }

    if (brand) {
      conditions.push(`(LOWER(v.brand) = LOWER($${paramIdx}) OR LOWER(vb.name) = LOWER($${paramIdx}))`);
      params.push(brand);
      paramIdx += 1;
    }

    if (shopId) {
      conditions.push(`v.shop_id = $${paramIdx}`);
      params.push(shopId);
      paramIdx += 1;
    }

    if (cityId) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(cityId));
      if (isUuid) {
        conditions.push(`(sh.city_id = $${paramIdx} OR c.id = $${paramIdx})`);
      } else {
        conditions.push(`(LOWER(sh.city) = LOWER($${paramIdx}) OR LOWER(c.name) = LOWER($${paramIdx}))`);
      }
      params.push(cityId);
      paramIdx += 1;
    }

    if (fuelType) {
      conditions.push(`v.fuel_type = $${paramIdx}`);
      params.push(fuelType);
      paramIdx += 1;
    }

    if (transmission) {
      conditions.push(`v.transmission = $${paramIdx}`);
      params.push(transmission);
      paramIdx += 1;
    }

    if (minPrice !== undefined) {
      conditions.push(`COALESCE(vp.price_per_day, vp.price, 0) >= $${paramIdx}`);
      params.push(minPrice);
      paramIdx += 1;
    }

    if (maxPrice !== undefined) {
      conditions.push(`COALESCE(vp.price_per_day, vp.price, 0) <= $${paramIdx}`);
      params.push(maxPrice);
      paramIdx += 1;
    }

    if (minRating !== undefined) {
      conditions.push(`COALESCE(p.rating, 5.0) >= $${paramIdx}`);
      params.push(minRating);
      paramIdx += 1;
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const orderClause = SORT_CLAUSES[sort] || SORT_CLAUSES[SORT_OPTIONS.RELEVANCE];

    try {
      const offset = (page - 1) * limit;
      const countParams = [...params];
      const dataParams = [...params, limit, offset];

      const countText = `
        SELECT COUNT(DISTINCT v.id) AS total
        FROM vehicles v
        ${VehicleRepository.eligibilityJoins()}
        ${whereClause}
      `;

      const dataText = `
        WITH vehicle_candidates AS (
          SELECT DISTINCT ON (v.id) ${VehicleRepository.summarySelect(Boolean(startAt && endAt))}
          FROM vehicles v
          ${VehicleRepository.eligibilityJoins()}
          ${whereClause}
          ORDER BY v.id, v.created_at DESC
        )
        SELECT *
        FROM vehicle_candidates
        ORDER BY ${orderClause}
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `;

      const [countResult, dataResult] = await Promise.all([
        this.query(countText, countParams),
        this.query(dataText, dataParams),
      ]);

      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      return {
        rows: dataResult.rows,
        total,
      };
    } catch (err) {
      if (err.message && (err.message.includes('vehicle_models') || err.message.includes('vehicle_pricing') || err.message.includes('does not exist'))) {
        const legacyConditions = [
          "v.listing_status = 'ACTIVE'",
        ];
        const legacyParams = [eligibleStatuses];
        let legIdx = 2;
        if (categorySlug) {
          legacyConditions.push(`vc.slug = $${legIdx}`);
          legacyParams.push(categorySlug);
          legIdx += 1;
        }
        if (brand) {
          legacyConditions.push(`LOWER(v.brand) = LOWER($${legIdx})`);
          legacyParams.push(brand);
          legIdx += 1;
        }
        if (shopId) {
          legacyConditions.push(`v.shop_id = $${legIdx}`);
          legacyParams.push(shopId);
          legIdx += 1;
        }
        if (cityId) {
          legacyConditions.push(`v.city_id = $${legIdx}`);
          legacyParams.push(cityId);
          legIdx += 1;
        }
        if (fuelType) {
          legacyConditions.push(`v.fuel_type = $${legIdx}`);
          legacyParams.push(fuelType);
          legIdx += 1;
        }
        if (transmission) {
          legacyConditions.push(`v.transmission = $${legIdx}`);
          legacyParams.push(transmission);
          legIdx += 1;
        }
        if (minPrice !== undefined) {
          legacyConditions.push(`v.price_per_day >= $${legIdx}`);
          legacyParams.push(minPrice);
          legIdx += 1;
        }
        if (maxPrice !== undefined) {
          legacyConditions.push(`v.price_per_day <= $${legIdx}`);
          legacyParams.push(maxPrice);
          legIdx += 1;
        }
        if (minRating !== undefined) {
          legacyConditions.push(`v.rating_avg >= $${legIdx}`);
          legacyParams.push(minRating);
          legIdx += 1;
        }
        if (startAt && endAt) {
          try {
            const conflictRes = await this.query(`
              SELECT DISTINCT vehicle_id FROM bookings
              WHERE start_at < $2 AND (end_at + interval '1 hour') > $1
                AND LOWER(status) NOT IN ('cancelled', 'refunded', 'completed', 'returned')
            `, [startAt, endAt]);
            const conflictIds = (conflictRes.rows || []).map(r => r.vehicle_id).filter(Boolean);
            if (conflictIds.length > 0) {
              const idList = conflictIds.map(id => `'${id}'`).join(', ');
              legacyConditions.push(`v.id NOT IN (${idList})`);
            }
          } catch {
            // Ignore if bookings table is not present
          }
        }
        const legWhere = legacyConditions.length > 0 ? `WHERE ${legacyConditions.join(' AND ')}` : '';
        const countText = `
          SELECT COUNT(DISTINCT v.id) AS total
          FROM vehicles v
          ${VehicleRepository.legacyEligibilityJoins()}
          ${legWhere}
        `;
        const countResult = await this.query(countText, legacyParams);
        const total = parseInt(countResult.rows[0]?.total || '0', 10);
        const offset = (page - 1) * limit;
        const dataText = `
          SELECT ${VehicleRepository.legacySummarySelect()}
          FROM vehicles v
          ${VehicleRepository.legacyEligibilityJoins()}
          ${legWhere}
          ORDER BY v.created_at DESC
          LIMIT $${legIdx} OFFSET $${legIdx + 1}
        `;
        const dataResult = await this.query(dataText, [...legacyParams, limit, offset]);
        return {
          rows: dataResult.rows,
          total,
        };
      }
      throw err;
    }
  }

  /**
   * Find vehicle by ID — returns full customer-safe detail.
   *
   * @param {string} vehicleId — UUID
   * @returns {Promise<object|null>}
   */
  async findByIdPublic(vehicleId) {
    try {
      const text = `
        SELECT DISTINCT ON (v.id) ${VehicleRepository.summarySelect()}
        FROM vehicles v
        ${VehicleRepository.eligibilityJoins()}
        WHERE v.id = $2
          AND (v.is_archived IS NOT TRUE)
          AND (v.is_active IS NOT FALSE)
          AND (v.manual_status IS NULL OR UPPER(v.manual_status) != 'OFFLINE')
          AND (v.verification_status IN ('VERIFIED', 'APPROVED', 'verified', 'approved', 'PENDING', 'pending') OR v.status IN ('active', 'pending'))
          AND (v.verification_status IS NULL OR UPPER(v.verification_status) NOT IN ('REJECTED', 'SUSPENDED'))
          AND (v.status NOT IN ('inactive', 'rejected', 'suspended', 'INACTIVE', 'REJECTED', 'SUSPENDED'))
        ORDER BY v.id, v.created_at DESC
        LIMIT 1
      `;
      const result = await this.query(text, [PARTNER_ELIGIBLE_STATUSES, vehicleId]);
      return result.rows[0] || null;
    } catch (err) {
      if (err.message && (err.message.includes('vehicle_models') || err.message.includes('vehicle_pricing') || err.message.includes('does not exist'))) {
        const text = `
          SELECT ${VehicleRepository.legacySummarySelect()}
          FROM vehicles v
          ${VehicleRepository.legacyEligibilityJoins()}
          WHERE v.id = $2
            AND v.listing_status = 'ACTIVE'
          LIMIT 1
        `;
        const result = await this.query(text, [PARTNER_ELIGIBLE_STATUSES, vehicleId]);
        return result.rows[0] || null;
      }
      throw err;
    }
  }

  /**
   * Fetch vehicle images for a vehicle.
   *
   * @param {string} vehicleId
   * @returns {Promise<object[]>}
   */
  async findImagesByVehicleId(vehicleId) {
    try {
      const text = `
        SELECT id, COALESCE(sort_order, display_order, 0) AS display_order, COALESCE(is_cover, is_primary, false) AS is_primary, COALESCE(file_url, image_url, storage_key) AS file_url, created_at
        FROM vehicle_images
        WHERE vehicle_id = $1 AND (is_active = true OR is_active IS NULL)
        ORDER BY COALESCE(is_cover, is_primary, false) DESC, COALESCE(sort_order, display_order, 0) ASC
      `;
      const result = await this.query(text, [vehicleId]);
      return result.rows;
    } catch {
      const text = `
        SELECT id, display_order, is_primary, storage_key AS file_url, created_at
        FROM vehicle_images
        WHERE vehicle_id = $1
        ORDER BY is_primary DESC, display_order ASC
      `;
      const result = await this.query(text, [vehicleId]);
      return result.rows;
    }
  }

  /**
   * Nearby vehicles search using bounding-box pre-filter + Haversine ordering.
   *
   * @param {object} params
   * @returns {Promise<{rows: object[], total: number}>}
   */
  async findNearby({
    latitude,
    longitude,
    radiusKm,
    page,
    limit,
    eligibleStatuses = PARTNER_ELIGIBLE_STATUSES,
    startAt,
    endAt,
  }) {
    const latDelta = radiusKm / 111.32;
    const lonDelta = radiusKm / (111.32 * Math.cos((latitude * Math.PI) / 180));
    const minLat = latitude - latDelta;
    const maxLat = latitude + latDelta;
    const minLon = longitude - lonDelta;
    const maxLon = longitude + lonDelta;

    const haversine = `
      (
        6371 * ACOS(
          LEAST(1.0, COS(RADIANS($2::float8)) * COS(RADIANS(COALESCE(v.latitude, sh.latitude)::float8))
          * COS(RADIANS(COALESCE(v.longitude, sh.longitude)::float8) - RADIANS($3::float8))
          + SIN(RADIANS($2::float8)) * SIN(RADIANS(COALESCE(v.latitude, sh.latitude)::float8)))
        )
      )
    `;

    const qParams = [
      eligibleStatuses, // $1
      latitude, // $2
      longitude, // $3
      minLat, // $4
      maxLat, // $5
      minLon, // $6
      maxLon, // $7
      radiusKm, // $8
    ];

    const conditions = [
      "(v.is_archived IS NOT TRUE)",
      "(v.is_active IS NOT FALSE)",
      "(v.manual_status IS NULL OR UPPER(v.manual_status) != 'OFFLINE')",
      "(v.verification_status IN ('VERIFIED', 'APPROVED', 'verified', 'approved', 'PENDING', 'pending') OR v.status IN ('active', 'pending'))",
      "(v.verification_status IS NULL OR UPPER(v.verification_status) NOT IN ('REJECTED', 'SUSPENDED'))",
      "(v.status NOT IN ('inactive', 'rejected', 'suspended', 'INACTIVE', 'REJECTED', 'SUSPENDED'))",
      "COALESCE(v.latitude, sh.latitude) IS NOT NULL",
      "COALESCE(v.longitude, sh.longitude) IS NOT NULL",
      "COALESCE(v.latitude, sh.latitude)  BETWEEN $4 AND $5",
      "COALESCE(v.longitude, sh.longitude) BETWEEN $6 AND $7",
      `${haversine} <= $8`,
    ];

    if (startAt && endAt) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM bookings b
        WHERE b.vehicle_id = v.id
          AND b.start_at < $10::timestamptz
          AND (b.end_at + interval '1 hour') > $9::timestamptz
          AND b.status NOT IN ('cancelled', 'refunded', 'completed', 'returned', 'CANCELLED', 'REFUNDED', 'COMPLETED', 'RETURNED')
          AND (b.booking_status IS NULL OR b.booking_status NOT IN ('CANCELLED', 'REFUNDED', 'COMPLETED', 'RETURNED', 'cancelled', 'refunded', 'completed', 'returned'))
      )`);
      qParams.push(startAt);
      qParams.push(endAt);
    }

    const geoWhere = `WHERE ${conditions.join(' AND ')}`;

    const countText = `
      SELECT COUNT(DISTINCT v.id) AS total
      FROM vehicles v
      ${VehicleRepository.eligibilityJoins()}
      ${geoWhere}
    `;
    const countResult = await this.query(countText, qParams);
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    const offset = (page - 1) * limit;
    const limitIdx = qParams.length + 1;
    const offsetIdx = qParams.length + 2;
    const paginatedParams = [...qParams, limit, offset];

    const dataText = `
      SELECT
        ${VehicleRepository.summarySelect(Boolean(startAt && endAt))},
        ${haversine} AS distance_km
      FROM vehicles v
      ${VehicleRepository.eligibilityJoins()}
      ${geoWhere}
      ORDER BY distance_km ASC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const dataResult = await this.query(dataText, paginatedParams);
    return {
      rows: dataResult.rows,
      total,
    };
  }

  /**
   * Get all active vehicle categories.
   *
   * @returns {Promise<object[]>}
   */
  async findAllCategories() {
    try {
      const text = `
        SELECT id, name, code AS slug, description, 0 AS sort_order
        FROM vehicle_categories
        WHERE is_active = true
        ORDER BY name ASC
      `;
      const result = await this.query(text, []);
      return result.rows;
    } catch {
      // Legacy schema (database/migrations/1726700000000) names the column `slug`, not `code`
      const text = `
        SELECT id, name, slug, description, 0 AS sort_order
        FROM vehicle_categories
        WHERE is_active = true
        ORDER BY name ASC
      `;
      const result = await this.query(text, []);
      return result.rows;
    }
  }

  /**
   * Get all active cities.
   *
   * @returns {Promise<object[]>}
   */
  async findCitiesWithVehicles() {
    try {
      const text = `
        SELECT DISTINCT
          COALESCE(c.id, sh.id) AS id,
          COALESCE(c.name, sh.city) AS name,
          COALESCE(sh.city, c.name) AS state,
          'IN' AS country_code
        FROM shops sh
        JOIN vehicles v ON v.shop_id = sh.id
          AND (v.is_archived IS NOT TRUE)
          AND (v.is_active IS NOT FALSE)
          AND (v.manual_status IS NULL OR UPPER(v.manual_status) != 'OFFLINE')
          AND (v.verification_status IN ('VERIFIED', 'APPROVED', 'verified', 'approved', 'PENDING', 'pending') OR v.status IN ('active', 'pending'))
          AND (v.verification_status IS NULL OR UPPER(v.verification_status) NOT IN ('REJECTED', 'SUSPENDED'))
        JOIN partners p ON p.id = sh.partner_id
          AND (
            p.verification_status = ANY($1::text[])
            OR p.verification_status IN ('verified', 'approved', 'VERIFIED', 'APPROVED')
            OR p.kyc_status IN ('verified', 'approved', 'VERIFIED', 'APPROVED')
          )
          AND p.is_active = true
          AND (p.status IS NULL OR LOWER(p.status) NOT IN ('suspended', 'deactivated', 'rejected'))
          AND (p.partner_status IS NULL OR UPPER(p.partner_status) != 'SUSPENDED')
        LEFT JOIN cities c ON c.id = sh.city_id
        WHERE sh.is_active = true AND COALESCE(c.name, sh.city) IS NOT NULL
        ORDER BY name ASC
      `;
      const result = await this.query(text, [PARTNER_ELIGIBLE_STATUSES]);
      return result.rows;
    } catch {
      const text = `
        SELECT DISTINCT
          COALESCE(sh.city_id, sh.id) AS id,
          sh.city AS name
        FROM shops sh
        JOIN vehicles v ON v.shop_id = sh.id AND (v.status = 'active' OR v.status = 'pending')
        JOIN partners p ON p.id = sh.partner_id
          AND p.is_active = true
          AND (p.status IS NULL OR LOWER(p.status) NOT IN ('suspended', 'deactivated', 'rejected'))
          AND (p.partner_status IS NULL OR UPPER(p.partner_status) != 'SUSPENDED')
        WHERE sh.is_active = true AND sh.city IS NOT NULL
        ORDER BY name ASC
      `;
      const result = await this.query(text, []);
      return result.rows;
    }
  }
}

module.exports = VehicleRepository;
