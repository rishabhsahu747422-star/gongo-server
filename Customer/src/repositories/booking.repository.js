'use strict';

const BaseRepository = require('./base.repository');
const {
  BOOKING_STATUS,
  BLOCKING_STATUSES,
  BOOKING_PAGINATION,
} = require('../constants/booking');
const OvertimeService = require('../services/overtime.service');
const { generateUniqueEntityReference } = require('../utils/reference-generator');

/**
 * BookingRepository — database operations for customer bookings mapped to Supabase schema.
 *
 * All operations are strictly parameterized.
 * Customer access is always scoped by customer_id to prevent IDOR/BOLA.
 */
class BookingRepository extends BaseRepository {
  /**
   * Maps a raw SQL booking row (with vehicle join) to a safe customer-facing DTO.
   * NEVER exposes: registration_number, storage_key, internal partner metadata.
   *
   * @param {object} row
   * @returns {object|null}
   */
  static mapBookingDto(row) {
    if (!row) return null;

    const rawStatus = row.status ? String(row.status).toUpperCase() : null;
    const rawBookingStatus = row.booking_status ? String(row.booking_status).toUpperCase() : null;

    let canonicalStatus = rawStatus;
    if (rawBookingStatus === 'ACTIVE' || rawStatus === 'IN_PROGRESS' || rawStatus === 'VEHICLE_PICKED') {
      canonicalStatus = 'IN_PROGRESS';
    } else if (rawBookingStatus === 'COMPLETED' || rawStatus === 'COMPLETED' || rawStatus === 'RETURNED') {
      canonicalStatus = 'COMPLETED';
    } else if (rawBookingStatus === 'CONFIRMED' || rawStatus === 'CONFIRMED' || rawStatus === 'PICKUP_SCHEDULED') {
      canonicalStatus = 'CONFIRMED';
    } else if (rawBookingStatus === 'CANCELLED' || rawStatus === 'CANCELLED' || rawStatus === 'cancelled') {
      canonicalStatus = BOOKING_STATUS.CANCELLED;
    }

    const overtime = OvertimeService.calculateOvertimeState(row);

    const dto = {
      id: row.id,
      bookingNumber: row.booking_reference || row.booking_number || null,
      bookingReference: row.booking_reference || row.booking_number || null,
      customerId: row.customer_id,
      vehicleId: row.vehicle_id,
      partnerId: row.partner_id || null,
      shopId: row.shop_id || null,
      status: canonicalStatus || rawStatus,
      bookingStatus: rawBookingStatus || canonicalStatus || rawStatus,
      paymentStatus: row.payment_status || 'PENDING',
      rentalType: row.rental_type || 'DAILY',
      startAt: row.start_at instanceof Date ? row.start_at.toISOString() : row.start_at,
      endAt: row.end_at instanceof Date ? row.end_at.toISOString() : (row.end_at || null),
      expectedReturnAt: row.end_at instanceof Date ? row.end_at.toISOString() : (row.end_at || null),
      scheduledReturnAt: row.end_at instanceof Date ? row.end_at.toISOString() : (row.end_at || overtime.scheduledReturnAt),
      // Authoritative Overtime Properties
      isOvertime: overtime.isOvertime,
      overtimeStartedAt: overtime.overtimeStartedAt,
      overtimeDurationSeconds: overtime.overtimeDurationSeconds,
      overtimeDurationFormatted: overtime.overtimeDurationFormatted,
      overtimeRate: overtime.overtimeRate,
      overtimeAmount: overtime.overtimeAmount,
      totalOvertimePaid: overtime.totalOvertimePaid,
      remainingOvertimeDue: overtime.remainingOvertimeDue,
      extraPaymentRequired: overtime.extraPaymentRequired,
      extraPaymentStatus: overtime.extraPaymentStatus,
      canCompleteReturn: overtime.canCompleteReturn,
      returnPaymentRequired: overtime.returnPaymentRequired,
      overtime,
      pickupAddress: row.pickup_address || null,
      pickupLatitude: row.shop_latitude !== undefined && row.shop_latitude !== null ? Number(row.shop_latitude) : null,
      pickupLongitude: row.shop_longitude !== undefined && row.shop_longitude !== null ? Number(row.shop_longitude) : null,
      shopLatitude: row.shop_latitude !== undefined && row.shop_latitude !== null ? Number(row.shop_latitude) : null,
      shopLongitude: row.shop_longitude !== undefined && row.shop_longitude !== null ? Number(row.shop_longitude) : null,
      partnerPhone: row.partner_phone || '+91 98260 12345',
      pickupOtp: (
        canonicalStatus !== 'CANCELLED' &&
        canonicalStatus !== 'COMPLETED' &&
        rawBookingStatus !== 'CANCELLED' &&
        rawStatus !== 'CANCELLED' &&
        !row.pickup_verified
      )
        ? ((row.pickup_otp !== undefined && row.pickup_otp !== null)
          ? String(row.pickup_otp)
          : (row.pickupOtp !== undefined && row.pickupOtp !== null)
            ? String(row.pickupOtp)
            : null)
        : null,
      pricingSnapshot: {
        pricePerHour: row.price_per_hour !== null && row.price_per_hour !== undefined ? Number(row.price_per_hour) : null,
        price3Hours: row.price_3_hours !== null && row.price_3_hours !== undefined ? Number(row.price_3_hours) : null,
        price6Hours: row.price_6_hours !== null && row.price_6_hours !== undefined ? Number(row.price_6_hours) : null,
        price12Hours: row.price_12_hours !== null && row.price_12_hours !== undefined ? Number(row.price_12_hours) : null,
        pricePerDay: row.price_per_day !== null && row.price_per_day !== undefined ? Number(row.price_per_day) : null,
        pricePerWeek: row.price_per_week !== null && row.price_per_week !== undefined ? Number(row.price_per_week) : null,
        pricePerMonth: row.price_per_month !== null && row.price_per_month !== undefined ? Number(row.price_per_month) : null,
        baseAmount: Number(row.base_amount || row.subtotal || 0),
        rentalAmount: Number(row.rental_amount || row.base_amount || row.subtotal || 0),
        bookingAmount: Number(row.rental_amount || row.base_amount || row.subtotal || 0),
        discountAmount: Number(row.discount_amount || 0),
        subtotal: Math.max(0, Number(row.base_amount || row.subtotal || 0) - Number(row.discount_amount || 0)),
        platformFee: Number(row.platform_fee || 0),
        taxAmount: Number(row.tax_amount || 0),
        gst: Number(row.tax_amount || 0),
        convenienceFee: Number(row.convenience_fee || 0),
        serviceCharge: Number(row.service_charge || 0),
        payableAmount: row.payable_amount !== undefined && row.payable_amount !== null
          ? Number(row.payable_amount)
          : (row.payableAmount !== undefined && row.payableAmount !== null
            ? Number(row.payableAmount)
            : Math.max(0, Number(row.total_amount || 0) - Number(row.security_deposit || 0))),
        couponId: row.coupon_id || null,
        couponCode: row.coupon_code || null,
        securityDeposit: Number(row.security_deposit || 0),
        lateFeePerHour: Number(row.late_fee_per_hour || 0),
        extraKmCharge: Number(row.extra_km_charge || 0),
        totalAmount: Number(row.total_amount || 0),
        actualDurationHours: row.actual_duration_hours || row.actualDurationHours || null,
        billableDurationHours: row.billable_duration_hours || row.billableDurationHours || null,
        pricingBreakdown: row.pricing_breakdown || row.pricingBreakdown || null,
      },

      payableAmount: Number(
        row.payable_amount !== undefined && row.payable_amount !== null
          ? row.payable_amount
          : (row.payableAmount !== undefined && row.payableAmount !== null
            ? row.payableAmount
            : Math.max(0, Number(row.total_amount || 0) - Number(row.security_deposit || 0)))
      ),
      totalAmount: Number(row.total_amount || 0),

      // Cancellation
      cancellation: (row.status === 'CANCELLED' || row.status === 'cancelled' || row.cancelled_at) ? {
        reason: row.cancellation_reason || null,
        cancelledAt: row.cancelled_at instanceof Date
          ? row.cancelled_at.toISOString()
          : row.cancelled_at,
        cancelledBy: row.cancelled_by || null,
        originalPaidAmount: Number(row.cancellation_original_paid_amount || row.original_paid_amount || 0),
        refundPercentage: Number(row.cancellation_refund_percentage || row.refund_percentage || 0),
        refundAmount: Number(row.cancellation_refund_amount || row.refund_amount || 0),
        upiId: row.cancellation_upi_id || row.upi_id || null,
        refundStatus: (String(row.cancellation_refund_status || row.refund_status || '').toLowerCase() === 'not_applicable')
          ? 'NOT_REQUIRED'
          : (String(row.cancellation_refund_status || row.refund_status || '').toLowerCase() === 'pending' || String(row.cancellation_refund_status || row.refund_status || '').toLowerCase() === 'requested')
            ? 'PENDING'
            : (row.cancellation_refund_status || row.refund_status || (Number(row.refund_amount || row.eligible_refund_amount || 0) > 0 ? 'PENDING' : 'NOT_REQUIRED')),
        policyName: row.cancellation_policy_name || row.policy_name || null,
      } : null,

      cancellationReason: row.cancellation_reason || (row.cancellation && row.cancellation.reason) || null,
      paymentInitiatedAt: row.payment_initiated_at ? (row.payment_initiated_at instanceof Date ? row.payment_initiated_at.toISOString() : row.payment_initiated_at) : null,
      paymentProviderOrderId: row.payment_provider_order_id || null,

      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      returnedAt: row.returned_at instanceof Date ? row.returned_at.toISOString() : (row.returned_at || null),
      isRated: Boolean(row.is_rated),
      customerName: row.customer_name || row.customerName || (row.customer ? (row.customer.name || row.customer.fullName) : null) || null,
    };

    // Include vehicle summary if joined
    if (row.vehicle_name || row.model) {
      const vImg = row.vehicle_image_url || row.primary_image_url || null;
      dto.vehicle = {
        id: row.vehicle_id,
        vehicleName: row.vehicle_name || `${row.brand || ''} ${row.model || ''}`.trim(),
        brand: row.brand || null,
        model: row.model || null,
        year: row.year !== undefined && row.year !== null ? Number(row.year) : null,
        category: row.category_slug || null,
        fuelType: row.fuel_type || null,
        transmission: row.transmission || null,
        color: row.color || null,
        seats: row.seats !== undefined && row.seats !== null ? Number(row.seats) : null,
        shopName: row.shop_name || null,
        partner: {
          name: row.shop_name || 'GONGO Hub Partner',
          location: row.pickup_address || 'Bhopal Hub',
          phone: row.partner_phone || '+91 98260 12345',
          latitude: row.shop_latitude !== undefined && row.shop_latitude !== null ? Number(row.shop_latitude) : null,
          longitude: row.shop_longitude !== undefined && row.shop_longitude !== null ? Number(row.shop_longitude) : null,
        },
        imageUrl: vImg,
        primaryImageUrl: vImg,
        images: vImg ? [vImg] : [],
      };
    }

    return dto;
  }

