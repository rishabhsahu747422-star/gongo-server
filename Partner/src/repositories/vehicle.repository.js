'use strict';

const BaseRepository = require('../db/base.repository');
const pool = require('../db/pool');
const OvertimeService = require('../services/overtime.service');
const { generateUniqueEntityReference } = require('../utils/reference-generator');

class VehicleRepository extends BaseRepository {
  constructor() {
    super('vehicles', 'id');
  }

  /**
   * Find vehicle by ID and partner ID (verifying partner ownership).
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAndPartnerId(id, partnerId, client = null) {
    const text = `
      SELECT 
        v.id, v.vehicle_reference, v.partner_id, v.shop_id, v.category, v.brand, v.model, v.variant,
        v.registration_number, v.year, v.fuel_type, v.transmission, v.seats,
        v.description, v.pickup_location, v.manual_status, v.rental_status,
        v.verification_status, v.rejection_reason, v.is_archived, v.offline_reason, v.primary_image_url,
        v.created_at, v.updated_at,
        -- Admin block/deactivate flag (AD-2). vehicles.is_active exists in the live baseline but not in
        -- the repo migrations, so it is read schema-tolerantly (NULL when the column is absent).
        (to_jsonb(v) ->> 'is_active')::boolean AS is_active,
        vp.price_per_hour, vp.price_3_hours, vp.price_6_hours, vp.price_12_hours, vp.price_per_4_hours, vp.price_per_day,
        vp.security_deposit, vp.extra_km_charge, vp.currency, vp.is_active AS pricing_active,
        COALESCE((
          SELECT SUM(COALESCE(e.partner_net_amount, bps.total_customer_amount, b.total_amount, b.subtotal, 0))
          FROM bookings b
          LEFT JOIN earnings e ON e.booking_id = b.id
          LEFT JOIN booking_pricing_snapshots bps ON bps.booking_id = b.id
          WHERE b.vehicle_id = v.id
            AND (
              b.booking_status IN ('COMPLETED', 'ACTIVE', 'UPCOMING', 'CONFIRMED', 'BOOKED')
              OR COALESCE(b.status, '') IN ('completed', 'returned', 'active', 'in_progress', 'confirmed', 'payment_completed')
            )
        ), 0)::numeric(12,2) AS total_earnings,
        COALESCE((
          SELECT COUNT(*)
          FROM bookings b
          WHERE b.vehicle_id = v.id
            AND (
              b.booking_status IN ('COMPLETED', 'ACTIVE', 'UPCOMING', 'CONFIRMED', 'BOOKED')
              OR COALESCE(b.status, '') IN ('completed', 'returned', 'active', 'in_progress', 'confirmed', 'payment_completed')
            )
        ), 0)::int AS total_bookings,
        (
          SELECT ROUND(AVG(r.rating_score)::numeric, 1)
          FROM ratings r
          JOIN bookings b ON b.id = r.booking_id
          WHERE r.vehicle_id = v.id
            AND r.target_type = 'VEHICLE'
            AND r.status = 'APPROVED'
            AND (
              b.booking_status IN ('COMPLETED', 'CONFIRMED')
              OR COALESCE(b.status, '') IN ('completed', 'returned')
            )
        ) AS rating_avg,
        COALESCE((
          SELECT COUNT(*)
          FROM ratings r
          JOIN bookings b ON b.id = r.booking_id
          WHERE r.vehicle_id = v.id
            AND r.target_type = 'VEHICLE'
            AND r.status = 'APPROVED'
            AND (
              b.booking_status IN ('COMPLETED', 'CONFIRMED')
              OR COALESCE(b.status, '') IN ('completed', 'returned')
            )
        ), 0)::int AS rating_count
      FROM ${this.tableName} v
      LEFT JOIN vehicle_pricing vp ON vp.vehicle_id = v.id
      WHERE v.id = $1 AND v.partner_id = $2
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [id, partnerId])
      : await this.query(text, [id, partnerId]);
    return res.rows[0] || null;
  }

  /**
   * Find vehicle by ID and partner ID with exclusive row-level lock (FOR UPDATE).
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findByIdAndPartnerIdForUpdate(id, partnerId, client) {
    const text = `
      SELECT 
        id, vehicle_reference, partner_id, shop_id, category, brand, model, variant,
        registration_number, year, fuel_type, transmission, seats,
        description, pickup_location, manual_status, rental_status,
        verification_status, rejection_reason, is_archived, offline_reason,
        created_at, updated_at
      FROM ${this.tableName}
      WHERE id = $1 AND partner_id = $2
      FOR UPDATE;
    `;
    const res = await client.query(text, [id, partnerId]);
    return res.rows[0] || null;
  }

  /**
   * Find vehicle by registration number.
   *
   * @param {string} registrationNumber
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByRegistrationNumber(registrationNumber, client = null) {
    const text = `
      SELECT id, vehicle_reference, partner_id, registration_number, is_archived
      FROM ${this.tableName}
      WHERE UPPER(TRIM(registration_number)) = UPPER(TRIM($1))
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [registrationNumber])
      : await this.query(text, [registrationNumber]);
    return res.rows[0] || null;
  }

  /**
   * Create a new vehicle record.
   *
   * @param {object} vehicleData
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createVehicle(vehicleData, client = null) {
    const runner = client || this;
    let vehicleReference = vehicleData.vehicleReference || null;
    if (!vehicleReference) {
      try {
        vehicleReference = await generateUniqueEntityReference(runner, 'vehicles', 'vehicle_reference', 'VEH');
      } catch {
        vehicleReference = null;
      }
    }

    const text = `
      INSERT INTO ${this.tableName} (
        partner_id, shop_id, category, brand, model, variant,
        registration_number, year, fuel_type, transmission, seats,
        description, pickup_location, manual_status, rental_status,
        verification_status, is_archived, vehicle_reference
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, COALESCE($18, ('VEH-' || upper(substr(md5(random()::text), 1, 6)))))
      RETURNING *;
    `;
    const values = [
      vehicleData.partnerId,
      vehicleData.shopId || null,
      vehicleData.category,
      vehicleData.brand.trim(),
      vehicleData.model.trim(),
      vehicleData.variant ? vehicleData.variant.trim() : null,
      vehicleData.registrationNumber.trim().toUpperCase(),
      vehicleData.year,
      vehicleData.fuelType,
      vehicleData.transmission || 'Manual',
      vehicleData.seats || 2,
      vehicleData.description ? vehicleData.description.trim() : null,
      vehicleData.pickupLocation ? vehicleData.pickupLocation.trim() : null,
      // Default ONLINE: new vehicles start ONLINE immediately so customers can discover them while verification is PENDING.
      vehicleData.manualStatus || 'ONLINE',
      vehicleData.rentalStatus || 'IDLE',
      vehicleData.verificationStatus || 'PENDING',
      vehicleData.isArchived || false,
      vehicleReference,
    ];

    try {
      const res = client
        ? await client.query(text, values)
        : await this.query(text, values);
      return res.rows[0];
    } catch (err) {
      this.handleDbError(err, 'VehicleRepository.createVehicle');
    }
  }

  /**
   * Find vehicles for a partner with filtering and pagination.
   *
   * @param {string} partnerId
   * @param {object} [options]
   * @param {string} [options.category]
   * @param {string} [options.status]
   * @param {string} [options.search]
   * @param {number} [options.limit=20]
   * @param {number} [options.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findManyByPartnerId(partnerId, options = {}, client = null) {
    const {
      category,
      status,
      search,
      limit = 20,
      offset = 0,
    } = options;

    const values = [partnerId];
    let idx = 2;

    const conditions = ['v.partner_id = $1'];

    // Default to unarchived unless explicitly requesting ARCHIVED
    if (status && status.toUpperCase() === 'ARCHIVED') {
      conditions.push('v.is_archived = true');
    } else {
      conditions.push('v.is_archived = false');
    }

    if (category) {
      conditions.push(`UPPER(v.category) = UPPER($${idx})`);
      values.push(category);
      idx += 1;
    }

    if (status) {
      const upperStatus = status.toUpperCase();
      if (upperStatus === 'ONLINE') {
        conditions.push("v.manual_status = 'ONLINE'");
      } else if (upperStatus === 'OFFLINE') {
        conditions.push("v.manual_status = 'OFFLINE'");
      } else if (upperStatus === 'AVAILABLE') {
        conditions.push("v.manual_status = 'ONLINE' AND v.rental_status = 'IDLE'");
      } else if (upperStatus === 'BOOKED') {
        conditions.push("v.rental_status = 'BOOKED'");
      } else if (upperStatus === 'ACTIVE') {
        conditions.push("v.rental_status = 'ACTIVE'");
      } else if (upperStatus === 'UNAVAILABLE') {
        conditions.push("v.manual_status = 'OFFLINE'");
      }
    }

    if (search && search.trim()) {
      conditions.push(
        `(v.brand ILIKE $${idx} OR v.model ILIKE $${idx} OR v.registration_number ILIKE $${idx} OR v.vehicle_reference ILIKE $${idx})`,
      );
      values.push(`%${search.trim()}%`);
      idx += 1;
    }

    const whereClause = conditions.join(' AND ');

    values.push(limit);
    const limitIdx = idx;
    idx += 1;

    values.push(offset);
    const offsetIdx = idx;

    const text = `
      SELECT 
        v.id, v.vehicle_reference, v.partner_id, v.shop_id, v.category, v.brand, v.model, v.variant,
        v.registration_number, v.year, v.fuel_type, v.transmission, v.seats,
        v.description, v.pickup_location, v.manual_status, v.rental_status,
        v.verification_status, v.rejection_reason, v.is_archived, v.offline_reason, v.primary_image_url,
        v.created_at, v.updated_at,
        vp.price_per_hour, vp.price_3_hours, vp.price_6_hours, vp.price_12_hours, vp.price_per_4_hours, vp.price_per_day,
        vp.security_deposit, vp.extra_km_charge, vp.currency, vp.is_active AS pricing_active,
        COALESCE(v.primary_image_url, vi_cover.storage_key) AS cover_image_key,
        COALESCE((
          SELECT SUM(COALESCE(e.partner_net_amount, bps.total_customer_amount, b.total_amount, b.subtotal, 0))
          FROM bookings b
          LEFT JOIN earnings e ON e.booking_id = b.id
          LEFT JOIN booking_pricing_snapshots bps ON bps.booking_id = b.id
          WHERE b.vehicle_id = v.id
            AND (
              b.booking_status IN ('COMPLETED', 'ACTIVE', 'UPCOMING', 'CONFIRMED', 'BOOKED')
              OR COALESCE(b.status, '') IN ('completed', 'returned', 'active', 'in_progress', 'confirmed', 'payment_completed')
            )
        ), 0)::numeric(12,2) AS total_earnings,
        COALESCE((
          SELECT COUNT(*)
          FROM bookings b
          WHERE b.vehicle_id = v.id
            AND (
              b.booking_status IN ('COMPLETED', 'ACTIVE', 'UPCOMING', 'CONFIRMED', 'BOOKED')
              OR COALESCE(b.status, '') IN ('completed', 'returned', 'active', 'in_progress', 'confirmed', 'payment_completed')
            )
        ), 0)::int AS total_bookings,
        (
          SELECT ROUND(AVG(r.rating_score)::numeric, 1)
          FROM ratings r
          JOIN bookings b ON b.id = r.booking_id
          WHERE r.vehicle_id = v.id
            AND r.target_type = 'VEHICLE'
            AND r.status = 'APPROVED'
            AND (
              b.booking_status IN ('COMPLETED', 'CONFIRMED')
              OR COALESCE(b.status, '') IN ('completed', 'returned')
            )
        ) AS rating_avg,
        COALESCE((
          SELECT COUNT(*)
          FROM ratings r
          JOIN bookings b ON b.id = r.booking_id
          WHERE r.vehicle_id = v.id
            AND r.target_type = 'VEHICLE'
            AND r.status = 'APPROVED'
            AND (
              b.booking_status IN ('COMPLETED', 'CONFIRMED')
              OR COALESCE(b.status, '') IN ('completed', 'returned')
            )
        ), 0)::int AS rating_count,
        COUNT(*) OVER()::int AS total_count
      FROM ${this.tableName} v
      LEFT JOIN vehicle_pricing vp ON vp.vehicle_id = v.id
      LEFT JOIN LATERAL (
        SELECT vi.storage_key 
        FROM vehicle_images vi 
        WHERE vi.vehicle_id = v.id AND vi.is_active = true 
        ORDER BY vi.is_cover DESC, vi.sort_order ASC, vi.created_at ASC 
        LIMIT 1
      ) vi_cover ON true
      WHERE ${whereClause}
      ORDER BY v.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const res = client
      ? await client.query(text, values)
      : await this.query(text, values);
    return res.rows;
  }

  /**
   * Count total vehicles for a partner matching filters.
   *
   * @param {string} partnerId
   * @param {object} [options]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async countByPartnerId(partnerId, options = {}, client = null) {
    const { category, status, search } = options;
    const values = [partnerId];
    let idx = 2;

    const conditions = ['v.partner_id = $1'];

    if (status && status.toUpperCase() === 'ARCHIVED') {
      conditions.push('v.is_archived = true');
    } else {
      conditions.push('v.is_archived = false');
    }

    if (category) {
      conditions.push(`UPPER(v.category) = UPPER($${idx})`);
      values.push(category);
      idx += 1;
    }

    if (status) {
      const upperStatus = status.toUpperCase();
      if (upperStatus === 'ONLINE') {
        conditions.push("v.manual_status = 'ONLINE'");
      } else if (upperStatus === 'OFFLINE') {
        conditions.push("v.manual_status = 'OFFLINE'");
      } else if (upperStatus === 'AVAILABLE') {
        conditions.push("v.manual_status = 'ONLINE' AND v.rental_status = 'IDLE'");
      } else if (upperStatus === 'BOOKED') {
        conditions.push("v.rental_status = 'BOOKED'");
      } else if (upperStatus === 'ACTIVE') {
        conditions.push("v.rental_status = 'ACTIVE'");
      } else if (upperStatus === 'UNAVAILABLE') {
        conditions.push("v.manual_status = 'OFFLINE'");
      }
    }

    if (search && search.trim()) {
      conditions.push(
        `(v.brand ILIKE $${idx} OR v.model ILIKE $${idx} OR v.registration_number ILIKE $${idx} OR v.vehicle_reference ILIKE $${idx})`,
      );
      values.push(`%${search.trim()}%`);
      idx += 1;
    }

    const whereClause = conditions.join(' AND ');
    const text = `
      SELECT COUNT(*)::integer AS total
      FROM ${this.tableName} v
      WHERE ${whereClause};
    `;

    const res = client
      ? await client.query(text, values)
      : await this.query(text, values);
    return res.rows[0] ? res.rows[0].total : 0;
  }

  /**
   * Update vehicle fields.
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {object} updates
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateVehicle(id, partnerId, updates, client = null) {
    const allowedMap = {
      category: 'category',
      brand: 'brand',
      model: 'model',
      variant: 'variant',
      year: 'year',
      fuelType: 'fuel_type',
      transmission: 'transmission',
      seats: 'seats',
      description: 'description',
      pickupLocation: 'pickup_location',
      verificationStatus: 'verification_status',
      rejectionReason: 'rejection_reason',
    };

    const setClauses = [];
    const values = [id, partnerId];
    let idx = 3;

    Object.keys(updates).forEach((key) => {
      const col = allowedMap[key];
      if (col && updates[key] !== undefined) {
        setClauses.push(`${col} = $${idx}`);
        values.push(updates[key]);
        idx += 1;
      }
    });

    if (setClauses.length === 0) {
      return this.findByIdAndPartnerId(id, partnerId, client);
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');

    const text = `
      UPDATE ${this.tableName}
      SET ${setClauses.join(', ')}
      WHERE id = $1 AND partner_id = $2
      RETURNING *;
    `;

    try {
      const res = client
        ? await client.query(text, values)
        : await this.query(text, values);
      return res.rows[0] || null;
    } catch (err) {
      this.handleDbError(err, 'VehicleRepository.updateVehicle');
    }
  }

  /**
   * Update vehicle operational status.
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {string} manualStatus ONLINE | OFFLINE
   * @param {string} [offlineReason]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateStatus(id, partnerId, manualStatus, offlineReason = null, client = null) {
    const text = `
      UPDATE ${this.tableName}
      SET manual_status = $3, offline_reason = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND partner_id = $2
        AND ($3 <> 'ONLINE' OR is_archived IS NOT TRUE)
        -- Atomic AD-2 guard: refuse ONLINE while the vehicle is admin-blocked/deactivated
        -- (is_active = false). Read schema-tolerantly; NULL (column absent) is treated as active.
        AND ($3 <> 'ONLINE' OR COALESCE((to_jsonb(${this.tableName}) ->> 'is_active')::boolean, true))
        -- Atomic verification guard: VERIFIED/APPROVED and PENDING/UNDER_REVIEW vehicles may go
        -- ONLINE, but REJECTED vehicles cannot. A concurrent admin rejection between read and write wins.
        AND ($3 <> 'ONLINE' OR UPPER(COALESCE(verification_status, '')) IN ('VERIFIED', 'APPROVED', 'PENDING', 'UNDER_REVIEW'))
      RETURNING *;
    `;
    const values = [id, partnerId, manualStatus, offlineReason];
    const res = client
      ? await client.query(text, values)
      : await this.query(text, values);
    return res.rows[0] || null;
  }

  /**
   * Archive vehicle (soft-delete).
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async archiveVehicle(id, partnerId, client = null) {
    const text = `
      UPDATE ${this.tableName}
      SET is_archived = true, manual_status = 'OFFLINE', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND partner_id = $2
      RETURNING *;
    `;
    const res = client
      ? await client.query(text, [id, partnerId])
      : await this.query(text, [id, partnerId]);
    return res.rows[0] || null;
  }

  // ── Images ──────────────────────────────────────────────────────────

  /**
   * Add an image record for a vehicle.
   *
   * @param {object} params
   * @param {string} params.vehicleId
   * @param {string} params.storageKey
   * @param {boolean} [params.isCover=false]
   * @param {number} [params.sortOrder=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createVehicleImage(
    {
      vehicleId,
      storageKey,
      isCover = false,
      sortOrder = 0,
      verificationStatus = 'PENDING',
      rejectionReason = null,
      version = 1,
      parentImageId = null,
    },
    client = null,
  ) {
    const text = `
      INSERT INTO vehicle_images (
        vehicle_id, storage_key, image_url, is_cover, sort_order,
        verification_status, rejection_reason, version, parent_image_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;
    const values = [
      vehicleId,
      storageKey,
      storageKey,
      isCover,
      sortOrder,
      verificationStatus,
      rejectionReason,
      version,
      parentImageId,
    ];

    try {
      const res = (client && typeof client.query === 'function')
        ? await client.query(text, values)
        : await this.query(text, values);
      return res && res.rows ? res.rows[0] : null;
    } catch (err) {
      this.handleDbError(err, 'VehicleRepository.createVehicleImage');
    }
  }

  /**
   * Get all active images for a vehicle.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async getVehicleImages(vehicleId, client = null) {
    const text = `
      SELECT
        id, vehicle_id, storage_key, COALESCE(image_url, file_url) AS image_url,
        sort_order, is_cover, is_active, verification_status, rejection_reason,
        version, parent_image_id, verified_at, rejected_at, created_at, updated_at
      FROM vehicle_images
      WHERE vehicle_id = $1 AND is_active = true
      ORDER BY is_cover DESC, sort_order ASC, created_at ASC;
    `;
    const res = (client && typeof client.query === 'function')
      ? await client.query(text, [vehicleId])
      : await this.query(text, [vehicleId]);
    return res && res.rows ? res.rows : [];
  }

  /**
   * Find vehicle image by ID and vehicle ID.
   *
   * @param {string} imageId
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findVehicleImageById(imageId, vehicleId, client = null) {
    const text = `
      SELECT
        id, vehicle_id, storage_key, COALESCE(image_url, file_url) AS image_url,
        sort_order, is_cover, is_active, verification_status, rejection_reason,
        version, parent_image_id, verified_at, rejected_at, created_at, updated_at
      FROM vehicle_images
      WHERE id = $1 AND vehicle_id = $2
      LIMIT 1;
    `;
    const res = (client && typeof client.query === 'function')
      ? await client.query(text, [imageId, vehicleId])
      : await this.query(text, [imageId, vehicleId]);
    return res && res.rows ? res.rows[0] || null : null;
  }

  /**
   * Count active images for a vehicle.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async countActiveImages(vehicleId, client = null) {
    const text = `
      SELECT COUNT(*)::int AS count
      FROM vehicle_images
      WHERE vehicle_id = $1 AND is_active = true;
    `;
    const res = (client && typeof client.query === 'function')
      ? await client.query(text, [vehicleId])
      : await this.query(text, [vehicleId]);
    return res && res.rows && res.rows[0] ? res.rows[0].count : 0;
  }

  /**
   * Deactivate an image record while preserving audit history.
   *
   * @param {string} imageId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async deactivateImage(imageId, client = null) {
    const text = `
      UPDATE vehicle_images
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;
    const res = (client && typeof client.query === 'function')
      ? await client.query(text, [imageId])
      : await this.query(text, [imageId]);
    return res && res.rows ? res.rows[0] || null : null;
  }

  /**
   * Update vehicle verification status directly.
   *
   * @param {string} vehicleId
   * @param {string} status
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateVehicleVerificationStatus(vehicleId, status, client = null, rejectionReason = undefined) {
    let text;
    let values;
    if (rejectionReason !== undefined) {
      text = `
        UPDATE vehicles
        SET verification_status = $2, rejection_reason = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
      values = [vehicleId, status, rejectionReason];
    } else if (status === 'PENDING') {
      text = `
        UPDATE vehicles
        SET verification_status = $2, rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
      values = [vehicleId, status];
    } else {
      text = `
        UPDATE vehicles
        SET verification_status = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
      values = [vehicleId, status];
    }
    const res = (client && typeof client.query === 'function')
      ? await client.query(text, values)
      : await this.query(text, values);
    return res && res.rows ? res.rows[0] || null : null;
  }

  /**
   * Set image as cover and reset other images for this vehicle.
   *
   * @param {string} imageId
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async setCoverImage(imageId, vehicleId, client = null) {
    const runner = async (dbClient) => {
      await dbClient.query(
        'UPDATE vehicle_images SET is_cover = false, updated_at = CURRENT_TIMESTAMP WHERE vehicle_id = $1',
        [vehicleId],
      );
      const res = await dbClient.query(
        'UPDATE vehicle_images SET is_cover = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND vehicle_id = $2 RETURNING *',
        [imageId, vehicleId],
      );
      if (res.rows[0]) {
        await dbClient.query(
          'UPDATE vehicles SET primary_image_url = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [vehicleId, res.rows[0].storage_key],
        );
      }
      return res.rows[0] || null;
    };

    if (client) {
      return runner(client);
    }
    return pool.transaction(runner);
  }

  /**
   * Delete vehicle image and resynchronize the primary image reference.
   *
   * @param {string} imageId
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async deleteVehicleImage(imageId, vehicleId, client = null) {
    const runner = async (dbClient) => {
      const text = `
        DELETE FROM vehicle_images
        WHERE id = $1 AND vehicle_id = $2
        RETURNING *;
      `;
      const res = await dbClient.query(text, [imageId, vehicleId]);
      await this.syncVehiclePrimaryImage(vehicleId, dbClient);
      return res.rows[0] || null;
    };

    if (client) {
      return runner(client);
    }
    return pool.transaction(runner);
  }

  /**
   * Synchronize the vehicle's primary_image_url reference with the current
   * active images according to authoritative business rules:
   * 1. Active VERIFIED/APPROVED image marked as cover (highest precedence)
   * 2. Other active VERIFIED/APPROVED images (sorted by sort_order ASC, created_at ASC)
   * 3. Active PENDING image marked as cover (for newly submitted vehicles undergoing review)
   * 4. Other active PENDING images
   * 5. If no active, non-rejected image exists, set primary_image_url = NULL.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<string|null>} The storage_key set as primary, or null
   */
  async syncVehiclePrimaryImage(vehicleId, client = null) {
    try {
      const findSql = `
        SELECT id, storage_key, is_cover, verification_status
        FROM vehicle_images
        WHERE vehicle_id = $1 AND is_active = true
        ORDER BY
          (verification_status IN ('VERIFIED', 'APPROVED') AND is_cover = true) DESC,
          (verification_status IN ('VERIFIED', 'APPROVED')) DESC,
          (verification_status = 'PENDING' AND is_cover = true) DESC,
          (verification_status = 'PENDING') DESC,
          sort_order ASC,
          created_at ASC
        LIMIT 1;
      `;
      const res = (client && typeof client.query === 'function')
        ? await client.query(findSql, [vehicleId])
        : await this.query(findSql, [vehicleId]);

      const bestImage = res && res.rows ? res.rows[0] : null;
      const primaryKey = (bestImage && bestImage.verification_status !== 'REJECTED')
        ? bestImage.storage_key
        : null;

      const updateSql = `
        UPDATE vehicles
        SET primary_image_url = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, primary_image_url;
      `;
      if (client && typeof client.query === 'function') {
        await client.query(updateSql, [vehicleId, primaryKey]);
      } else {
        await this.query(updateSql, [vehicleId, primaryKey]);
      }

      if (bestImage && !bestImage.is_cover && primaryKey) {
        const coverSql = `
          UPDATE vehicle_images SET is_cover = (id = $2), updated_at = CURRENT_TIMESTAMP WHERE vehicle_id = $1;
        `;
        if (client && typeof client.query === 'function') {
          await client.query(coverSql, [vehicleId, bestImage.id]);
        } else {
          await this.query(coverSql, [vehicleId, bestImage.id]);
        }
      }

      return primaryKey;
    } catch (err) {
      // Safe logging for offline / mocked test environments
      return null;
    }
  }

