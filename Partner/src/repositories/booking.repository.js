'use strict';

const BaseRepository = require('../db/base.repository');

class BookingRepository extends BaseRepository {
  constructor() {
    super('bookings', 'id');
  }

  /**
   * Builds the WHERE conditions and parameter array for partner bookings.
   *
   * @private
   * @param {string} partnerId
   * @param {object} options
   * @returns {{ conditions: string[], values: any[] }}
   */
  _buildConditions(partnerId, options = {}) {
    const {
      status,
      tab,
      vehicleId,
      startDate,
      endDate,
      search,
    } = options;

    const values = [partnerId];
    let idx = 2;
    const conditions = ['(b.partner_id = $1 OR v.partner_id = $1)'];

    // Status / Tab filter
    if (status) {
      const upperStatus = status.toUpperCase();
      if (upperStatus === 'UPCOMING' || upperStatus === 'CONFIRMED') {
        conditions.push("(b.booking_status IN ('UPCOMING', 'CONFIRMED', 'BOOKED', 'PAYMENT_COMPLETED', 'PAID') OR COALESCE(b.status, '') IN ('payment_completed', 'confirmed', 'pickup_scheduled', 'UPCOMING', 'CONFIRMED', 'BOOKED', 'PAYMENT_COMPLETED', 'PAID'))");
      } else if (upperStatus === 'ACTIVE') {
        conditions.push("(b.booking_status IN ('ACTIVE', 'IN_PROGRESS') OR COALESCE(b.status, '') IN ('active', 'in_progress', 'vehicle_picked', 'ACTIVE', 'IN_PROGRESS'))");
      } else if (upperStatus === 'COMPLETED') {
        conditions.push("(b.booking_status = 'COMPLETED' OR COALESCE(b.status, '') IN ('completed', 'returned', 'COMPLETED'))");
      } else if (upperStatus === 'CANCELLED') {
        conditions.push("(b.booking_status = 'CANCELLED' OR COALESCE(b.status, '') IN ('cancelled', 'refunded', 'CANCELLED'))");
      } else if (upperStatus !== 'ALL') {
        conditions.push(`(b.booking_status = $${idx} OR b.status = $${idx})`);
        values.push(upperStatus);
        idx += 1;
      }
    } else if (tab) {
      const lowerTab = tab.toLowerCase();
      if (lowerTab === 'upcoming') {
        conditions.push("(b.booking_status IN ('UPCOMING', 'CONFIRMED', 'BOOKED', 'PAYMENT_COMPLETED', 'PAID') OR COALESCE(b.status, '') IN ('payment_completed', 'confirmed', 'pickup_scheduled', 'UPCOMING', 'CONFIRMED', 'BOOKED', 'PAYMENT_COMPLETED', 'PAID'))");
      } else if (lowerTab === 'active') {
        conditions.push("(b.booking_status IN ('ACTIVE', 'IN_PROGRESS') OR COALESCE(b.status, '') IN ('active', 'in_progress', 'vehicle_picked', 'ACTIVE', 'IN_PROGRESS'))");
      } else if (lowerTab === 'completed') {
        conditions.push("(b.booking_status IN ('COMPLETED') OR COALESCE(b.status, '') IN ('completed', 'returned', 'COMPLETED'))");
      } else if (lowerTab === 'cancelled') {
        conditions.push("(b.booking_status IN ('CANCELLED') OR COALESCE(b.status, '') IN ('cancelled', 'refunded', 'CANCELLED'))");
      }
    } else {
      // By default, do not expose PENDING_PAYMENT or unpaid initiated to partner unless explicitly requested
      conditions.push("(b.booking_status NOT IN ('PENDING_PAYMENT') AND COALESCE(b.status, '') NOT IN ('initiated', 'payment_pending'))");
    }

    if (vehicleId) {
      conditions.push(`b.vehicle_id = $${idx}`);
      values.push(vehicleId);
      idx += 1;
    }

    if (startDate) {
      conditions.push(`b.expected_return_at >= $${idx}`);
      values.push(startDate);
      idx += 1;
    }

    if (endDate) {
      conditions.push(`b.start_at <= $${idx}`);
      values.push(endDate);
      idx += 1;
    }

    if (search && typeof search === 'string' && search.trim()) {
      const term = `%${search.trim()}%`;
      conditions.push(`(
        b.booking_number ILIKE $${idx} OR
        b.booking_reference ILIKE $${idx} OR
        b.customer_name ILIKE $${idx} OR
        u.name ILIKE $${idx} OR
        b.customer_phone ILIKE $${idx} OR
        u.phone ILIKE $${idx} OR
        v.registration_number ILIKE $${idx} OR
        v.vehicle_reference ILIKE $${idx} OR
        v.brand ILIKE $${idx} OR
        v.model ILIKE $${idx}
      )`);
      values.push(term);
      idx += 1;
    }

    return { conditions, values };
  }

