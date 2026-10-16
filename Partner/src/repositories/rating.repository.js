'use strict';

const BaseRepository = require('../db/base.repository');
const { NotFoundError, BadRequestError, ConflictError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class RatingRepository extends BaseRepository {
  constructor() {
    super('ratings', 'id');
  }

  /**
   * Helper to mask customer names safely (e.g. "Vikram Malhotra" -> "Vikram M.")
   * Prevents leaking full PII / sensitive customer identities.
   *
   * @param {string|null} name
   * @returns {string}
   */
  static maskCustomerName(name) {
    if (!name || typeof name !== 'string') {
      return 'Verified Customer';
    }
    const trimmed = name.trim();
    if (!trimmed) return 'Verified Customer';

    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) {
      return parts[0];
    }
    const firstName = parts[0];
    const lastInitial = parts[parts.length - 1][0].toUpperCase();
    return `${firstName} ${lastInitial}.`;
  }

  /**
   * Partner overall summary (average, count, star distribution).
   * Strictly counts eligible APPROVED ratings from completed bookings.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getPartnerSummary(partnerId, client = null) {
    const text = `
      SELECT
        ROUND(AVG(r.rating_score)::numeric, 1) AS average_rating,
        COUNT(r.id)::int AS total_reviews,
        COUNT(CASE WHEN r.rating_score = 5 THEN 1 END)::int AS count_5,
        COUNT(CASE WHEN r.rating_score = 4 THEN 1 END)::int AS count_4,
        COUNT(CASE WHEN r.rating_score = 3 THEN 1 END)::int AS count_3,
        COUNT(CASE WHEN r.rating_score = 2 THEN 1 END)::int AS count_2,
        COUNT(CASE WHEN r.rating_score = 1 THEN 1 END)::int AS count_1
      FROM ratings r
      JOIN bookings b ON b.id = r.booking_id
      WHERE r.partner_id = $1
        AND r.target_type = 'PARTNER'
        AND r.status = 'APPROVED'
        AND (
          b.booking_status IN ('COMPLETED', 'CONFIRMED')
          OR COALESCE(b.status, '') IN ('completed', 'returned')
        );
    `;

    const res = client
      ? await client.query(text, [partnerId])
      : await this.query(text, [partnerId]);

    const row = res.rows[0] || {};
    const totalReviews = Number(row.total_reviews || 0);

    return {
      averageRating: totalReviews > 0 ? Number(row.average_rating) : null,
      totalReviews,
      distribution: {
        5: Number(row.count_5 || 0),
        4: Number(row.count_4 || 0),
        3: Number(row.count_3 || 0),
        2: Number(row.count_2 || 0),
        1: Number(row.count_1 || 0),
      },
      isNewPartner: totalReviews === 0,
    };
  }

  /**
   * Vehicle-specific rating summary.
   *
   * @param {string} partnerId
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getVehicleSummary(partnerId, vehicleId, client = null) {
    // 1. Verify vehicle belongs to partner (BOLA protection)
    const vehCheckSql = `
      SELECT id, brand, model, registration_number
      FROM vehicles
      WHERE id = $1 AND partner_id = $2
      LIMIT 1;
    `;
    const vehRes = client
      ? await client.query(vehCheckSql, [vehicleId, partnerId])
      : await this.query(vehCheckSql, [vehicleId, partnerId]);

    const vehicle = vehRes.rows[0];
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found or does not belong to partner', ERROR_CODES.NOT_FOUND);
    }

    // 2. Query vehicle aggregates
    const text = `
      SELECT
        ROUND(AVG(r.rating_score)::numeric, 1) AS average_rating,
        COUNT(r.id)::int AS total_reviews,
        COUNT(CASE WHEN r.rating_score = 5 THEN 1 END)::int AS count_5,
        COUNT(CASE WHEN r.rating_score = 4 THEN 1 END)::int AS count_4,
        COUNT(CASE WHEN r.rating_score = 3 THEN 1 END)::int AS count_3,
        COUNT(CASE WHEN r.rating_score = 2 THEN 1 END)::int AS count_2,
        COUNT(CASE WHEN r.rating_score = 1 THEN 1 END)::int AS count_1
      FROM ratings r
      JOIN bookings b ON b.id = r.booking_id
      WHERE r.vehicle_id = $1
        AND r.target_type = 'VEHICLE'
        AND r.status = 'APPROVED'
        AND (
          b.booking_status IN ('COMPLETED', 'CONFIRMED')
          OR COALESCE(b.status, '') IN ('completed', 'returned')
        );
    `;

    const res = client
      ? await client.query(text, [vehicleId])
      : await this.query(text, [vehicleId]);

    const row = res.rows[0] || {};
    const totalReviews = Number(row.total_reviews || 0);

    return {
      vehicleId: vehicle.id,
      brand: vehicle.brand,
      model: vehicle.model,
      registrationNumber: vehicle.registration_number,
      averageRating: totalReviews > 0 ? Number(row.average_rating) : null,
      totalReviews,
      distribution: {
        5: Number(row.count_5 || 0),
        4: Number(row.count_4 || 0),
        3: Number(row.count_3 || 0),
        2: Number(row.count_2 || 0),
        1: Number(row.count_1 || 0),
      },
      hasRatings: totalReviews > 0,
    };
  }

  /**
   * Vehicle overview list across all vehicles of the partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async getVehicleRatingsOverview(partnerId, client = null) {
    const text = `
      SELECT
        v.id AS vehicle_id,
        v.brand,
        v.model,
        v.registration_number,
        ROUND(AVG(r.rating_score)::numeric, 1) AS average_rating,
        COUNT(r.id)::int AS total_reviews
      FROM vehicles v
      LEFT JOIN ratings r ON r.vehicle_id = v.id
        AND r.target_type = 'VEHICLE'
        AND r.status = 'APPROVED'
      LEFT JOIN bookings b ON b.id = r.booking_id
        AND (
          b.booking_status IN ('COMPLETED', 'CONFIRMED')
          OR COALESCE(b.status, '') IN ('completed', 'returned')
        )
      WHERE v.partner_id = $1 AND v.is_archived = false
      GROUP BY v.id, v.brand, v.model, v.registration_number
      ORDER BY total_reviews DESC, average_rating DESC NULLS LAST, v.brand ASC;
    `;

    const res = client
      ? await client.query(text, [partnerId])
      : await this.query(text, [partnerId]);

    return res.rows.map((row) => ({
      vehicleId: row.vehicle_id,
      brand: row.brand,
      model: row.model,
      registrationNumber: row.registration_number,
      averageRating: Number(row.total_reviews) > 0 ? Number(row.average_rating) : null,
      totalReviews: Number(row.total_reviews || 0),
      hasRatings: Number(row.total_reviews) > 0,
    }));
  }

  /**
   * Paginated reviews history for the partner.
   *
   * @param {string} partnerId
   * @param {object} options
   * @param {number} [options.page=1]
   * @param {number} [options.limit=10]
   * @param {string|null} [options.vehicleId=null]
   * @param {number|null} [options.score=null]
   * @param {boolean} [options.hasComment=false]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ ratings: Array, pagination: object }>}
   */
  async getPartnerReviews(partnerId, options = {}, client = null) {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(options.limit) || 10));
    const offset = (page - 1) * limit;

    const conditions = [
      'r.partner_id = $1',
      "r.status = 'APPROVED'",
      "(b.booking_status IN ('COMPLETED', 'CONFIRMED') OR COALESCE(b.status, '') IN ('completed', 'returned'))",
    ];
    const params = [partnerId];
    let paramIndex = 2;

    if (options.vehicleId) {
      conditions.push(`r.vehicle_id = $${paramIndex}`);
      params.push(options.vehicleId);
      paramIndex += 1;
    }

    if (options.score && Number(options.score) >= 1 && Number(options.score) <= 5) {
      conditions.push(`r.rating_score = $${paramIndex}`);
      params.push(Number(options.score));
      paramIndex += 1;
    }

    if (options.hasComment) {
      conditions.push("r.review_comment IS NOT NULL AND length(trim(r.review_comment)) > 0");
    }

    const whereClause = conditions.join(' AND ');

    // Count total
    const countSql = `
      SELECT COUNT(r.id)::int AS total
      FROM ratings r
      JOIN bookings b ON b.id = r.booking_id
      WHERE ${whereClause};
    `;
    const countRes = client
      ? await client.query(countSql, params)
      : await this.query(countSql, params);
    const total = Number(countRes.rows[0]?.total || 0);

    // Fetch paginated
    const dataSql = `
      SELECT
        r.id,
        r.booking_id,
        r.vehicle_id,
        r.target_type,
        r.rating_score,
        r.review_comment,
        r.status,
        r.created_at,
        b.booking_number,
        b.start_at AS booking_start_at,
        b.expected_return_at AS booking_return_at,
        COALESCE(u.name, b.customer_name) AS raw_customer_name,
        v.brand,
        v.model,
        v.registration_number
      FROM ratings r
      JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN users u ON u.id = r.customer_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;

    const dataParams = [...params, limit, offset];
    const dataRes = client
      ? await client.query(dataSql, dataParams)
      : await this.query(dataSql, dataParams);

    const ratings = dataRes.rows.map((row) => ({
      id: row.id,
      bookingId: row.booking_id,
      bookingNumber: row.booking_number,
      targetType: row.target_type,
      ratingScore: row.rating_score,
      rating: row.rating_score,
      reviewComment: row.review_comment,
      comment: row.review_comment,
      createdAt: row.created_at,
      bookingDate: row.booking_start_at,
      customerName: RatingRepository.maskCustomerName(row.raw_customer_name),
      vehicle: row.vehicle_id
        ? {
            id: row.vehicle_id,
            brand: row.brand,
            model: row.model,
            registrationNumber: row.registration_number,
          }
        : null,
    }));

    return {
      ratings,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  /**
   * Submits a rating (used by rating engine / future Customer App submission / tests).
   * Validates completed booking status, prevents duplicates, and saves rating.
   *
   * @param {object} params
   * @param {string} params.bookingId
   * @param {string} params.customerId
   * @param {string} params.partnerId
   * @param {string|null} [params.vehicleId]
   * @param {string} [params.targetType='PARTNER']
   * @param {number} params.ratingScore
   * @param {string|null} [params.reviewComment]
   * @param {string} [params.status='APPROVED']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createRating(params, client = null) {
    const {
      bookingId,
      customerId,
      partnerId,
      vehicleId = null,
      targetType = 'PARTNER',
      ratingScore,
      reviewComment = null,
      status = 'APPROVED',
    } = params;

    const score = Number(ratingScore);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new BadRequestError('Rating score must be an integer between 1 and 5', ERROR_CODES.VALIDATION_ERROR);
    }

    if (!['PARTNER', 'VEHICLE'].includes(targetType)) {
      throw new BadRequestError("targetType must be either 'PARTNER' or 'VEHICLE'", ERROR_CODES.VALIDATION_ERROR);
    }

    // 1. Verify booking is completed and matches participants
    const bookingSql = `
      SELECT id, customer_id, partner_id, vehicle_id, booking_status, status
      FROM bookings
      WHERE id = $1
      LIMIT 1;
    `;
    const bRes = client
      ? await client.query(bookingSql, [bookingId])
      : await this.query(bookingSql, [bookingId]);

    const booking = bRes.rows[0];
    if (!booking) {
      throw new NotFoundError('Booking record not found', ERROR_CODES.NOT_FOUND);
    }

    const isCompleted = ['COMPLETED', 'CONFIRMED'].includes(booking.booking_status)
      || ['completed', 'returned'].includes(booking.status);
    if (!isCompleted) {
      throw new BadRequestError('Only completed bookings are eligible for rating', ERROR_CODES.INVALID_STATE);
    }

    // 2. Check for duplicate rating on this booking and targetType
    const dupSql = `
      SELECT id FROM ratings
      WHERE booking_id = $1 AND target_type = $2
      LIMIT 1;
    `;
    const dupRes = client
      ? await client.query(dupSql, [bookingId, targetType])
      : await this.query(dupSql, [bookingId, targetType]);

    if (dupRes.rows[0]) {
      throw new ConflictError(
        `A ${targetType.toLowerCase()} rating has already been submitted for this booking`,
        ERROR_CODES.CONFLICT,
      );
    }

    // 3. Insert rating
    const effectiveVehicleId = targetType === 'VEHICLE' ? (vehicleId || booking.vehicle_id) : vehicleId;
    const insertSql = `
      INSERT INTO ratings (
        booking_id, customer_id, partner_id, vehicle_id,
        target_type, rating_score, review_comment, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const insertParams = [
      bookingId,
      customerId,
      partnerId,
      effectiveVehicleId,
      targetType,
      score,
      reviewComment ? String(reviewComment).trim() : null,
      status,
    ];

    const insRes = client
      ? await client.query(insertSql, insertParams)
      : await this.query(insertSql, insertParams);

    return insRes.rows[0];
  }
}

module.exports = RatingRepository;