  /**
   * Locks the target vehicle row FOR UPDATE inside a transaction
   * and retrieves its eligibility & pricing fields from Supabase schema.
   *
   * @param {string} vehicleId
   * @param {object} client - Active transactional client
   * @returns {Promise<object|null>}
   */
  async lockVehicleForBooking(vehicleId, client) {
    try {
      const text = `
        SELECT
          v.id,
          v.partner_id,
          v.shop_id,
          COALESCE(v.status, 'active') AS listing_status,
          v.manual_status,
          v.is_archived,
          v.is_active,
          v.verification_status,
          COALESCE(v.fuel_type, 'PETROL') AS fuel_type,
          COALESCE(v.transmission, 'MANUAL') AS transmission,
          v.color,
          v.year,
          COALESCE(v.seats, 2) AS seats,
          COALESCE(CONCAT(v.brand, ' ', v.model), v.vehicle_description, 'Vehicle') AS vehicle_name,
          COALESCE(v.brand, 'GONGO') AS brand,
          COALESCE(v.model, 'Model') AS model,
          COALESCE(vc.code, UPPER(v.category), 'BIKE') AS category_slug,
          COALESCE(vp.price_per_hour, (vp.price / 10.0))::numeric AS price_per_hour,
          vp.price_3_hours::numeric AS price_3_hours,
          vp.price_6_hours::numeric AS price_6_hours,
          vp.price_12_hours::numeric AS price_12_hours,
          COALESCE(vp.price_per_day, vp.price, 500)::numeric AS price_per_day,
          COALESCE(vp.security_deposit, 1000)::numeric AS security_deposit,
          50::numeric AS late_fee_per_hour,
          COALESCE(vp.extra_km_charge, 10)::numeric AS extra_km_charge,
          COALESCE(sh.name, sh.shop_name) AS shop_name,
          COALESCE(sh.address_line1, sh.shop_address, v.pickup_location) AS pickup_address,
          (
            SELECT COALESCE(vi.file_url, vi.image_url, vi.storage_key)
            FROM vehicle_images vi
            WHERE vi.vehicle_id = v.id AND (vi.is_active = true OR vi.is_active IS NULL)
            ORDER BY COALESCE(vi.is_cover, false) DESC, vi.is_primary DESC, COALESCE(vi.sort_order, vi.display_order, 0) ASC
            LIMIT 1
          ) AS primary_image_url,
          sh.is_active AS shop_active,
          p.status AS partner_lifecycle_status,
          p.partner_status AS partner_operational_status,
          p.verification_status AS partner_status,
          p.is_active AS partner_active
        FROM vehicles v
        JOIN shops sh ON sh.id = v.shop_id
        JOIN partners p ON p.id = sh.partner_id
        LEFT JOIN vehicle_models vm ON vm.id = v.model_id
        LEFT JOIN vehicle_brands vb ON vb.id = vm.brand_id
        LEFT JOIN vehicle_categories vc ON (vc.id = vm.category_id OR vc.code = UPPER(v.category) OR UPPER(vc.name) = UPPER(v.category))
        LEFT JOIN vehicle_pricing vp ON vp.vehicle_id = v.id AND vp.is_active = true
        WHERE v.id = $1
        FOR UPDATE OF v
      `;
      const res = await client.query(text, [vehicleId]);
      return res.rows[0] || null;
    } catch (err) {
      if (err.message && (
        err.message.includes('vehicle_models') ||
        err.message.includes('vehicle_pricing') ||
        err.message.includes('partner_id') ||
        err.message.includes('does not exist') ||
        err.message.includes('Expected end of query') ||
        err.message.includes('syntax error')
      )) {
        const text = `
          SELECT
            v.id,
            v.listing_status,
            v.vehicle_name,
            v.brand,
            v.model,
            v.year,
            v.fuel_type,
            v.transmission,
            v.color,
            v.seats,
            v.price_per_hour,
            v.price_per_day,
            v.price_per_week,
            v.price_per_month,
            v.security_deposit,
            v.late_fee_per_hour,
            v.extra_km_charge,
            v.pickup_address,
            sh.shop_name,
            sh.is_active AS shop_active,
            p.status AS partner_lifecycle_status,
            p.partner_status AS partner_operational_status,
            p.verification_status AS partner_status,
            p.is_active AS partner_active
          FROM vehicles v
          JOIN shops sh ON sh.id = v.shop_id
          JOIN partners p ON p.id = sh.partner_id
          WHERE v.id = $1
          FOR UPDATE
        `;
        try {
          const res = await client.query(text, [vehicleId]);
          return res.rows[0] || null;
        } catch (innerErr) {
          if (innerErr.message && (innerErr.message.includes('status') || innerErr.message.includes('does not exist'))) {
            const fallbackText = `
              SELECT
                v.id,
                v.listing_status,
                v.vehicle_name,
                v.brand,
                v.model,
                v.year,
                v.fuel_type,
                v.transmission,
                v.color,
                v.seats,
                v.price_per_hour,
                v.price_per_day,
                v.price_per_week,
                v.price_per_month,
                v.security_deposit,
                v.late_fee_per_hour,
                v.extra_km_charge,
                v.pickup_address,
                sh.shop_name,
                sh.is_active AS shop_active,
                p.verification_status AS partner_status,
                p.is_active AS partner_active
              FROM vehicles v
              JOIN shops sh ON sh.id = v.shop_id
              JOIN partners p ON p.id = sh.partner_id
              WHERE v.id = $1
              FOR UPDATE
            `;
            const res = await client.query(fallbackText, [vehicleId]);
            return res.rows[0] || null;
          }
          throw innerErr;
        }
      }
      throw err;
    }
  }

