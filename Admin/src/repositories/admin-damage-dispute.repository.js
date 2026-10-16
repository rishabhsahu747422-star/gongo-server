'use strict';

const { query, transaction } = require('../db/pool');
const { escapeLikeString } = require('../db/sql-helpers');

let mockDamageDisputeResolver = null;

function setMockDamageDisputeResolver(resolver) {
  mockDamageDisputeResolver = resolver;
}

function resetMockDamageDisputeResolver() {
  mockDamageDisputeResolver = null;
}

class AdminDamageDisputeRepository {
  async _exec(sql, params = [], client = null) {
    if (mockDamageDisputeResolver && typeof mockDamageDisputeResolver === 'function') {
      return mockDamageDisputeResolver(sql, params);
    }
    if (client) {
      return client.query(sql, params);
    }
    return query(sql, params);
  }

  async executeInTransaction(callback) {
    return transaction(async (client) => callback(client));
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // DAMAGE REPORTS
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * List damage reports with filters, search, and bounded pagination.
   */
  async listDamages({
    search,
    damageId,
    bookingId,
    bookingNumber,
    vehicleId,
    registrationNumber,
    partnerId,
    customerId,
    status,
    damageType,
    startDate,
    endDate,
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  } = {}) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (search && search.trim() !== '') {
      const escaped = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(
        b.booking_number ILIKE $${paramIndex}
        OR v.registration_number ILIKE $${paramIndex}
        OR d.damage_type ILIKE $${paramIndex}
        OR d.description ILIKE $${paramIndex}
        OR pt.business_name ILIKE $${paramIndex}
        OR u.name ILIKE $${paramIndex}
        OR u.phone ILIKE $${paramIndex}
      )`);
      params.push(escaped);
      paramIndex += 1;
    }

    if (damageId) {
      conditions.push(`d.id = $${paramIndex}`);
      params.push(damageId);
      paramIndex += 1;
    }

    if (bookingId) {
      conditions.push(`d.booking_id = $${paramIndex}`);
      params.push(bookingId);
      paramIndex += 1;
    }

    if (bookingNumber) {
      conditions.push(`b.booking_number = $${paramIndex}`);
      params.push(bookingNumber.trim());
      paramIndex += 1;
    }

    if (vehicleId) {
      conditions.push(`d.vehicle_id = $${paramIndex}`);
      params.push(vehicleId);
      paramIndex += 1;
    }

    if (registrationNumber) {
      conditions.push(`v.registration_number ILIKE $${paramIndex}`);
      params.push(registrationNumber.trim());
      paramIndex += 1;
    }

    if (partnerId) {
      conditions.push(`b.partner_id = $${paramIndex}`);
      params.push(partnerId);
      paramIndex += 1;
    }

    if (customerId) {
      conditions.push(`b.customer_id = $${paramIndex}`);
      params.push(customerId);
      paramIndex += 1;
    }

    if (status) {
      conditions.push(`d.status = $${paramIndex}`);
      params.push(status);
      paramIndex += 1;
    }

    if (damageType) {
      conditions.push(`d.damage_type = $${paramIndex}`);
      params.push(damageType);
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`d.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`d.created_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSort = ['created_at', 'updated_at', 'estimated_amount', 'approved_amount', 'status'];
    const safeSortCol = allowedSort.includes(sortBy) ? `d.${sortBy}` : 'd.created_at';
    const safeDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const sql = `
      SELECT
        d.id,
        d.booking_id,
        d.vehicle_id,
        d.reported_by,
        d.damage_type,
        d.description,
        d.estimated_amount,
        d.approved_amount,
        d.status,
        d.photos,
        d.created_at,
        d.updated_at,
        b.booking_number,
        b.status AS booking_status,
        b.partner_id,
        b.customer_id,
        v.registration_number,
        v.brand AS vehicle_brand,
        v.model AS vehicle_model,
        pt.business_name AS partner_business_name,
        u.name AS customer_name,
        u.phone AS customer_phone,
        COUNT(*) OVER()::int AS full_count
      FROM damage_reports d
      LEFT JOIN bookings b ON d.booking_id = b.id
      LEFT JOIN vehicles v ON d.vehicle_id = v.id
      LEFT JOIN partners pt ON b.partner_id = pt.id
      LEFT JOIN users u ON b.customer_id = u.id
      ${whereClause}
      ORDER BY ${safeSortCol} ${safeDir}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(safeLimit, offset);

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
    const damages = result.rows.map((row) => {
      const data = { ...row };
      delete data.full_count;
      return {
        id: data.id,
        bookingId: data.booking_id,
        bookingNumber: data.booking_number || null,
        bookingStatus: data.booking_status || null,
        vehicleId: data.vehicle_id,
        vehicle: data.registration_number ? {
          registrationNumber: data.registration_number,
          brand: data.vehicle_brand,
          model: data.vehicle_model,
        } : null,
        partnerId: data.partner_id || null,
        partnerBusinessName: data.partner_business_name || null,
        customerId: data.customer_id || null,
        customerName: data.customer_name || null,
        reportedBy: data.reported_by,
        damageType: data.damage_type,
        description: data.description,
        estimatedAmount: Number(Number(data.estimated_amount || 0).toFixed(2)),
        approvedAmount: data.approved_amount !== null
          ? Number(Number(data.approved_amount).toFixed(2))
          : null,
        status: data.status,
        photos: data.photos || [],
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    });

    return {
      damages,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
    };
  }

  /**
   * Retrieves single damage report by ID with joined booking, vehicle, partner, customer.
   */
  async getDamageById(id, client = null) {
    const sql = `
      SELECT
        d.id,
        d.booking_id,
        d.vehicle_id,
        d.reported_by,
        d.damage_type,
        d.description,
        d.estimated_amount,
        d.approved_amount,
        d.status,
        d.photos,
        d.created_at,
        d.updated_at,
        b.booking_number,
        b.status AS booking_status,
        b.start_date AS booking_start_date,
        b.end_date AS booking_end_date,
        b.partner_id,
        b.customer_id,
        v.registration_number,
        v.brand AS vehicle_brand,
        v.model AS vehicle_model,
        v.year AS vehicle_year,
        v.color AS vehicle_color,
        pt.business_name AS partner_business_name,
        pt.contact_email AS partner_email,
        pt.contact_phone AS partner_phone,
        u.name AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,
        rep.name AS reporter_name,
        rep.role AS reporter_role
      FROM damage_reports d
      LEFT JOIN bookings b ON d.booking_id = b.id
      LEFT JOIN vehicles v ON d.vehicle_id = v.id
      LEFT JOIN partners pt ON b.partner_id = pt.id
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN users rep ON d.reported_by = rep.id
      WHERE d.id = $1
      LIMIT 1;
    `;

    const res = await this._exec(sql, [id], client);
    if (!res.rows[0]) return null;

    const row = res.rows[0];
    return {
      id: row.id,
      bookingId: row.booking_id,
      booking: row.booking_number ? {
        id: row.booking_id,
        bookingNumber: row.booking_number,
        status: row.booking_status,
        startDate: row.booking_start_date,
        endDate: row.booking_end_date,
      } : null,
      vehicleId: row.vehicle_id,
      vehicle: row.registration_number ? {
        id: row.vehicle_id,
        registrationNumber: row.registration_number,
        brand: row.vehicle_brand,
        model: row.vehicle_model,
        year: row.vehicle_year,
        color: row.vehicle_color,
      } : null,
      partnerId: row.partner_id || null,
      partner: row.partner_business_name ? {
        id: row.partner_id,
        businessName: row.partner_business_name,
        email: row.partner_email,
        phone: row.partner_phone,
      } : null,
      customerId: row.customer_id || null,
      customer: row.customer_name ? {
        id: row.customer_id,
        name: row.customer_name,
        email: row.customer_email,
        phone: row.customer_phone,
      } : null,
      reportedBy: row.reported_by,
      reporter: row.reporter_name ? {
        id: row.reported_by,
        name: row.reporter_name,
        role: row.reporter_role,
      } : null,
      damageType: row.damage_type,
      description: row.description,
      estimatedAmount: Number(Number(row.estimated_amount || 0).toFixed(2)),
      approvedAmount: row.approved_amount !== null
        ? Number(Number(row.approved_amount).toFixed(2))
        : null,
      status: row.status,
      photos: row.photos || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Acquire row lock on damage report for concurrent mutation.
   */
  async getDamageForUpdate(client, id) {
    const sql = `
      SELECT *
      FROM damage_reports
      WHERE id = $1
      FOR UPDATE;
    `;
    const res = await client.query(sql, [id]);
    return res.rows[0] || null;
  }

  /**
   * Update damage report status and optional approved amount.
   */
  async updateDamageStatus(client, id, { status, approvedAmount = null }) {
    const sql = `
      UPDATE damage_reports
      SET
        status = $1,
        approved_amount = COALESCE($2, approved_amount),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *;
    `;
    const res = await client.query(sql, [status, approvedAmount, id]);
    return res.rows[0] || null;
  }

  /**
   * Retrieves pickup and return verifications for booking associated with damage.
   */
  async getDamageInspections(bookingId, client = null) {
    const pickupSql = `
      SELECT
        id,
        booking_id,
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

    const returnSql = `
      SELECT
        id,
        booking_id,
        returned_at,
        verified_by,
        odometer_end,
        fuel_level_end,
        late_minutes,
        late_fee,
        extra_km,
        extra_km_fee,
        notes,
        photos,
        created_at
      FROM booking_return_verifications
      WHERE booking_id = $1
      LIMIT 1;
    `;

    const [pkRes, retRes] = await Promise.all([
      this._exec(pickupSql, [bookingId], client),
      this._exec(returnSql, [bookingId], client),
    ]);

    const pk = pkRes.rows[0] || null;
    const ret = retRes.rows[0] || null;

    return {
      pickup: pk ? {
        id: pk.id,
        bookingId: pk.booking_id,
        isVerified: pk.is_verified,
        verifiedAt: pk.verified_at,
        verifiedBy: pk.verified_by,
        odometerStart: pk.odometer_start !== null ? Number(pk.odometer_start) : null,
        fuelLevelStart: pk.fuel_level_start,
        photos: pk.photos || [],
        notes: pk.notes,
        createdAt: pk.created_at,
      } : null,
      return: ret ? {
        id: ret.id,
        bookingId: ret.booking_id,
        returnedAt: ret.returned_at,
        verifiedBy: ret.verified_by,
        odometerEnd: ret.odometer_end !== null ? Number(ret.odometer_end) : null,
        fuelLevelEnd: ret.fuel_level_end,
        lateMinutes: ret.late_minutes,
        lateFee: Number(ret.late_fee || 0),
        extraKm: Number(ret.extra_km || 0),
        extraKmFee: Number(ret.extra_km_fee || 0),
        photos: ret.photos || [],
        notes: ret.notes,
        createdAt: ret.created_at,
      } : null,
    };
  }

  /**
   * Helper to create a damage report (for testing or seeding).
   */
  async createDamageReport(data, client = null) {
    const {
      bookingId,
      vehicleId,
      reportedBy,
      damageType = 'ACCIDENT',
      description,
      estimatedAmount = 0.00,
      approvedAmount = null,
      status = 'REPORTED',
      photos = [],
    } = data;

    const sql = `
      INSERT INTO damage_reports (
        booking_id,
        vehicle_id,
        reported_by,
        damage_type,
        description,
        estimated_amount,
        approved_amount,
        status,
        photos
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;

    const params = [
      bookingId,
      vehicleId,
      reportedBy,
      damageType,
      description,
      Number(estimatedAmount),
      approvedAmount !== null ? Number(approvedAmount) : null,
      status,
      photos,
    ];

    const res = await this._exec(sql, params, client);
    return res.rows[0];
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // DISPUTES
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * List disputes with filters, search, and bounded pagination.
   */
  async listDisputes({
    search,
    disputeId,
    disputeNumber,
    bookingId,
    customerId,
    partnerId,
    vehicleId,
    damageReportId,
    status,
    disputeType,
    priority,
    assignedTo,
    startDate,
    endDate,
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  } = {}) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (search && search.trim() !== '') {
      const escaped = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(
        dp.dispute_number ILIKE $${paramIndex}
        OR dp.description ILIKE $${paramIndex}
        OR b.booking_number ILIKE $${paramIndex}
        OR pt.business_name ILIKE $${paramIndex}
        OR cust.name ILIKE $${paramIndex}
        OR clm.name ILIKE $${paramIndex}
        OR asg.name ILIKE $${paramIndex}
      )`);
      params.push(escaped);
      paramIndex += 1;
    }

    if (disputeId) {
      conditions.push(`dp.id = $${paramIndex}`);
      params.push(disputeId);
      paramIndex += 1;
    }

    if (disputeNumber) {
      conditions.push(`dp.dispute_number = $${paramIndex}`);
      params.push(disputeNumber.trim());
      paramIndex += 1;
    }

    if (bookingId) {
      conditions.push(`dp.booking_id = $${paramIndex}`);
      params.push(bookingId);
      paramIndex += 1;
    }

    if (customerId) {
      conditions.push(`dp.customer_id = $${paramIndex}`);
      params.push(customerId);
      paramIndex += 1;
    }

    if (partnerId) {
      conditions.push(`dp.partner_id = $${paramIndex}`);
      params.push(partnerId);
      paramIndex += 1;
    }

    if (vehicleId) {
      conditions.push(`dp.vehicle_id = $${paramIndex}`);
      params.push(vehicleId);
      paramIndex += 1;
    }

    if (damageReportId) {
      conditions.push(`dp.damage_report_id = $${paramIndex}`);
      params.push(damageReportId);
      paramIndex += 1;
    }

    if (status) {
      conditions.push(`dp.status = $${paramIndex}`);
      params.push(status);
      paramIndex += 1;
    }

    if (disputeType) {
      conditions.push(`dp.dispute_type = $${paramIndex}`);
      params.push(disputeType);
      paramIndex += 1;
    }

    if (priority) {
      conditions.push(`dp.priority = $${paramIndex}`);
      params.push(priority);
      paramIndex += 1;
    }

    if (assignedTo) {
      conditions.push(`dp.assigned_to = $${paramIndex}`);
      params.push(assignedTo);
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`dp.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`dp.created_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSort = ['created_at', 'updated_at', 'disputed_amount', 'settled_amount', 'status', 'priority'];
    const safeSortCol = allowedSort.includes(sortBy) ? `dp.${sortBy}` : 'dp.created_at';
    const safeDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const sql = `
      SELECT
        dp.id,
        dp.dispute_number,
        dp.booking_id,
        dp.customer_id,
        dp.partner_id,
        dp.vehicle_id,
        dp.damage_report_id,
        dp.claimant_id,
        dp.respondent_id,
        dp.dispute_type,
        dp.status,
        dp.priority,
        dp.disputed_amount,
        dp.settled_amount,
        dp.currency,
        dp.description,
        dp.evidence,
        dp.assigned_to,
        dp.assigned_at,
        dp.resolution,
        dp.resolution_reason,
        dp.resolved_by,
        dp.resolved_at,
        dp.rejection_reason,
        dp.financial_action,
        dp.financial_reference_id,
        dp.metadata,
        dp.created_at,
        dp.updated_at,
        b.booking_number,
        v.registration_number,
        pt.business_name AS partner_business_name,
        cust.name AS customer_name,
        cust.phone AS customer_phone,
        clm.name AS claimant_name,
        asg.name AS assigned_to_name,
        COUNT(*) OVER()::int AS full_count
      FROM disputes dp
      LEFT JOIN bookings b ON dp.booking_id = b.id
      LEFT JOIN vehicles v ON dp.vehicle_id = v.id
      LEFT JOIN partners pt ON dp.partner_id = pt.id
      LEFT JOIN users cust ON dp.customer_id = cust.id
      LEFT JOIN users clm ON dp.claimant_id = clm.id
      LEFT JOIN users asg ON dp.assigned_to = asg.id
      ${whereClause}
      ORDER BY ${safeSortCol} ${safeDir}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(safeLimit, offset);

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
    const disputes = result.rows.map((row) => {
      const data = { ...row };
      delete data.full_count;
      return {
        id: data.id,
        disputeNumber: data.dispute_number,
        bookingId: data.booking_id,
        bookingNumber: data.booking_number || null,
        customerId: data.customer_id,
        customerName: data.customer_name || null,
        customerPhone: data.customer_phone || null,
        partnerId: data.partner_id,
        partnerBusinessName: data.partner_business_name || null,
        vehicleId: data.vehicle_id,
        registrationNumber: data.registration_number || null,
        damageReportId: data.damage_report_id,
        claimantId: data.claimant_id,
        claimantName: data.claimant_name || null,
        respondentId: data.respondent_id,
        disputeType: data.dispute_type,
        status: data.status,
        priority: data.priority,
        disputedAmount: Number(Number(data.disputed_amount || 0).toFixed(2)),
        settledAmount: data.settled_amount !== null
          ? Number(Number(data.settled_amount).toFixed(2))
          : null,
        currency: data.currency,
        description: data.description,
        evidence: data.evidence || [],
        assignedTo: data.assigned_to,
        assignedToName: data.assigned_to_name || null,
        assignedAt: data.assigned_at,
        resolution: data.resolution,
        resolutionReason: data.resolution_reason,
        resolvedBy: data.resolved_by,
        resolvedAt: data.resolved_at,
        rejectionReason: data.rejection_reason,
        financialAction: data.financial_action,
        financialReferenceId: data.financial_reference_id,
        metadata: data.metadata || {},
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    });

    return {
      disputes,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
    };
  }

  /**
   * Retrieves single dispute by ID with joined entities.
   */
  async getDisputeById(id, client = null) {
    const sql = `
      SELECT
        dp.id,
        dp.dispute_number,
        dp.booking_id,
        dp.customer_id,
        dp.partner_id,
        dp.vehicle_id,
        dp.damage_report_id,
        dp.claimant_id,
        dp.respondent_id,
        dp.dispute_type,
        dp.status,
        dp.priority,
        dp.disputed_amount,
        dp.settled_amount,
        dp.currency,
        dp.description,
        dp.evidence,
        dp.assigned_to,
        dp.assigned_at,
        dp.resolution,
        dp.resolution_reason,
        dp.resolved_by,
        dp.resolved_at,
        dp.rejection_reason,
        dp.financial_action,
        dp.financial_reference_id,
        dp.metadata,
        dp.created_at,
        dp.updated_at,
        b.booking_number,
        b.status AS booking_status,
        v.registration_number,
        v.brand AS vehicle_brand,
        v.model AS vehicle_model,
        pt.business_name AS partner_business_name,
        pt.contact_phone AS partner_phone,
        cust.name AS customer_name,
        cust.email AS customer_email,
        cust.phone AS customer_phone,
        clm.name AS claimant_name,
        clm.role AS claimant_role,
        rsp.name AS respondent_name,
        rsp.role AS respondent_role,
        asg.name AS assigned_to_name,
        asg.email AS assigned_to_email,
        res.name AS resolved_by_name,
        dr.damage_type AS damage_report_type,
        dr.status AS damage_report_status,
        dr.estimated_amount AS damage_estimated_amount,
        dr.approved_amount AS damage_approved_amount
      FROM disputes dp
      LEFT JOIN bookings b ON dp.booking_id = b.id
      LEFT JOIN vehicles v ON dp.vehicle_id = v.id
      LEFT JOIN partners pt ON dp.partner_id = pt.id
      LEFT JOIN users cust ON dp.customer_id = cust.id
      LEFT JOIN users clm ON dp.claimant_id = clm.id
      LEFT JOIN users rsp ON dp.respondent_id = rsp.id
      LEFT JOIN users asg ON dp.assigned_to = asg.id
      LEFT JOIN users res ON dp.resolved_by = res.id
      LEFT JOIN damage_reports dr ON dp.damage_report_id = dr.id
      WHERE dp.id = $1
      LIMIT 1;
    `;

    const res = await this._exec(sql, [id], client);
    if (!res.rows[0]) return null;

    const row = res.rows[0];
    return {
      id: row.id,
      disputeNumber: row.dispute_number,
      bookingId: row.booking_id,
      booking: row.booking_number ? {
        id: row.booking_id,
        bookingNumber: row.booking_number,
        status: row.booking_status,
      } : null,
      customerId: row.customer_id,
      customer: row.customer_name ? {
        id: row.customer_id,
        name: row.customer_name,
        email: row.customer_email,
        phone: row.customer_phone,
      } : null,
      partnerId: row.partner_id,
      partner: row.partner_business_name ? {
        id: row.partner_id,
        businessName: row.partner_business_name,
        phone: row.partner_phone,
      } : null,
      vehicleId: row.vehicle_id,
      vehicle: row.registration_number ? {
        id: row.vehicle_id,
        registrationNumber: row.registration_number,
        brand: row.vehicle_brand,
        model: row.vehicle_model,
      } : null,
      damageReportId: row.damage_report_id,
      damageReport: row.damage_report_type ? {
        id: row.damage_report_id,
        damageType: row.damage_report_type,
        status: row.damage_report_status,
        estimatedAmount: Number(row.damage_estimated_amount || 0),
        approvedAmount: row.damage_approved_amount !== null
          ? Number(row.damage_approved_amount)
          : null,
      } : null,
      claimantId: row.claimant_id,
      claimant: row.claimant_name ? {
        id: row.claimant_id,
        name: row.claimant_name,
        role: row.claimant_role,
      } : null,
      respondentId: row.respondent_id,
      respondent: row.respondent_name ? {
        id: row.respondent_id,
        name: row.respondent_name,
        role: row.respondent_role,
      } : null,
      disputeType: row.dispute_type,
      status: row.status,
      priority: row.priority,
      disputedAmount: Number(Number(row.disputed_amount || 0).toFixed(2)),
      settledAmount: row.settled_amount !== null
        ? Number(Number(row.settled_amount).toFixed(2))
        : null,
      currency: row.currency,
      description: row.description,
      evidence: row.evidence || [],
      assignedTo: row.assigned_to,
      assignedAdmin: row.assigned_to_name ? {
        id: row.assigned_to,
        name: row.assigned_to_name,
        email: row.assigned_to_email,
      } : null,
      assignedAt: row.assigned_at,
      resolution: row.resolution,
      resolutionReason: row.resolution_reason,
      resolvedBy: row.resolved_by,
      resolver: row.resolved_by_name ? {
        id: row.resolved_by,
        name: row.resolved_by_name,
      } : null,
      resolvedAt: row.resolved_at,
      rejectionReason: row.rejection_reason,
      financialAction: row.financial_action,
      financialReferenceId: row.financial_reference_id,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Acquire row lock on dispute for concurrent mutation.
   */
  async getDisputeForUpdate(client, id) {
    const sql = `
      SELECT *
      FROM disputes
      WHERE id = $1
      FOR UPDATE;
    `;
    const res = await client.query(sql, [id]);
    return res.rows[0] || null;
  }

  /**
   * Insert new dispute.
   */
  async createDispute(data, client = null) {
    const {
      disputeNumber,
      bookingId,
      customerId,
      partnerId,
      vehicleId = null,
      damageReportId = null,
      claimantId,
      respondentId = null,
      disputeType = 'GENERAL',
      status = 'OPEN',
      priority = 'MEDIUM',
      disputedAmount = 0.00,
      settledAmount = 0.00,
      currency = 'INR',
      description,
      evidence = [],
      metadata = {},
    } = data;

    const sql = `
      INSERT INTO disputes (
        dispute_number,
        booking_id,
        customer_id,
        partner_id,
        vehicle_id,
        damage_report_id,
        claimant_id,
        respondent_id,
        dispute_type,
        status,
        priority,
        disputed_amount,
        settled_amount,
        currency,
        description,
        evidence,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *;
    `;

    const params = [
      disputeNumber,
      bookingId,
      customerId,
      partnerId,
      vehicleId,
      damageReportId,
      claimantId,
      respondentId,
      disputeType,
      status,
      priority,
      Number(disputedAmount),
      Number(settledAmount),
      currency,
      description,
      evidence,
      metadata,
    ];

    const res = await this._exec(sql, params, client);
    return res.rows[0];
  }

  /**
   * Assign or reassign dispute to an admin user.
   */
  async assignDispute(client, id, { assignedTo, assignedAt = new Date() }) {
    const sql = `
      UPDATE disputes
      SET
        assigned_to = $1,
        assigned_at = $2,
        status = CASE WHEN status = 'OPEN' THEN 'UNDER_INVESTIGATION' ELSE status END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *;
    `;
    const res = await client.query(sql, [assignedTo, assignedAt, id]);
    return res.rows[0] || null;
  }

  /**
   * Update dispute status on resolution or rejection.
   */
  async updateDisputeStatus(client, id, {
    status,
    resolution = null,
    resolutionReason = null,
    rejectionReason = null,
    settledAmount = null,
    resolvedBy = null,
    resolvedAt = new Date(),
    financialAction = null,
    financialReferenceId = null,
    metadata = null,
  }) {
    const sql = `
      UPDATE disputes
      SET
        status = $1,
        resolution = COALESCE($2, resolution),
        resolution_reason = COALESCE($3, resolution_reason),
        rejection_reason = COALESCE($4, rejection_reason),
        settled_amount = COALESCE($5, settled_amount),
        resolved_by = COALESCE($6, resolved_by),
        resolved_at = COALESCE($7, resolved_at),
        financial_action = COALESCE($8, financial_action),
        financial_reference_id = COALESCE($9, financial_reference_id),
        metadata = CASE WHEN $10::jsonb IS NOT NULL THEN metadata || $10::jsonb ELSE metadata END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING *;
    `;

    const params = [
      status,
      resolution,
      resolutionReason,
      rejectionReason,
      settledAmount !== null ? Number(settledAmount) : null,
      resolvedBy,
      resolvedAt,
      financialAction,
      financialReferenceId,
      metadata ? JSON.stringify(metadata) : null,
      id,
    ];

    const res = await client.query(sql, params);
    return res.rows[0] || null;
  }

  /**
   * Retrieves timeline events for a dispute from admin_actions.
   */
  async getDisputeTimeline(disputeId, client = null) {
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
      WHERE target_resource = 'DISPUTE' AND target_resource_id = $1
      ORDER BY created_at ASC;
    `;

    const res = await this._exec(sql, [disputeId], client);
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
   * Helper to verify if an admin user exists and is active.
   */
  async getActiveAdminUser(userId, client = null) {
    const sql = `
      SELECT id, role, is_active, name, email
      FROM users
      WHERE id = $1
      LIMIT 1;
    `;
    const res = await this._exec(sql, [userId], client);
    return res.rows[0] || null;
  }
}

const adminDamageDisputeRepository = new AdminDamageDisputeRepository();

adminDamageDisputeRepository.adminDamageDisputeRepository = adminDamageDisputeRepository;
adminDamageDisputeRepository.AdminDamageDisputeRepository = AdminDamageDisputeRepository;
adminDamageDisputeRepository.setMockDamageDisputeResolver = setMockDamageDisputeResolver;
adminDamageDisputeRepository.resetMockDamageDisputeResolver = resetMockDamageDisputeResolver;

module.exports = adminDamageDisputeRepository;