  /**
   * Find bookings for a partner with filtering and pagination.
   *
   * @param {string} partnerId
   * @param {object} [options]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findBookingsByPartnerId(partnerId, options = {}, client = null) {
    const { conditions, values } = this._buildConditions(partnerId, options);
    const { limit = 20, offset = 0, tab, status } = options;

    let orderDirection = 'DESC';
    const activeTab = (tab || '').toLowerCase();
    const activeStatus = (status || '').toUpperCase();
    if (activeTab === 'upcoming' || activeStatus === 'UPCOMING' || activeStatus === 'CONFIRMED' || activeTab === 'active' || activeStatus === 'ACTIVE') {
      orderDirection = 'ASC';
    }

    const limitIdx = values.length + 1;
    values.push(limit);

    const offsetIdx = values.length + 1;
    values.push(offset);

    const text = `
      SELECT 
        b.id,
        b.booking_reference,
        b.booking_number,
        b.customer_id,
        COALESCE(NULLIF(TRIM(b.customer_name), ''), NULLIF(TRIM(u.name), ''), 'Customer') AS customer_name,
        COALESCE(NULLIF(TRIM(b.customer_phone), ''), NULLIF(TRIM(u.phone), '')) AS customer_phone,
        b.partner_id,
        b.shop_id,
        b.vehicle_id,
        v.vehicle_reference,
        b.start_at,
        COALESCE(b.expected_return_at, b.end_at) AS expected_return_at,
        b.end_at,
        b.booking_status,
        b.payment_status,
        COALESCE(b.booking_status, UPPER(b.status)) AS effective_booking_status,
        b.status AS legacy_status,
        b.pickup_location,
        b.created_at,
        b.updated_at,
        v.brand AS vehicle_brand,
        v.model AS vehicle_model,
        v.variant AS vehicle_variant,
        v.registration_number,
        v.category AS vehicle_category,
        v.fuel_type AS vehicle_fuel_type,
        v.transmission AS vehicle_transmission,
        v.seats AS vehicle_seats,
        v.verification_status AS vehicle_verification_status,
        COALESCE(v.primary_image_url, vi_cover.image_url, vi_cover.storage_key) AS vehicle_cover_image_key,
        COALESCE(bps.base_amount, bpb.base_amount, b.subtotal, b.total_amount, 0)::numeric(12,2) AS base_amount,
        COALESCE(bps.rental_amount, bpb.base_amount, b.subtotal, b.total_amount, 0)::numeric(12,2) AS rental_amount,
        COALESCE(bps.security_deposit, bpb.security_deposit, vp.security_deposit, 0)::numeric(12,2) AS security_deposit,
        COALESCE(bps.extra_km_charge, vp.extra_km_charge, 0)::numeric(12,2) AS extra_km_charge,
        COALESCE(bps.late_fee, 0)::numeric(12,2) AS late_fee,
        COALESCE(bps.discount_amount, bpb.discount_amount, b.discount_amount, 0)::numeric(12,2) AS discount_amount,
        COALESCE(bps.taxes_amount, bpb.tax_amount, b.tax_amount, 0)::numeric(12,2) AS taxes_amount,
        COALESCE(bps.total_customer_amount, bpb.total_amount, b.total_amount, 0)::numeric(12,2) AS total_customer_amount,
        COALESCE(bps.currency, bpb.currency, vp.currency, b.currency, 'INR') AS currency,
        COALESCE(bps.price_per_hour, vp.price_per_hour, 0)::numeric(12,2) AS price_per_hour,
        b.total_amount,
        COALESCE(e.gross_amount, cr.gross_booking_amount, bps.total_customer_amount, b.total_amount, 0)::numeric(12,2) AS gross_amount,
        COALESCE(cr.commission_rate, cr.rate, 0)::numeric(5,2) AS commission_rate,
        COALESCE(cr.commission_amount, e.commission_amount, 0)::numeric(12,2) AS commission_amount,
        COALESCE(e.partner_net_amount, cr.partner_payable_amount, cr.partner_payout_amount, b.total_amount, 0)::numeric(12,2) AS partner_net_amount,
        bpv.verified_at AS handover_at,
        bpv.notes AS pickup_notes,
        brv.returned_at,
        brv.return_status,
        brv.late_minutes,
        brv.late_fee AS return_late_fee,
        brv.total_distance,
        COALESCE((
          SELECT json_agg(p ORDER BY p.created_at DESC)
          FROM payments p
          WHERE p.booking_id = b.id
        ), '[]'::json) AS payments_json,
        COUNT(*) OVER()::int AS total_count
      FROM ${this.tableName} b
      JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN users u ON u.id = b.customer_id
      LEFT JOIN LATERAL (
        SELECT vi.storage_key, vi.image_url 
        FROM vehicle_images vi 
        WHERE vi.vehicle_id = v.id AND vi.is_active = true 
        ORDER BY vi.is_cover DESC, vi.sort_order ASC, vi.created_at ASC 
        LIMIT 1
      ) vi_cover ON true
      LEFT JOIN LATERAL (
        SELECT bps.*
        FROM booking_pricing_snapshots bps
        WHERE bps.booking_id = b.id
        ORDER BY bps.created_at DESC
        LIMIT 1
      ) bps ON true
      LEFT JOIN LATERAL (
        SELECT bpb.*
        FROM booking_price_breakdown bpb
        WHERE bpb.booking_id = b.id
        ORDER BY bpb.created_at DESC
        LIMIT 1
      ) bpb ON true
      LEFT JOIN LATERAL (
        SELECT vp.*
        FROM vehicle_pricing vp
        WHERE vp.vehicle_id = b.vehicle_id AND vp.is_active = true
        ORDER BY vp.created_at DESC
        LIMIT 1
      ) vp ON true
      LEFT JOIN LATERAL (
        SELECT e.*
        FROM earnings e
        WHERE e.booking_id = b.id
        ORDER BY e.created_at DESC
        LIMIT 1
      ) e ON true
      LEFT JOIN LATERAL (
        SELECT cr.*
        FROM commission_records cr
        WHERE cr.booking_id = b.id
        ORDER BY cr.created_at DESC
        LIMIT 1
      ) cr ON true
      LEFT JOIN LATERAL (
        SELECT bpv.*
        FROM booking_pickup_verifications bpv
        WHERE bpv.booking_id = b.id AND bpv.is_verified = true
        ORDER BY bpv.verified_at DESC
        LIMIT 1
      ) bpv ON true
      LEFT JOIN LATERAL (
        SELECT brv.*
        FROM booking_return_verifications brv
        WHERE brv.booking_id = b.id
        ORDER BY brv.created_at DESC
        LIMIT 1
      ) brv ON true
      WHERE ${conditions.join(' AND ')}
      ORDER BY b.start_at ${orderDirection}
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    try {
      const res = client
        ? await client.query(text, values)
        : await this.query(text, values);
      return res.rows;
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.findBookingsByPartnerId');
    }
  }

  /**
   * Count total bookings matching filters for a partner.
   *
   * @param {string} partnerId
   * @param {object} [options]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async countBookingsByPartnerId(partnerId, options = {}, client = null) {
    const { conditions, values } = this._buildConditions(partnerId, options);

    const text = `
      SELECT COUNT(*)::integer AS total
      FROM ${this.tableName} b
      JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN users u ON u.id = b.customer_id
      WHERE ${conditions.join(' AND ')};
    `;

    try {
      const res = client
        ? await client.query(text, values)
        : await this.query(text, values);
      return parseInt(res.rows[0].total, 10);
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.countBookingsByPartnerId');
    }
  }

  /**
   * Find booking by ID with strict partner ownership verification.
   *
   * @param {string} bookingId
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findBookingByIdAndPartnerId(bookingId, partnerId, client = null) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(bookingId).trim());
    const idCondition = isUuid ? 'b.id = $1' : '(b.booking_reference = $1 OR b.booking_number = $1)';

    const text = `
      SELECT 
        b.id,
        b.booking_reference,
        b.booking_number,
        b.customer_id,
        COALESCE(NULLIF(TRIM(b.customer_name), ''), NULLIF(TRIM(u.name), ''), 'Customer') AS customer_name,
        COALESCE(NULLIF(TRIM(b.customer_phone), ''), NULLIF(TRIM(u.phone), '')) AS customer_phone,
        b.partner_id,
        b.shop_id,
        b.vehicle_id,
        v.vehicle_reference,
        b.start_at,
        COALESCE(b.expected_return_at, b.end_at) AS expected_return_at,
        b.end_at,
        b.booking_status,
        b.payment_status,
        COALESCE(b.booking_status, UPPER(b.status)) AS effective_booking_status,
        b.status AS legacy_status,
        b.pickup_location,
        b.created_at,
        b.updated_at,
        v.brand AS vehicle_brand,
        v.model AS vehicle_model,
        v.variant AS vehicle_variant,
        v.registration_number,
        v.category AS vehicle_category,
        v.fuel_type AS vehicle_fuel_type,
        v.transmission AS vehicle_transmission,
        v.seats AS vehicle_seats,
        v.verification_status AS vehicle_verification_status,
        COALESCE(
          v.primary_image_url,
          (
            SELECT COALESCE(vi.image_url, vi.storage_key)
            FROM vehicle_images vi 
            WHERE vi.vehicle_id = v.id AND vi.is_active = true 
            ORDER BY vi.is_cover DESC, vi.sort_order ASC, vi.created_at ASC 
            LIMIT 1
          )
        ) AS vehicle_cover_image_key,
        COALESCE(bps.base_amount, bpb.base_amount, b.subtotal, b.total_amount, 0)::numeric(12,2) AS base_amount,
        COALESCE(bps.rental_amount, bpb.base_amount, b.subtotal, b.total_amount, 0)::numeric(12,2) AS rental_amount,
        COALESCE(bps.security_deposit, bpb.security_deposit, vp.security_deposit, 0)::numeric(12,2) AS security_deposit,
        COALESCE(bps.extra_km_charge, vp.extra_km_charge, 0)::numeric(12,2) AS extra_km_charge,
        COALESCE(bps.late_fee, 0)::numeric(12,2) AS late_fee,
        COALESCE(bps.discount_amount, bpb.discount_amount, b.discount_amount, 0)::numeric(12,2) AS discount_amount,
        COALESCE(bps.taxes_amount, bpb.tax_amount, b.tax_amount, 0)::numeric(12,2) AS taxes_amount,
        COALESCE(bps.total_customer_amount, bpb.total_amount, b.total_amount, 0)::numeric(12,2) AS total_customer_amount,
        COALESCE(bps.currency, bpb.currency, vp.currency, b.currency, 'INR') AS currency,
        COALESCE(bps.price_per_hour, vp.price_per_hour, 0)::numeric(12,2) AS price_per_hour,
        b.total_amount,
        COALESCE(e.gross_amount, cr.gross_booking_amount, bps.total_customer_amount, b.total_amount, 0)::numeric(12,2) AS gross_amount,
        COALESCE(cr.commission_rate, cr.rate, 0)::numeric(5,2) AS commission_rate,
        COALESCE(cr.commission_amount, e.commission_amount, 0)::numeric(12,2) AS commission_amount,
        COALESCE(e.partner_net_amount, cr.partner_payable_amount, cr.partner_payout_amount, b.total_amount, 0)::numeric(12,2) AS partner_net_amount,
        bpv.verified_at AS handover_at,
        bpv.odometer_start,
        bpv.fuel_level_start,
        bpv.notes AS pickup_notes,
        brv.returned_at,
        brv.odometer_end,
        brv.fuel_level_end,
        brv.late_minutes,
        brv.late_fee AS return_late_fee,
        brv.extra_km,
        brv.extra_km_fee,
        brv.total_distance,
        brv.return_status,
        brv.notes AS return_notes,
        brv.photos AS return_photos,
        COALESCE((
          SELECT json_agg(p ORDER BY p.created_at DESC)
          FROM payments p
          WHERE p.booking_id = b.id
        ), '[]'::json) AS payments_json
      FROM ${this.tableName} b
      JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN users u ON u.id = b.customer_id
      LEFT JOIN booking_pricing_snapshots bps ON bps.booking_id = b.id
      LEFT JOIN LATERAL (
        SELECT bpb.*
        FROM booking_price_breakdown bpb
        WHERE bpb.booking_id = b.id
        ORDER BY bpb.created_at DESC
        LIMIT 1
      ) bpb ON true
      LEFT JOIN LATERAL (
        SELECT vp.*
        FROM vehicle_pricing vp
        WHERE vp.vehicle_id = b.vehicle_id AND vp.is_active = true
        ORDER BY vp.created_at DESC
        LIMIT 1
      ) vp ON true
      LEFT JOIN earnings e ON e.booking_id = b.id
      LEFT JOIN commission_records cr ON cr.booking_id = b.id
      LEFT JOIN booking_pickup_verifications bpv ON bpv.booking_id = b.id AND bpv.is_verified = true
      LEFT JOIN booking_return_verifications brv ON brv.booking_id = b.id
      WHERE ${idCondition} AND (b.partner_id = $2 OR v.partner_id = $2)
      LIMIT 1;
    `;

    try {
      const res = client
        ? await client.query(text, [bookingId, partnerId])
        : await this.query(text, [bookingId, partnerId]);
      return res.rows[0] || null;
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.findBookingByIdAndPartnerId');
    }
  }

  /**
   * Find booking by partner ID and booking ID (alias with parameter order partnerId, bookingId).
   *
   * @param {string} partnerId
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findPartnerBookingById(partnerId, bookingId, client = null) {
    return this.findBookingByIdAndPartnerId(bookingId, partnerId, client);
  }

  /**
   * Find booking and vehicle with exclusive row-level lock (FOR UPDATE).
   *
   * @param {string} bookingId
   * @param {string} partnerId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findBookingByIdAndPartnerIdForUpdate(bookingId, partnerId, client) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(bookingId).trim());
    const idCondition = isUuid ? 'b.id = $1' : '(b.booking_reference = $1 OR b.booking_number = $1)';

    const text = `
      SELECT 
        b.id,
        b.booking_reference,
        b.booking_number,
        b.customer_id,
        COALESCE(NULLIF(TRIM(b.customer_name), ''), NULLIF(TRIM(u.name), ''), 'Customer') AS customer_name,
        COALESCE(NULLIF(TRIM(b.customer_phone), ''), NULLIF(TRIM(u.phone), '')) AS customer_phone,
        b.partner_id,
        b.shop_id,
        b.vehicle_id,
        v.vehicle_reference,
        b.start_at,
        COALESCE(b.expected_return_at, b.end_at) AS expected_return_at,
        b.end_at,
        b.booking_status,
        b.payment_status,
        b.pickup_location,
        b.created_at,
        b.updated_at,
        v.id AS vehicle_id,
        v.partner_id AS vehicle_partner_id,
        v.brand AS vehicle_brand,
        v.model AS vehicle_model,
        v.registration_number,
        v.rental_status AS vehicle_rental_status,
        v.manual_status AS vehicle_manual_status,
        v.is_archived AS vehicle_is_archived,
        COALESCE(bps.base_amount, bpb.base_amount, b.subtotal, b.total_amount, 0)::numeric(12,2) AS base_amount,
        COALESCE(bps.rental_amount, bpb.base_amount, b.subtotal, b.total_amount, 0)::numeric(12,2) AS rental_amount,
        COALESCE(bps.security_deposit, bpb.security_deposit, vp.security_deposit, 0)::numeric(12,2) AS security_deposit,
        COALESCE(bps.extra_km_charge, vp.extra_km_charge, 0)::numeric(12,2) AS extra_km_charge,
        COALESCE(bps.late_fee, 0)::numeric(12,2) AS late_fee,
        COALESCE(bps.discount_amount, bpb.discount_amount, b.discount_amount, 0)::numeric(12,2) AS discount_amount,
        COALESCE(bps.taxes_amount, bpb.tax_amount, b.tax_amount, 0)::numeric(12,2) AS taxes_amount,
        COALESCE(bps.total_customer_amount, bpb.total_amount, b.total_amount, 0)::numeric(12,2) AS total_customer_amount,
        COALESCE(bps.currency, bpb.currency, vp.currency, b.currency, 'INR') AS currency,
        COALESCE(bps.price_per_hour, vp.price_per_hour, 0)::numeric(12,2) AS price_per_hour,
        bpv.odometer_start,
        bpv.fuel_level_start,
        bpv.notes AS pickup_notes,
        bpv.verified_at AS handover_at
      FROM ${this.tableName} b
      JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN users u ON u.id = b.customer_id
      LEFT JOIN booking_pricing_snapshots bps ON bps.booking_id = b.id
      LEFT JOIN LATERAL (
        SELECT bpb.*
        FROM booking_price_breakdown bpb
        WHERE bpb.booking_id = b.id
        ORDER BY bpb.created_at DESC
        LIMIT 1
      ) bpb ON true
      LEFT JOIN LATERAL (
        SELECT vp.*
        FROM vehicle_pricing vp
        WHERE vp.vehicle_id = b.vehicle_id AND vp.is_active = true
        ORDER BY vp.created_at DESC
        LIMIT 1
      ) vp ON true
      LEFT JOIN booking_pickup_verifications bpv ON bpv.booking_id = b.id AND bpv.is_verified = true
      WHERE ${idCondition} AND b.partner_id = $2 AND v.partner_id = $2
      FOR UPDATE OF b, v;
    `;

    try {
      const res = await client.query(text, [bookingId, partnerId]);
      return res.rows[0] || null;
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.findBookingByIdAndPartnerIdForUpdate');
    }
  }

  /**
   * Find pickup verification record by booking ID.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findPickupVerificationByBookingId(bookingId, client = null) {
    const text = `
      SELECT 
        id,
        booking_id,
        otp_hash,
        verification_reference,
        is_verified,
        verified_at,
        verified_by,
        odometer_start,
        fuel_level_start,
        photos,
        notes,
        created_at
      FROM booking_pickup_verifications
      WHERE booking_id = $1
      LIMIT 1;
    `;

    try {
      const res = client
        ? await client.query(text, [bookingId])
        : await this.query(text, [bookingId]);
      return res.rows[0] || null;
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.findPickupVerificationByBookingId');
    }
  }

  /**
   * Upsert pickup verification row.
   *
   * @param {object} data
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async upsertPickupVerification(data, client) {
    const text = `
      INSERT INTO booking_pickup_verifications (
        booking_id,
        otp_hash,
        verification_reference,
        is_verified,
        verified_at,
        verified_by,
        odometer_start,
        fuel_level_start,
        photos,
        notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (booking_id) DO UPDATE SET
        otp_hash = COALESCE(EXCLUDED.otp_hash, booking_pickup_verifications.otp_hash),
        verification_reference = COALESCE(
          EXCLUDED.verification_reference,
          booking_pickup_verifications.verification_reference
        ),
        is_verified = EXCLUDED.is_verified,
        verified_at = EXCLUDED.verified_at,
        verified_by = EXCLUDED.verified_by,
        odometer_start = COALESCE(
          EXCLUDED.odometer_start,
          booking_pickup_verifications.odometer_start
        ),
        fuel_level_start = COALESCE(
          EXCLUDED.fuel_level_start,
          booking_pickup_verifications.fuel_level_start
        ),
        photos = COALESCE(EXCLUDED.photos, booking_pickup_verifications.photos),
        notes = COALESCE(EXCLUDED.notes, booking_pickup_verifications.notes)
      RETURNING *;
    `;

    const values = [
      data.bookingId,
      data.otpHash || null,
      data.verificationReference || null,
      data.isVerified !== undefined ? data.isVerified : true,
      data.verifiedAt || new Date().toISOString(),
      data.verifiedBy || null,
      data.odometerStart !== undefined ? data.odometerStart : null,
      data.fuelLevelStart || null,
      data.photos || null,
      data.notes || null,
    ];

    try {
      const res = await client.query(text, values);
      return res.rows[0];
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.upsertPickupVerification');
    }
  }

  /**
   * Upsert booking pickup record into booking_pickup table.
   *
   * @param {object} data
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async upsertBookingPickup(data, client) {
    if (!client || typeof client.query !== 'function') return null;
    const text = `
      INSERT INTO booking_pickup (
        booking_id,
        picked_up_at,
        pickup_location,
        handed_over_by,
        odometer_reading,
        fuel_level,
        notes,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (booking_id) DO UPDATE SET
        picked_up_at = EXCLUDED.picked_up_at,
        pickup_location = COALESCE(EXCLUDED.pickup_location, booking_pickup.pickup_location),
        handed_over_by = COALESCE(EXCLUDED.handed_over_by, booking_pickup.handed_over_by),
        odometer_reading = COALESCE(EXCLUDED.odometer_reading, booking_pickup.odometer_reading),
        fuel_level = COALESCE(EXCLUDED.fuel_level, booking_pickup.fuel_level),
        notes = COALESCE(EXCLUDED.notes, booking_pickup.notes),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const values = [
      data.bookingId,
      data.pickedUpAt || new Date().toISOString(),
      data.pickupLocation || null,
      data.handedOverBy || null,
      data.odometerReading !== undefined ? data.odometerReading : null,
      (data.fuelLevel !== undefined && data.fuelLevel !== null && !isNaN(Number(data.fuelLevel))) ? Number(data.fuelLevel) : null,
      data.notes || null,
    ];

    try {
      const res = await client.query(text, values);
      return res.rows[0] || null;
    } catch (err) {
      if (err.message && err.message.includes('booking_pickup') && err.message.includes('does not exist')) {
        return null;
      }
      this.handleDbError(err, 'BookingRepository.upsertBookingPickup');
    }
  }

  /**
   * Record booking status change in booking_status_history table.
   *
   * @param {object} data
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async recordStatusHistory(data, client) {
    if (!client || typeof client.query !== 'function') return null;
    const text = `
      INSERT INTO booking_status_history (
        booking_id,
        old_status,
        new_status,
        changed_by,
        change_reason,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      RETURNING *;
    `;
    const values = [
      data.bookingId,
      data.oldStatus ? String(data.oldStatus).toLowerCase() : null,
      String(data.newStatus).toLowerCase(),
      data.changedBy || null,
      data.changeReason || null,
    ];

    try {
      const res = await client.query(text, values);
      return res.rows[0] || null;
    } catch (err) {
      if (err.message && err.message.includes('booking_status_history') && err.message.includes('does not exist')) {
        return null;
      }
      this.handleDbError(err, 'BookingRepository.recordStatusHistory');
    }
  }

  /**
   * Update booking status with canonical lifecycle synchronization.
   * Updates booking_status (e.g. ACTIVE, COMPLETED) AND status (e.g. in_progress, completed).
   *
   * @param {string} bookingId
   * @param {string} status
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async updateBookingStatus(bookingId, status, client) {
    if (!client || typeof client.query !== 'function') return null;
    const statusUpper = String(status || '').toUpperCase();
    let lowerStatus = 'in_progress';
    let upperBookingStatus = statusUpper;

    if (statusUpper === 'ACTIVE' || statusUpper === 'IN_PROGRESS') {
      lowerStatus = 'in_progress';
      upperBookingStatus = 'ACTIVE';
    } else if (statusUpper === 'COMPLETED' || statusUpper === 'RETURNED') {
      lowerStatus = 'completed';
      upperBookingStatus = 'COMPLETED';
    } else if (statusUpper === 'CONFIRMED' || statusUpper === 'UPCOMING') {
      lowerStatus = 'confirmed';
      upperBookingStatus = 'CONFIRMED';
    } else if (statusUpper === 'CANCELLED') {
      lowerStatus = 'cancelled';
      upperBookingStatus = 'CANCELLED';
    } else {
      lowerStatus = String(status).toLowerCase();
      upperBookingStatus = statusUpper;
    }

    const text = `
      UPDATE ${this.tableName}
      SET booking_status = $2, status = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;

    try {
      const res = await client.query(text, [bookingId, upperBookingStatus, lowerStatus]);
      return res.rows[0] || null;
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.updateBookingStatus');
    }
  }

  /**
   * Find another active booking conflicting with this vehicle.
   *
   * @param {string} vehicleId
   * @param {string} currentBookingId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findConflictingActiveBooking(vehicleId, currentBookingId, client) {
    const text = `
      SELECT id, booking_number, booking_status
      FROM ${this.tableName}
      WHERE vehicle_id = $1 
        AND (
          booking_status IN ('ACTIVE', 'IN_PROGRESS', 'RETURN_PENDING')
          OR status IN ('active', 'in_progress', 'return_pending', 'vehicle_picked')
        )
        AND id != $2
      LIMIT 1;
    `;

    try {
      const res = await client.query(text, [vehicleId, currentBookingId]);
      return res.rows[0] || null;
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.findConflictingActiveBooking');
    }
  }

  /**
   * Find return verification record by booking ID.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findReturnVerificationByBookingId(bookingId, client = null) {
    const text = `
      SELECT 
        id,
        booking_id,
        returned_at,
        odometer_end,
        fuel_level_end,
        late_minutes,
        late_fee,
        extra_km,
        extra_km_fee,
        total_distance,
        return_status,
        notes,
        photos,
        verified_by,
        created_at
      FROM booking_return_verifications
      WHERE booking_id = $1
      LIMIT 1;
    `;

    try {
      const res = client
        ? await client.query(text, [bookingId])
        : await this.query(text, [bookingId]);
      return res.rows[0] || null;
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.findReturnVerificationByBookingId');
    }
  }

  /**
   * Upsert return verification row atomically.
   *
   * @param {object} data
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async upsertReturnVerification(data, client) {
    const text = `
      INSERT INTO booking_return_verifications (
        booking_id,
        returned_at,
        odometer_end,
        fuel_level_end,
        late_minutes,
        late_fee,
        extra_km,
        extra_km_fee,
        total_distance,
        return_status,
        notes,
        photos,
        verified_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (booking_id) DO UPDATE SET
        returned_at = EXCLUDED.returned_at,
        odometer_end = COALESCE(EXCLUDED.odometer_end, booking_return_verifications.odometer_end),
        fuel_level_end = COALESCE(EXCLUDED.fuel_level_end, booking_return_verifications.fuel_level_end),
        late_minutes = EXCLUDED.late_minutes,
        late_fee = EXCLUDED.late_fee,
        extra_km = EXCLUDED.extra_km,
        extra_km_fee = EXCLUDED.extra_km_fee,
        total_distance = COALESCE(EXCLUDED.total_distance, booking_return_verifications.total_distance),
        return_status = EXCLUDED.return_status,
        notes = COALESCE(EXCLUDED.notes, booking_return_verifications.notes),
        photos = COALESCE(EXCLUDED.photos, booking_return_verifications.photos),
        verified_by = EXCLUDED.verified_by
      RETURNING *;
    `;

    const values = [
      data.bookingId,
      data.returnedAt || new Date().toISOString(),
      data.odometerEnd !== undefined ? data.odometerEnd : null,
      data.fuelLevelEnd || null,
      data.lateMinutes !== undefined ? data.lateMinutes : 0,
      data.lateFee !== undefined ? data.lateFee : 0,
      data.extraKm !== undefined ? data.extraKm : 0,
      data.extraKmFee !== undefined ? data.extraKmFee : 0,
      data.totalDistance !== undefined ? data.totalDistance : null,
      data.returnStatus || 'ON_TIME',
      data.notes || null,
      data.photos || null,
      data.verifiedBy || null,
    ];

    try {
      const res = await client.query(text, values);
      return res.rows[0];
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.upsertReturnVerification');
    }
  }

  /**
   * Create a damage report record.
   *
   * @param {object} data
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async createDamageReport(data, client) {
    const text = `
      INSERT INTO damage_reports (
        booking_id,
        vehicle_id,
        reported_by,
        damage_type,
        description,
        estimated_amount,
        photos,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const values = [
      data.bookingId,
      data.vehicleId,
      data.reportedBy,
      data.damageType || 'ACCIDENT',
      data.description,
      data.estimatedAmount !== undefined ? data.estimatedAmount : 0.00,
      data.photos || null,
      data.status || 'REPORTED',
    ];

    try {
      const res = await client.query(text, values);
      return res.rows[0];
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.createDamageReport');
    }
  }

  /**
   * Find damage reports by booking ID.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findDamageReportsByBookingId(bookingId, client = null) {
    const text = `
      SELECT 
        id,
        booking_id,
        vehicle_id,
        reported_by,
        damage_type,
        description,
        estimated_amount,
        approved_amount,
        status,
        photos,
        created_at,
        updated_at
      FROM damage_reports
      WHERE booking_id = $1
      ORDER BY created_at ASC;
    `;

    try {
      const res = client
        ? await client.query(text, [bookingId])
        : await this.query(text, [bookingId]);
      return res.rows;
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.findDamageReportsByBookingId');
    }
  }

  /**
   * Update late fee and extra KM charges in booking_pricing_snapshots.
   *
   * @param {string} bookingId
   * @param {object} charges
   * @param {number} charges.lateFee
   * @param {number} charges.extraKmFee
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async updatePricingSnapshotCharges(bookingId, { lateFee = 0, extraKmFee = 0 }, client) {
    const text = `
      UPDATE booking_pricing_snapshots
      SET 
        late_fee = $2,
        extra_km_charge = $3,
        total_customer_amount = base_amount + rental_amount + $2 + $3 + security_deposit + taxes_amount - discount_amount
      WHERE booking_id = $1
      RETURNING *;
    `;

    try {
      const res = await client.query(text, [bookingId, lateFee, extraKmFee]);
      return res.rows[0] || null;
    } catch (err) {
      this.handleDbError(err, 'BookingRepository.updatePricingSnapshotCharges');
    }
  }

  /**
   * Fetches payments associated with a booking.
   *
   * @param {string} bookingId
   * @param {object} [client]
   * @returns {Promise<Array<object>>}
   */
  async findPaymentsByBookingId(bookingId, client = null) {
    const text = 'SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC';
    try {
      if (client && typeof client.query === 'function') {
        const res = await client.query(text, [bookingId]);
        return res.rows || [];
      }
      const res = await this.query(text, [bookingId]);
      return res.rows || [];
    } catch {
      return [];
    }
  }
}

module.exports = new BookingRepository();