  // ── Documents ───────────────────────────────────────────────────────

  /**
   * Create vehicle document record.
   *
   * @param {object} docData
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createVehicleDocument(docData, client = null) {
    const text = `
      INSERT INTO vehicle_documents (
        vehicle_id, document_type, document_name, document_number,
        valid_till, storage_key, verification_status, is_required, version
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;
    const values = [
      docData.vehicleId,
      docData.documentType,
      docData.documentName || docData.documentType,
      docData.documentNumber || null,
      docData.validTill || null,
      docData.storageKey,
      (docData.verificationStatus || 'PENDING').toUpperCase(),
      docData.isRequired !== undefined ? docData.isRequired : true,
      docData.version || 1,
    ];

    try {
      const res = client
        ? await client.query(text, values)
        : await this.query(text, values);
      return res.rows[0];
    } catch (err) {
      this.handleDbError(err, 'VehicleRepository.createVehicleDocument');
    }
  }

  /**
   * Find maximum version for a vehicle and document type.
   *
   * @param {string} vehicleId
   * @param {string} documentType
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async findMaxDocumentVersion(vehicleId, documentType, client = null) {
    const text = `
      SELECT COALESCE(MAX(version), 0) AS max_version
      FROM vehicle_documents
      WHERE vehicle_id = $1 AND document_type = $2;
    `;
    const res = client
      ? await client.query(text, [vehicleId, documentType])
      : await this.query(text, [vehicleId, documentType]);
    return parseInt(res.rows[0].max_version, 10);
  }

  /**
   * Get latest version of each document type for a vehicle.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async getVehicleDocuments(vehicleId, client = null) {
    const text = `
      SELECT DISTINCT ON (document_type)
        id, vehicle_id, document_type, document_name, document_number,
        valid_till, storage_key, verification_status, is_required,
        version, rejection_reason, created_at, updated_at
      FROM vehicle_documents
      WHERE vehicle_id = $1
      ORDER BY document_type ASC, version DESC;
    `;
    const res = client
      ? await client.query(text, [vehicleId])
      : await this.query(text, [vehicleId]);
    return res.rows;
  }

  /**
   * Find vehicle document by ID and vehicle ID.
   *
   * @param {string} documentId
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findVehicleDocumentById(documentId, vehicleId, client = null) {
    const text = `
      SELECT 
        id, vehicle_id, document_type, document_name, document_number,
        valid_till, storage_key, verification_status, is_required,
        version, rejection_reason, created_at, updated_at
      FROM vehicle_documents
      WHERE id = $1 AND vehicle_id = $2
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [documentId, vehicleId])
      : await this.query(text, [documentId, vehicleId]);
    return res.rows[0] || null;
  }

  /**
   * Find vehicle document by ID with joined partner ownership info.
   *
   * @param {string} documentId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findVehicleDocumentByIdOnly(documentId, client = null) {
    const text = `
      SELECT 
        vd.id, vd.vehicle_id, vd.document_type, vd.document_name, vd.document_number,
        vd.valid_till, vd.storage_key, vd.verification_status, vd.is_required,
        vd.version, vd.rejection_reason, vd.created_at, vd.updated_at,
        v.partner_id
      FROM vehicle_documents vd
      JOIN ${this.tableName} v ON v.id = vd.vehicle_id
      WHERE vd.id = $1
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [documentId])
      : await this.query(text, [documentId]);
    return res.rows[0] || null;
  }

  /**
   * Delete vehicle document by ID and vehicle ID.
   *
   * @param {string} documentId
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async deleteVehicleDocument(documentId, vehicleId, client = null) {
    const text = `
      DELETE FROM vehicle_documents
      WHERE id = $1 AND vehicle_id = $2
      RETURNING *;
    `;
    const res = client
      ? await client.query(text, [documentId, vehicleId])
      : await this.query(text, [documentId, vehicleId]);
    return res.rows[0] || null;
  }

  /**
   * Update rental_status of vehicle (e.g. IDLE, BOOKED, ACTIVE).
   *
   * @param {string} vehicleId
   * @param {string} rentalStatus
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async updateRentalStatus(vehicleId, rentalStatus, client) {
    if (!client || typeof client.query !== 'function') return null;
    const isAvail = (rentalStatus === 'ACTIVE' ? false : (rentalStatus === 'IDLE' ? true : null));
    let text;
    let params;
    if (isAvail !== null) {
      text = `
        UPDATE ${this.tableName}
        SET rental_status = $2, is_available = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
      params = [vehicleId, rentalStatus, isAvail];
    } else {
      text = `
        UPDATE ${this.tableName}
        SET rental_status = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;
      params = [vehicleId, rentalStatus];
    }
    const res = await client.query(text, params);
    return res.rows[0] || null;
  }

  /**
   * Retrieves completed & active rental history for a specific vehicle with
   * partner ownership check.
   *
   * @param {string} vehicleId
   * @param {string} partnerId
   * @returns {Promise<object|null>}
   */
  async getVehicleRentalHistory(vehicleId, partnerId) {
    const vSql = `
      SELECT id, brand, model, registration_number, manual_status, rental_status
      FROM ${this.tableName}
      WHERE id = $1 AND partner_id = $2
      LIMIT 1;
    `;
    const vRes = await this.query(vSql, [vehicleId, partnerId]);
    if (!vRes.rows[0]) return null;
    const vehicle = vRes.rows[0];

    const historySql = `
      SELECT
        b.id,
        b.booking_number,
        COALESCE(b.booking_status, b.status) AS booking_status,
        b.customer_name,
        b.customer_phone,
        b.start_at,
        COALESCE(b.expected_return_at, b.end_at) AS expected_return_at,
        bpv.verified_at AS actual_pickup_at,
        brv.returned_at AS actual_return_at,
        b.total_amount,
        b.created_at,
        brv.odometer_end,
        brv.late_minutes,
        brv.late_fee,
        brv.extra_km,
        brv.extra_km_fee,
        brv.return_status,
        brv.total_distance,
        brv.notes AS return_notes,
        COALESCE(bps.price_per_hour, b.price_per_hour, 0)::numeric(12,2) AS price_per_hour,
        COALESCE(e.partner_net_amount, e.net_earnings, bps.total_customer_amount, b.total_amount, b.subtotal, 0)::numeric(12,2) AS earnings
      FROM bookings b
      LEFT JOIN booking_pricing_snapshots bps ON bps.booking_id = b.id
      LEFT JOIN booking_pickup_verifications bpv ON bpv.booking_id = b.id
      LEFT JOIN booking_return_verifications brv ON brv.booking_id = b.id
      LEFT JOIN earnings e ON e.booking_id = b.id
      WHERE b.vehicle_id = $1 AND (b.partner_id = $2 OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = b.vehicle_id AND v.partner_id = $2))
      ORDER BY b.created_at DESC;
    `;
    const hRes = await this.query(historySql, [vehicleId, partnerId]);
    const rows = hRes.rows || [];

    const totalTrips = rows.filter((r) => !['CANCELLED', 'REFUNDED'].includes(String(r.booking_status || '').toUpperCase())).length;
    const totalEarnings = rows
      .filter((r) => !['CANCELLED', 'REFUNDED'].includes(String(r.booking_status || '').toUpperCase()))
      .reduce((sum, r) => sum + Number(r.earnings || 0), 0);

    const mappedRows = rows.map((r) => {
      let durationMinutes = 0;
      if (r.actual_pickup_at && r.actual_return_at) {
        durationMinutes = Math.max(
          0,
          Math.round((new Date(r.actual_return_at) - new Date(r.actual_pickup_at)) / 60000),
        );
      } else if (r.start_at && r.expected_return_at) {
        durationMinutes = Math.max(
          0,
          Math.round((new Date(r.expected_return_at) - new Date(r.start_at)) / 60000),
        );
      }

      const persistedOvertime = OvertimeService.extractPersistedOvertime({
        expected_return_at: r.expected_return_at,
        returned_at: r.actual_return_at,
        late_minutes: r.late_minutes,
        return_late_fee: r.late_fee,
        price_per_hour: r.price_per_hour,
        return_notes: r.return_notes,
      });

      return {
        id: r.id,
        bookingNumber: r.booking_number,
        status: r.booking_status,
        rentalStatus: r.booking_status,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        startAt: r.start_at,
        expectedReturnAt: r.expected_return_at,
        scheduledReturnAt: r.expected_return_at,
        handoverAt: r.actual_pickup_at,
        returnedAt: r.actual_return_at,
        actualReturnAt: r.actual_return_at,
        durationMinutes,
        earnings: Number(Number(r.earnings || 0).toFixed(2)),
        earningsAmount: Number(Number(r.earnings || 0).toFixed(2)),
        odometerEnd: r.odometer_end,
        lateMinutes: Number(r.late_minutes || persistedOvertime.overtimeDurationMinutes || 0),
        lateFee: Number(Number(r.late_fee || persistedOvertime.overtimeAmount || 0).toFixed(2)),
        extraKm: Number(r.extra_km || 0),
        extraKmFee: Number(Number(r.extra_km_fee || 0).toFixed(2)),
        returnStatus: r.return_status || (persistedOvertime.overtimeDurationMinutes > 15 ? 'LATE' : 'ON_TIME'),
        totalDistance: r.total_distance,
        // Overtime History Details
        overtimeDurationMinutes: persistedOvertime.overtimeDurationMinutes,
        gracePeriodMinutes: persistedOvertime.gracePeriodMinutes,
        billableHours: persistedOvertime.billableHours,
        hourlyRate: persistedOvertime.hourlyRate,
        overtimeRate: persistedOvertime.hourlyRate,
        overtimeAmount: persistedOvertime.overtimeAmount,
        overtimePaymentStatus: persistedOvertime.overtimePaymentStatus,
        paymentReference: persistedOvertime.paymentReference,
        overtime: persistedOvertime,
        createdAt: r.created_at,
      };
    });

    return {
      vehicle: {
        id: vehicle.id,
        brand: vehicle.brand,
        model: vehicle.model,
        registrationNumber: vehicle.registration_number,
        manualStatus: vehicle.manual_status,
        rentalStatus: vehicle.rental_status,
        totalTrips,
        totalEarnings: Number(totalEarnings.toFixed(2)),
      },
      history: mappedRows,
      bookings: mappedRows,
    };
  }
}

module.exports = new VehicleRepository();