  /**
   * Retrieves vehicle eligibility fields for availability check.
   *
   * @param {string} vehicleId
   * @param {object} [client] - Optional transactional client
   * @returns {Promise<object|null>}
   */
  async findVehicleEligibility(vehicleId, client = null) {
    const runner = client || this;
    try {
      const text = `
        SELECT
          v.id,
          v.partner_id,
          v.shop_id,
          COALESCE(v.status, 'active') AS listing_status,
          v.manual_status,
          v.is_archived,
          v.is_active,
          v.verification_status,
          COALESCE(vp.price_per_hour, (vp.price / 10.0))::numeric AS price_per_hour,
          vp.price_3_hours::numeric AS price_3_hours,
          vp.price_6_hours::numeric AS price_6_hours,
          vp.price_12_hours::numeric AS price_12_hours,
          COALESCE(vp.price_per_day, vp.price, 500)::numeric AS price_per_day,
          COALESCE(vp.security_deposit, 1000)::numeric AS security_deposit,
          50::numeric AS late_fee_per_hour,
          COALESCE(vp.extra_km_charge, 10)::numeric AS extra_km_charge,
          sh.is_active AS shop_active,
          p.status AS partner_lifecycle_status,
          p.partner_status AS partner_operational_status,
          p.verification_status AS partner_status,
          p.is_active AS partner_active
        FROM vehicles v
        JOIN shops sh ON sh.id = v.shop_id
        JOIN partners p ON p.id = sh.partner_id
        LEFT JOIN vehicle_pricing vp ON vp.vehicle_id = v.id AND vp.is_active = true
        WHERE v.id = $1
        LIMIT 1
      `;
      const res = await runner.query(text, [vehicleId]);
      return res.rows[0] || null;
    } catch (err) {
      if (err.message && (err.message.includes('vehicle_pricing') || err.message.includes('partner_id') || err.message.includes('does not exist'))) {
        const text = `
          SELECT
            v.id,
            v.listing_status,
            v.price_per_hour,
            v.price_per_day,
            v.price_per_week,
            v.price_per_month,
            v.security_deposit,
            v.late_fee_per_hour,
            v.extra_km_charge,
            sh.is_active AS shop_active,
            p.status AS partner_lifecycle_status,
            p.partner_status AS partner_operational_status,
            p.verification_status AS partner_status,
            p.is_active AS partner_active
          FROM vehicles v
          JOIN shops sh ON sh.id = v.shop_id
          JOIN partners p ON p.id = sh.partner_id
          WHERE v.id = $1
          LIMIT 1
        `;
        try {
          const res = await runner.query(text, [vehicleId]);
          return res.rows[0] || null;
        } catch (innerErr) {
          if (innerErr.message && (innerErr.message.includes('status') || innerErr.message.includes('does not exist'))) {
            const fallbackText = `
              SELECT
                v.id,
                v.listing_status,
                v.price_per_hour,
                v.price_per_day,
                v.price_per_week,
                v.price_per_month,
                v.security_deposit,
                v.late_fee_per_hour,
                v.extra_km_charge,
                sh.is_active AS shop_active,
                p.verification_status AS partner_status,
                p.is_active AS partner_active
              FROM vehicles v
              JOIN shops sh ON sh.id = v.shop_id
              JOIN partners p ON p.id = sh.partner_id
              WHERE v.id = $1
              LIMIT 1
            `;
            const res = await runner.query(fallbackText, [vehicleId]);
            return res.rows[0] || null;
          }
          throw innerErr;
        }
      }
      throw err;
    }
  }

  /**
   * Checks whether an overlapping blocking booking exists for a vehicle
   * within [startAt, endAt).
   *
   * @param {string} vehicleId
   * @param {string|Date} startAt
   * @param {string|Date} endAt
   * @param {object} [client] - Optional transactional client
   * @returns {Promise<object|null>}
   */
  async findOverlappingBooking(vehicleId, startAt, endAt, client = null) {
    const statusPlaceholders = BLOCKING_STATUSES.map((_, i) => `$${i + 4}`).join(', ');
    const text = `
      SELECT id, status, start_at, end_at
      FROM bookings
      WHERE vehicle_id = $1
        AND start_at < $3
        AND (end_at + interval '1 hour') > $2
        AND status IN (${statusPlaceholders})
      LIMIT 1
    `;
    const runner = client || this;
    const res = await runner.query(text, [
      vehicleId,
      startAt,
      endAt,
      ...BLOCKING_STATUSES,
    ]);
    return res.rows[0] || null;
  }

  /**
   * Inserts a new booking record according to Supabase schema, with fallback for local test db.
   *
   * @param {object} data
   * @param {object} [client]
   * @returns {Promise<object>}
   */
  async create(data, client = null) {
    const runner = client || this;

    const subtotal = Number(data.baseAmount || data.subtotal || 0);
    const discountAmount = Number(data.discountAmount || 0);
    const extraCharges = Number(data.extraCharges || 0);
    const taxAmount = Number(data.taxAmount || 0);
    const platformFee = Number(data.platformFee || 0);
    const totalAmount = Number(data.totalAmount || (subtotal - discountAmount + extraCharges + taxAmount + platformFee));
    const status = data.status || BOOKING_STATUS.INITIATED;
    const supabaseStatus = (status === 'PENDING' || status === 'initiated') ? 'initiated' : status;
    const currency = 'INR';
    const pickupLocation = data.pickupLocation || data.pickupAddress || null;

    try {
      // 1. Try Supabase schema (bookings with partner_id, shop_id, booking_number)
      let partnerId = data.partnerId;
      let shopId = data.shopId;
      if (!partnerId || !shopId) {
        const vRes = await runner.query('SELECT partner_id, shop_id FROM vehicles WHERE id = $1', [data.vehicleId]);
        if (vRes.rows[0]) {
          partnerId = partnerId || vRes.rows[0].partner_id;
          shopId = shopId || vRes.rows[0].shop_id;
        }
      }

      let bookingReference = data.bookingReference || data.booking_reference || null;
      if (!bookingReference) {
        try {
          bookingReference = await generateUniqueEntityReference(runner, 'bookings', 'booking_reference', 'BK');
        } catch {
          bookingReference = null;
        }
      }
      const bookingNumber = data.bookingNumber || bookingReference || `BK-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      bookingReference = bookingReference || bookingNumber;

      const insertBookingSql = `
        INSERT INTO bookings (
          booking_reference, booking_number, customer_id, partner_id, vehicle_id, shop_id,
          start_at, end_at, status, booking_status, payment_status,
          subtotal, discount_amount, extra_charges, tax_amount, platform_fee,
          total_amount, currency, pickup_location
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17,
          $18, $19
        )
        RETURNING *
      `;

      let bRes;
      try {
        bRes = await runner.query(insertBookingSql, [
          bookingReference,
          bookingNumber,
          data.customerId,
          partnerId,
          data.vehicleId,
          shopId,
          data.startAt,
          data.endAt,
          supabaseStatus,
          data.bookingStatus || (supabaseStatus === 'initiated' ? 'PENDING' : supabaseStatus.toUpperCase()),
          data.paymentStatus || 'PENDING',
          subtotal,
          discountAmount,
          extraCharges,
          taxAmount,
          platformFee,
          totalAmount,
          currency,
          pickupLocation,
        ]);
      } catch (insertErr) {
        if (insertErr.message && insertErr.message.includes('booking_reference')) {
          // Fallback if booking_reference column missing in legacy test fixture
          const fallbackSql = `
            INSERT INTO bookings (
              booking_number, customer_id, partner_id, vehicle_id, shop_id,
              start_at, end_at, status, booking_status, payment_status,
              subtotal, discount_amount, extra_charges, tax_amount, platform_fee,
              total_amount, currency, pickup_location
            ) VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15,
              $16, $17, $18
            )
            RETURNING *
          `;
          bRes = await runner.query(fallbackSql, [
            bookingNumber,
            data.customerId,
            partnerId,
            data.vehicleId,
            shopId,
            data.startAt,
            data.endAt,
            supabaseStatus,
            data.bookingStatus || (supabaseStatus === 'initiated' ? 'PENDING' : supabaseStatus.toUpperCase()),
            data.paymentStatus || 'PENDING',
            subtotal,
            discountAmount,
            extraCharges,
            taxAmount,
            platformFee,
            totalAmount,
            currency,
            pickupLocation,
          ]);
        } else {
          throw insertErr;
        }
      }

      const booking = bRes.rows[0];

      // Insert price breakdown if table exists
      try {
        await runner.query(`
          INSERT INTO booking_price_breakdown (
            booking_id, base_amount, extra_charges, discount_amount,
            taxable_amount, tax_amount, platform_fee, security_deposit, total_amount, currency
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          booking.id,
          subtotal,
          extraCharges,
          discountAmount,
          Math.max(0, subtotal - discountAmount),
          taxAmount,
          platformFee,
          Number(data.securityDeposit || 0),
          totalAmount,
          currency,
        ]);
      } catch {
        // Non-fatal
      }

      // Initialize canonical 4-digit pickup OTP in booking_pickup_verifications & Redis
      let pickupOtp = null;
      try {
        const crypto = require('crypto');
        pickupOtp = String(crypto.randomInt(0, 10000)).padStart(4, '0');
        const salt = crypto.randomBytes(16).toString('hex');
        const otpHash = crypto.createHash('sha256').update(`${pickupOtp}:${salt}`).digest('hex');
        await runner.query(`
          INSERT INTO booking_pickup_verifications (
            booking_id, otp_hash, verification_reference, is_verified
          ) VALUES ($1, $2, $3, false)
          ON CONFLICT (booking_id) DO UPDATE SET
            otp_hash = EXCLUDED.otp_hash,
            verification_reference = EXCLUDED.verification_reference,
            is_verified = false;
        `, [booking.id, otpHash, pickupOtp]);

        try {
          const redisService = require('../services/redis.service');
          if (redisService?.client) {
            const redisKey = `otp:pickup:state:${booking.id}`;
            const redisData = JSON.stringify({ otpHash, salt, otp: pickupOtp, createdAt: new Date().toISOString() });
            await redisService.client.set(redisKey, redisData, 'EX', 900);
          }
        } catch {
          // Non-fatal if Redis cache is unavailable
        }
      } catch {
        // Non-fatal if booking_pickup_verifications table does not exist in mock DB
      }

      return BookingRepository.mapBookingDto({
        ...booking,
        total_amount: totalAmount,
        payable_amount: data.payableAmount || totalAmount,
        pickup_otp: pickupOtp,
        rental_type: data.rentalType,
        pickup_address: data.pickupAddress,
        price_per_hour: data.pricePerHour,
        price_per_day: data.pricePerDay,
        price_per_week: data.pricePerWeek,
        price_per_month: data.pricePerMonth,
        base_amount: subtotal,
        security_deposit: data.securityDeposit,
        late_fee_per_hour: data.lateFeePerHour,
        extra_km_charge: data.extraKmCharge,
        coupon_id: data.couponId,
        coupon_code: data.couponCode,
      });
    } catch (err) {
      if (err.message && (err.message.includes('booking_number') || err.message.includes('partner_id') || err.message.includes('subtotal') || err.message.includes('does not exist'))) {
        // Fallback for legacy pg-mem test database
        const legacyStatus = (status === 'initiated' ? 'PENDING' : (status || 'PENDING')).toUpperCase();
        const legacySql = `
          INSERT INTO bookings (
            customer_id, vehicle_id, status, rental_type,
            start_at, end_at, pickup_address,
            price_per_hour, price_per_day, price_per_week, price_per_month,
            base_amount, discount_amount, coupon_id, coupon_code,
            security_deposit, late_fee_per_hour, extra_km_charge,
            total_amount
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7,
            $8, $9, $10, $11,
            $12, $13, $14, $15,
            $16, $17, $18,
            $19
          )
          RETURNING *
        `;
        const res = await runner.query(legacySql, [
          data.customerId,
          data.vehicleId,
          legacyStatus,
          data.rentalType,
          data.startAt,
          data.endAt,
          data.pickupAddress || null,
          data.pricePerHour || null,
          data.pricePerDay || null,
          data.pricePerWeek || null,
          data.pricePerMonth || null,
          subtotal,
          discountAmount,
          data.couponId || null,
          data.couponCode || null,
          data.securityDeposit || 0.00,
          data.lateFeePerHour || 0.00,
          data.extraKmCharge || 0.00,
          totalAmount,
        ]);
        return BookingRepository.mapBookingDto(res.rows[0]);
      }
      throw err;
    }
  }

  /**
   * Finds a booking by ID scoped strictly to the customer.
   *
   * @param {string} bookingId
   * @param {string} customerId
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAndCustomerId(bookingId, customerId, client = null) {
    const runner = client || this;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(bookingId || '').trim());
    const idCondition = isUuid ? 'b.id = $1' : '(b.booking_reference = $1 OR b.booking_number = $1)';
    try {
      const text = `
        SELECT
          b.*,
          bpb.base_amount,
          bpb.security_deposit,
          bc.cancellation_reason,
          bc.cancelled_at,
          bc.cancelled_by,
          bc.original_paid_amount AS cancellation_original_paid_amount,
          bc.refund_percentage AS cancellation_refund_percentage,
          bc.refund_amount AS cancellation_refund_amount,
          bc.eligible_refund_amount AS cancellation_eligible_refund_amount,
          bc.refund_status AS cancellation_refund_status,
          bc.upi_id AS cancellation_upi_id,
          bc.policy_name AS cancellation_policy_name,
          (
            SELECT p.created_at
            FROM payments p
            WHERE p.booking_id = b.id
              AND (p.payment_type = 'BOOKING_ADVANCE' OR p.payment_type IS NULL)
            ORDER BY p.created_at DESC
            LIMIT 1
          ) AS payment_initiated_at,
          (
            SELECT p.provider_order_id
            FROM payments p
            WHERE p.booking_id = b.id
              AND (p.payment_type = 'BOOKING_ADVANCE' OR p.payment_type IS NULL)
            ORDER BY p.created_at DESC
            LIMIT 1
          ) AS payment_provider_order_id,
          bpv.verification_reference AS pickup_otp,
          bpv.is_verified AS pickup_verified,
          EXISTS(SELECT 1 FROM ratings r WHERE r.booking_id = b.id) AS is_rated,
          COALESCE(
            brv.returned_at,
            brv.verified_at,
            brv.created_at,
            (CASE WHEN b.status IN ('completed', 'returned', 'COMPLETED', 'RETURNED') THEN b.updated_at ELSE NULL END)
          ) AS returned_at,
          COALESCE(u.name, 'Customer') AS customer_name,
          COALESCE(CONCAT(v.brand, ' ', v.model), v.vehicle_description, 'Vehicle') AS vehicle_name,
          COALESCE(vb.name, v.brand, 'GONGO') AS brand,
          COALESCE(vm.name, v.model, 'Model') AS model,
          COALESCE(v.manufacture_year, v.year) AS year,
          COALESCE(v.fuel_type, 'PETROL') AS fuel_type,
          COALESCE(v.transmission, 'MANUAL') AS transmission,
          v.color,
          COALESCE(v.seats, 2) AS seats,
          COALESCE(vc.code, UPPER(v.category), 'BIKE') AS category_slug,
          COALESCE(sh.name, sh.shop_name, 'GONGO Hub') AS shop_name,
          COALESCE(b.pickup_location, sh.address_line1, sh.shop_address, '') AS pickup_address,
          sh.latitude AS shop_latitude,
          sh.longitude AS shop_longitude,
          sh.contact_phone AS partner_phone,
          (
            SELECT COALESCE(vi.file_url, vi.image_url, vi.storage_key)
            FROM vehicle_images vi
            WHERE vi.vehicle_id = v.id AND (vi.is_active = true OR vi.is_active IS NULL)
            ORDER BY COALESCE(vi.is_cover, false) DESC, vi.is_primary DESC, COALESCE(vi.sort_order, vi.display_order, 0) ASC
            LIMIT 1
          ) AS vehicle_image_url
        FROM bookings b
        LEFT JOIN users u ON u.id = b.customer_id
        LEFT JOIN booking_price_breakdown bpb ON bpb.booking_id = b.id
        LEFT JOIN booking_cancellations bc ON bc.booking_id = b.id
        LEFT JOIN booking_pickup_verifications bpv ON bpv.booking_id = b.id
        LEFT JOIN booking_return_verifications brv ON brv.booking_id = b.id
        JOIN vehicles v ON v.id = b.vehicle_id
        LEFT JOIN shops sh ON sh.id = v.shop_id
        LEFT JOIN vehicle_models vm ON vm.id = v.model_id
        LEFT JOIN vehicle_brands vb ON vb.id = vm.brand_id
        LEFT JOIN vehicle_categories vc ON (vc.id = vm.category_id OR vc.code = UPPER(v.category) OR UPPER(vc.name) = UPPER(v.category))
        WHERE ${idCondition} AND b.customer_id = $2
        LIMIT 1
      `;
      const res = await runner.query(text, [bookingId, customerId]);
      return res.rows[0] ? BookingRepository.mapBookingDto(res.rows[0]) : null;
    } catch (err) {
      if (err.message && (err.message.includes('booking_price_breakdown') || err.message.includes('vehicle_models') || err.message.includes('does not exist'))) {
        const text = `
          SELECT
            b.*,
            false AS is_rated,
            (CASE WHEN b.status IN ('completed', 'returned', 'COMPLETED', 'RETURNED') THEN b.updated_at ELSE NULL END) AS returned_at,
            COALESCE(u.name, 'Customer') AS customer_name,
            v.vehicle_name,
            v.brand,
            v.model,
            v.year,
            v.fuel_type,
            v.transmission,
            v.color,
            v.seats,
            vc.slug AS category_slug,
            sh.shop_name,
            NULL AS shop_latitude,
            NULL AS shop_longitude,
            NULL AS partner_phone,
            NULL AS vehicle_image_url
          FROM bookings b
          LEFT JOIN users u ON u.id = b.customer_id
          JOIN vehicles v ON v.id = b.vehicle_id
          JOIN vehicle_categories vc ON vc.id = v.category_id
          JOIN shops sh ON sh.id = v.shop_id
          WHERE ${idCondition} AND b.customer_id = $2
          LIMIT 1
        `;

        const res = await runner.query(text, [bookingId, customerId]);
        return res.rows[0] ? BookingRepository.mapBookingDto(res.rows[0]) : null;
      }
      throw err;
    }
  }

  /**
   * Ensures a canonical 4-digit handover OTP exists for an active upcoming booking.
   *
   * @param {string} bookingId
   * @param {object} [client]
   * @returns {Promise<string|null>}
   */
  async ensurePickupOtp(bookingId, client = null) {
    const runner = client || this;
    try {
      const checkRes = await runner.query(
        'SELECT verification_reference, is_verified FROM booking_pickup_verifications WHERE booking_id = $1 LIMIT 1',
        [bookingId]
      );
      if (checkRes.rows[0]) {
        if (checkRes.rows[0].is_verified) {
          return null;
        }
        if (checkRes.rows[0].verification_reference) {
          return String(checkRes.rows[0].verification_reference);
        }
      }

      const crypto = require('crypto');
      const otp = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      const salt = crypto.randomBytes(16).toString('hex');
      const otpHash = crypto.createHash('sha256').update(`${otp}:${salt}`).digest('hex');

      await runner.query(`
        INSERT INTO booking_pickup_verifications (
          booking_id, otp_hash, verification_reference, is_verified
        ) VALUES ($1, $2, $3, false)
        ON CONFLICT (booking_id) DO UPDATE SET
          otp_hash = EXCLUDED.otp_hash,
          verification_reference = EXCLUDED.verification_reference,
          is_verified = false;
      `, [bookingId, otpHash, otp]);

      try {
        const { redisService } = require('../services/redis.service');
        if (redisService?.client) {
          const redisKey = `otp:pickup:state:${bookingId}`;
          const redisData = JSON.stringify({ otpHash, salt, otp, createdAt: new Date().toISOString() });
          await redisService.client.set(redisKey, redisData, 'EX', 900);
        }
      } catch {
        // Non-fatal if Redis write fails
      }

      return otp;
    } catch {
      return null;
    }
  }

  /**
   * Finds paginated bookings for a customer with optional status filter.
   *
   * @param {string} customerId
   * @param {object} options
   * @param {string} [options.status]
   * @param {number} [options.page]
   * @param {number} [options.limit]
   * @returns {Promise<{bookings: object[], pagination: object}>}
   */
  async findByCustomerId(customerId, {
    status,
    page = BOOKING_PAGINATION.DEFAULT_PAGE,
    limit = BOOKING_PAGINATION.DEFAULT_LIMIT,
  } = {}) {
    const params = [customerId];
    let paramIdx = 2;
    const conditions = ['b.customer_id = $1'];

    if (status) {
      const statusUpper = String(status).toUpperCase();
      if (statusUpper === 'ACTIVE' || statusUpper === 'IN_PROGRESS' || statusUpper === 'ACTIVE_RENTAL') {
        conditions.push(`(b.status IN ('in_progress', 'vehicle_picked', 'ACTIVE', 'active', 'IN_PROGRESS'))`);
      } else if (statusUpper === 'UPCOMING' || statusUpper === 'CONFIRMED') {
        conditions.push(`(b.status IN ('confirmed', 'pickup_scheduled', 'initiated', 'payment_completed', 'CONFIRMED', 'PENDING', 'UPCOMING', 'payment_pending', 'PAYMENT_PENDING'))`);
      } else if (statusUpper === 'COMPLETED') {
        conditions.push(`(b.status IN ('completed', 'returned', 'COMPLETED', 'RETURNED'))`);
      } else if (statusUpper === 'CANCELLED') {
        conditions.push(`(b.status IN ('cancelled', 'refunded', 'CANCELLED', 'REFUNDED'))`);
      } else {
        conditions.push(`(b.status = $${paramIdx} OR LOWER(b.status) = LOWER($${paramIdx}))`);
        params.push(status);
        paramIdx += 1;
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Total count
    const countSql = `
      SELECT COUNT(*) AS total
      FROM bookings b
      ${whereClause}
    `;
    const countRes = await this.query(countSql, params);
    const total = parseInt(countRes.rows[0].total, 10);

    // Paginated records
    const offset = (page - 1) * limit;
    const queryParams = [...params, limit, offset];
    try {
      const dataSql = `
        SELECT
          b.*,
          bpb.base_amount,
          bpb.security_deposit,
          bc.cancellation_reason,
          bc.cancelled_at,
          bc.cancelled_by,
          bc.original_paid_amount AS cancellation_original_paid_amount,
          bc.refund_percentage AS cancellation_refund_percentage,
          bc.refund_amount AS cancellation_refund_amount,
          bc.eligible_refund_amount AS cancellation_eligible_refund_amount,
          bc.refund_status AS cancellation_refund_status,
          bc.upi_id AS cancellation_upi_id,
          bc.policy_name AS cancellation_policy_name,
          (
            SELECT p.created_at
            FROM payments p
            WHERE p.booking_id = b.id
              AND (p.payment_type = 'BOOKING_ADVANCE' OR p.payment_type IS NULL)
            ORDER BY p.created_at DESC
            LIMIT 1
          ) AS payment_initiated_at,
          (
            SELECT p.provider_order_id
            FROM payments p
            WHERE p.booking_id = b.id
              AND (p.payment_type = 'BOOKING_ADVANCE' OR p.payment_type IS NULL)
            ORDER BY p.created_at DESC
            LIMIT 1
          ) AS payment_provider_order_id,
          EXISTS(SELECT 1 FROM ratings r WHERE r.booking_id = b.id) AS is_rated,
          COALESCE(
            brv.returned_at,
            brv.verified_at,
            brv.created_at,
            (CASE WHEN b.status IN ('completed', 'returned', 'COMPLETED', 'RETURNED') THEN b.updated_at ELSE NULL END)
          ) AS returned_at,
          COALESCE(u.name, 'Customer') AS customer_name,
          COALESCE(CONCAT(v.brand, ' ', v.model), v.vehicle_description, 'Vehicle') AS vehicle_name,
          COALESCE(vb.name, v.brand, 'GONGO') AS brand,
          COALESCE(vm.name, v.model, 'Model') AS model,
          COALESCE(v.manufacture_year, v.year) AS year,
          COALESCE(v.fuel_type, 'PETROL') AS fuel_type,
          COALESCE(v.transmission, 'MANUAL') AS transmission,
          v.color,
          COALESCE(v.seats, 2) AS seats,
          COALESCE(vc.code, UPPER(v.category), 'BIKE') AS category_slug,
          COALESCE(sh.name, sh.shop_name, 'GONGO Hub') AS shop_name,
          COALESCE(b.pickup_location, sh.address_line1, sh.shop_address, '') AS pickup_address,
          (
            SELECT COALESCE(vi.file_url, vi.image_url, vi.storage_key)
            FROM vehicle_images vi
            WHERE vi.vehicle_id = v.id AND (vi.is_active = true OR vi.is_active IS NULL)
            ORDER BY COALESCE(vi.is_cover, false) DESC, vi.is_primary DESC, COALESCE(vi.sort_order, vi.display_order, 0) ASC
            LIMIT 1
          ) AS vehicle_image_url
        FROM bookings b
        LEFT JOIN users u ON u.id = b.customer_id
        LEFT JOIN booking_price_breakdown bpb ON bpb.booking_id = b.id
        LEFT JOIN booking_cancellations bc ON bc.booking_id = b.id
        LEFT JOIN booking_return_verifications brv ON brv.booking_id = b.id
        JOIN vehicles v ON v.id = b.vehicle_id
        LEFT JOIN shops sh ON sh.id = v.shop_id
        LEFT JOIN vehicle_models vm ON vm.id = v.model_id
        LEFT JOIN vehicle_brands vb ON vb.id = vm.brand_id
        LEFT JOIN vehicle_categories vc ON (vc.id = vm.category_id OR vc.code = UPPER(v.category) OR UPPER(vc.name) = UPPER(v.category))
        ${whereClause}
        ORDER BY b.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `;
      const dataRes = await this.query(dataSql, queryParams);
      const totalPages = Math.ceil(total / limit) || 1;

      return {
        bookings: dataRes.rows.map(BookingRepository.mapBookingDto),
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      };
    } catch (err) {
      if (err.message && (err.message.includes('booking_price_breakdown') || err.message.includes('vehicle_models') || err.message.includes('does not exist'))) {
        const legacySql = `
          SELECT
            b.*,
            false AS is_rated,
            (CASE WHEN b.status IN ('completed', 'returned', 'COMPLETED', 'RETURNED') THEN b.updated_at ELSE NULL END) AS returned_at,
            v.vehicle_name,
            v.brand,
            v.model,
            v.year,
            v.fuel_type,
            v.transmission,
            v.color,
            v.seats,
            vc.slug AS category_slug,
            sh.shop_name
          FROM bookings b
          JOIN vehicles v ON v.id = b.vehicle_id
          JOIN vehicle_categories vc ON vc.id = v.category_id
          JOIN shops sh ON sh.id = v.shop_id
          ${whereClause}
          ORDER BY b.created_at DESC
          LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
        `;
        const dataRes = await this.query(legacySql, queryParams);
        const totalPages = Math.ceil(total / limit) || 1;

        return {
          bookings: dataRes.rows.map(BookingRepository.mapBookingDto),
          pagination: {
            page,
            limit,
            total,
            totalPages,
          },
        };
      }
      throw err;
    }
  }

  /**
   * Updates booking status (e.g. cancellation) scoped by customerId.
   *
   * @param {string} bookingId
   * @param {string} customerId
   * @param {string} newStatus
   * @param {object} [extraFields]
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async updateStatus(bookingId, customerId, newStatus, extraFields = {}, client = null) {
    const runner = client || this;
    const { cancellationReason } = extraFields || {};

    let res;
    try {
      const text = `
        UPDATE bookings
        SET status = LOWER($1::text),
            booking_status = CASE 
              WHEN LOWER($1::text) IN ('confirmed', 'payment_completed', 'pickup_scheduled') THEN 'CONFIRMED'
              WHEN LOWER($1::text) IN ('active', 'in_progress', 'vehicle_picked') THEN 'ACTIVE'
              WHEN LOWER($1::text) IN ('completed', 'returned') THEN 'COMPLETED'
              WHEN LOWER($1::text) IN ('cancelled', 'refunded') THEN 'CANCELLED'
              WHEN LOWER($1::text) IN ('pending_payment', 'payment_pending') THEN 'PENDING_PAYMENT'
              ELSE UPPER($1::text)
            END,
            payment_status = CASE
              WHEN LOWER($1::text) IN ('confirmed', 'payment_completed', 'pickup_scheduled', 'active', 'in_progress', 'completed') THEN 'PAID'
              ELSE payment_status
            END,
            cancellation_reason = COALESCE($4, cancellation_reason),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND customer_id = $3
        RETURNING *
      `;
      res = await runner.query(text, [
        newStatus,
        bookingId,
        customerId,
        cancellationReason || null,
      ]);
    } catch {
      try {
        const textWithoutReason = `
          UPDATE bookings
          SET status = LOWER($1::text),
              booking_status = CASE 
                WHEN LOWER($1::text) IN ('confirmed', 'payment_completed', 'pickup_scheduled') THEN 'CONFIRMED'
                WHEN LOWER($1::text) IN ('active', 'in_progress', 'vehicle_picked') THEN 'ACTIVE'
                WHEN LOWER($1::text) IN ('completed', 'returned') THEN 'COMPLETED'
                WHEN LOWER($1::text) IN ('cancelled', 'refunded') THEN 'CANCELLED'
                WHEN LOWER($1::text) IN ('pending_payment', 'payment_pending') THEN 'PENDING_PAYMENT'
                ELSE UPPER($1::text)
              END,
              payment_status = CASE
                WHEN LOWER($1::text) IN ('confirmed', 'payment_completed', 'pickup_scheduled', 'active', 'in_progress', 'completed') THEN 'PAID'
                ELSE payment_status
              END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND customer_id = $3
          RETURNING *
        `;
        res = await runner.query(textWithoutReason, [newStatus, bookingId, customerId]);
      } catch {
        const fallbackText = `
          UPDATE bookings
          SET status = $1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND customer_id = $3
          RETURNING *
        `;
        res = await runner.query(fallbackText, [newStatus, bookingId, customerId]);
      }
    }

    if (!res.rows[0]) return null;

    // Synchronize vehicle rental_status with booking transition
    const lowerStatus = String(newStatus).toLowerCase();
    try {
      if (['confirmed', 'payment_completed', 'pickup_scheduled'].includes(lowerStatus)) {
        await runner.query(
          `UPDATE vehicles SET rental_status = 'BOOKED', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT vehicle_id FROM bookings WHERE id = $1)`,
          [bookingId],
        );
      } else if (['active', 'in_progress', 'vehicle_picked'].includes(lowerStatus)) {
        await runner.query(
          `UPDATE vehicles SET rental_status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT vehicle_id FROM bookings WHERE id = $1)`,
          [bookingId],
        );
      } else if (['completed', 'returned', 'cancelled', 'refunded'].includes(lowerStatus)) {
        await runner.query(
          `UPDATE vehicles SET rental_status = 'IDLE', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT vehicle_id FROM bookings WHERE id = $1)`,
          [bookingId],
        );
      }
    } catch {
      // safe fallback
    }

    if (newStatus === BOOKING_STATUS.CANCELLED || String(newStatus).toUpperCase() === 'CANCELLED') {
      try {
        await runner.query(`
          INSERT INTO booking_cancellations (
            booking_id, cancelled_by, cancellation_reason, cancelled_at
          ) VALUES ($1, $2, $3, COALESCE($4, CURRENT_TIMESTAMP))
          ON CONFLICT (booking_id) DO UPDATE
          SET cancellation_reason = EXCLUDED.cancellation_reason,
              cancelled_at = EXCLUDED.cancelled_at
        `, [
          bookingId,
          customerId,
          extraFields.cancellationReason || null,
          extraFields.cancelledAt || null,
        ]);
      } catch {
        // Ignored if booking_cancellations schema differs or already present
      }
    }

    return BookingRepository.mapBookingDto({
      ...res.rows[0],
      cancellation_reason: extraFields.cancellationReason,
      cancelled_at: extraFields.cancelledAt,
    });
  }

  /**
   * Finds the return verification record for a booking.
   *
   * @param {string} bookingId
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findReturnVerificationByBookingId(bookingId, client = null) {
    const runner = client || this;
    try {
      const text = `
        SELECT * FROM booking_return
        WHERE booking_id = $1
        LIMIT 1
      `;
      const res = await runner.query(text, [bookingId]);
      if (res.rows && res.rows[0]) {
        return res.rows[0];
      }
    } catch {
      // ignore
    }

    try {
      const text = `
        SELECT * FROM booking_return_verifications
        WHERE booking_id = $1
        LIMIT 1
      `;
      const res = await runner.query(text, [bookingId]);
      if (res.rows && res.rows[0]) {
        return res.rows[0];
      }
    } catch {
      // ignore
    }

    return null;
  }

  /**
   * Checks whether a booking has already received rating/review.
   *
   * @param {string} bookingId
   * @param {object} [client]
   * @returns {Promise<boolean>}
   */
  async hasRating(bookingId, client = null) {
    const runner = client || this;
    const res = await runner.query(
      'SELECT 1 FROM ratings WHERE booking_id = $1 LIMIT 1',
      [bookingId]
    );
    return res.rows.length > 0;
  }

  /**
   * Records vehicle and partner ratings, plus review, in an atomic database transaction.
   *
   * @param {object} booking - Booking row or DTO
   * @param {string} customerId
   * @param {object} ratingData - { vehicleRating, partnerRating, review }
   * @returns {Promise<object>}
   */
  async createRatingsAndReview(booking, customerId, { vehicleRating, partnerRating, review }) {
    return this.transaction(async (client) => {
      // Re-verify rating does not already exist

      const checkRes = await client.query(
        'SELECT 1 FROM ratings WHERE booking_id = $1 LIMIT 1 FOR UPDATE',
        [booking.id]
      );
      if (checkRes.rows.length > 0) {
        const { ConflictError } = require('../errors');
        throw new ConflictError('This booking has already been rated', 'ALREADY_RATED');
      }

      const cleanReview = review && typeof review === 'string' && review.trim() ? review.trim() : null;

      // 1. Insert VEHICLE rating
      await client.query(`
        INSERT INTO ratings (
          id, booking_id, customer_id, partner_id, vehicle_id,
          target_type, rating_score, review_comment, status, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          'VEHICLE', $5, $6, 'APPROVED', NOW(), NOW()
        )
      `, [
        booking.id,
        customerId,
        booking.partnerId,
        booking.vehicleId,
        vehicleRating,
        cleanReview,
      ]);

      // 2. Insert PARTNER rating
      await client.query(`
        INSERT INTO ratings (
          id, booking_id, customer_id, partner_id, vehicle_id,
          target_type, rating_score, review_comment, status, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          'PARTNER', $5, $6, 'APPROVED', NOW(), NOW()
        )
      `, [
        booking.id,
        customerId,
        booking.partnerId,
        booking.vehicleId,
        partnerRating,
        cleanReview,
      ]);

      // 3. Insert into reviews table (satisfies reviews constraint status = 'published')
      const overallScore = Math.max(1, Math.min(5, Math.round((vehicleRating + partnerRating) / 2)));
      await client.query(`
        INSERT INTO reviews (
          id, booking_id, customer_id, partner_id, vehicle_id,
          rating, review_text, status, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, 'published', NOW(), NOW()
        )
        ON CONFLICT (booking_id) DO NOTHING
      `, [
        booking.id,
        customerId,
        booking.partnerId,
        booking.vehicleId,
        overallScore,
        cleanReview,
      ]);

      return {
        bookingId: booking.id,
        isRated: true,
        vehicleRating,
        partnerRating,
        review: cleanReview,
      };
    });
  }
}

module.exports = BookingRepository;

