'use strict';

const BaseRepository = require('../db/base.repository');
const { escapeLikeString } = require('../db/sql-helpers');

let mockReportsResolver = null;

class AdminReportsRepository extends BaseRepository {
  constructor() {
    super('reports', 'id');
  }

  /**
   * Injects mock resolver for unit testing.
   * @param {object|null} resolver
   */
  static setMockReportsResolver(resolver) {
    mockReportsResolver = resolver;
  }

  static resetMockReportsResolver() {
    mockReportsResolver = null;
  }

  /**
   * Helper to return client or repository query executor.
   * @private
   */
  _getExecutor(client) {
    return client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
  }

  /**
   * Bounded pagination helper.
   * @private
   */
  _buildPagination(page, limit, maxLimit = 100) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, Math.min(maxLimit, parseInt(limit, 10) || 20));
    const offset = (safePage - 1) * safeLimit;
    return { safePage, safeLimit, offset };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. OPERATIONAL SUMMARY
  // ══════════════════════════════════════════════════════════════════════════════

  async getOperationalSummary(startDate = null, endDate = null, client = null) {
    if (mockReportsResolver && mockReportsResolver.getOperationalSummary) {
      return mockReportsResolver.getOperationalSummary(startDate, endDate);
    }

    const executor = this._getExecutor(client);
    const hasDateRange = startDate instanceof Date && endDate instanceof Date;
    const dateParams = hasDateRange ? [startDate, endDate] : [];

    const customersSql = hasDateRange
      ? `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE is_active = true)::int AS active,
           COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS in_range
         FROM users WHERE role = 'CUSTOMER';`
      : `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE is_active = true)::int AS active,
           COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days')::int AS in_range
         FROM users WHERE role = 'CUSTOMER';`;

    const partnersSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE partner_status = 'ONLINE')::int AS online,
        COUNT(*) FILTER (WHERE kyc_status = 'VERIFIED')::int AS verified,
        COUNT(*) FILTER (WHERE kyc_status IN ('PENDING', 'UNDER_REVIEW'))::int AS pending_kyc
      FROM partners;
    `;

    const vehiclesSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE manual_status = 'ONLINE')::int AS active,
        COUNT(*) FILTER (WHERE rental_status = 'IDLE')::int AS idle,
        COUNT(*) FILTER (WHERE rental_status IN ('BOOKED', 'ACTIVE'))::int AS booked
      FROM vehicles
      WHERE is_active = true;
    `;

    const bookingsSql = hasDateRange
      ? `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE booking_status = 'COMPLETED')::int AS completed,
           COUNT(*) FILTER (WHERE booking_status = 'CANCELLED')::int AS cancelled,
           COUNT(*) FILTER (WHERE booking_status = 'ACTIVE')::int AS active,
           COALESCE(SUM(total_amount) FILTER (WHERE booking_status = 'COMPLETED'), 0)::numeric AS gross_booking_value
         FROM bookings
         WHERE created_at >= $1 AND created_at < $2;`
      : `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE booking_status = 'COMPLETED')::int AS completed,
           COUNT(*) FILTER (WHERE booking_status = 'CANCELLED')::int AS cancelled,
           COUNT(*) FILTER (WHERE booking_status = 'ACTIVE')::int AS active,
           COALESCE(SUM(total_amount) FILTER (WHERE booking_status = 'COMPLETED'), 0)::numeric AS gross_booking_value
         FROM bookings;`;

    const paymentsSql = hasDateRange
      ? `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS successful,
           COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCESS'), 0)::numeric AS collected,
           COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING'), 0)::numeric AS pending
         FROM payments
         WHERE created_at >= $1 AND created_at < $2;`
      : `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS successful,
           COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCESS'), 0)::numeric AS collected,
           COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING'), 0)::numeric AS pending
         FROM payments;`;

    const refundsSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
        COALESCE(SUM(refunded_amount), 0)::numeric AS total_refunded
      FROM refunds;
    `;

    const commissionsSql = `
      SELECT
        COALESCE(SUM(commission_amount) FILTER (WHERE status IN ('CALCULATED', 'SETTLED')), 0)::numeric AS total_commission
      FROM commission_records;
    `;

    const payoutsSql = `
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'COMPLETED'), 0)::numeric AS completed,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('REQUESTED', 'PROCESSING')), 0)::numeric AS pending
      FROM payouts;
    `;

    const supportSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS'))::int AS open_tickets,
        COUNT(*) FILTER (WHERE status IN ('RESOLVED', 'CLOSED'))::int AS resolved_tickets
      FROM support_tickets;
    `;

    const notificationsSql = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'SENT')::int AS sent,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
      FROM notifications;
    `;

    const [
      custRes,
      partRes,
      vehRes,
      bookRes,
      payRes,
      refRes,
      commRes,
      payoutRes,
      suppRes,
      notifRes,
    ] = await Promise.all([
      executor(customersSql, dateParams),
      executor(partnersSql, []),
      executor(vehiclesSql, []),
      executor(bookingsSql, dateParams),
      executor(paymentsSql, dateParams),
      executor(refundsSql, []),
      executor(commissionsSql, []),
      executor(payoutsSql, []),
      executor(supportSql, []),
      executor(notificationsSql, []),
    ]);

    const c = custRes.rows[0] || {};
    const p = partRes.rows[0] || {};
    const v = vehRes.rows[0] || {};
    const b = bookRes.rows[0] || {};
    const py = payRes.rows[0] || {};
    const rf = refRes.rows[0] || {};
    const cm = commRes.rows[0] || {};
    const po = payoutRes.rows[0] || {};
    const sp = suppRes.rows[0] || {};
    const nt = notifRes.rows[0] || {};

    return {
      customers: {
        total: Number(c.total || 0),
        active: Number(c.active || 0),
        inRange: Number(c.in_range || 0),
      },
      partners: {
        total: Number(p.total || 0),
        online: Number(p.online || 0),
        verified: Number(p.verified || 0),
        pendingKyc: Number(p.pending_kyc || 0),
      },
      vehicles: {
        total: Number(v.total || 0),
        active: Number(v.active || 0),
        booked: Number(v.booked || 0),
        idle: Number(v.idle || 0),
      },
      bookings: {
        total: Number(b.total || 0),
        completed: Number(b.completed || 0),
        cancelled: Number(b.cancelled || 0),
        active: Number(b.active || 0),
        grossBookingValue: Number(Number(b.gross_booking_value || 0).toFixed(2)),
      },
      payments: {
        total: Number(py.total || 0),
        successful: Number(py.successful || 0),
        collected: Number(Number(py.collected || 0).toFixed(2)),
        pending: Number(Number(py.pending || 0).toFixed(2)),
      },
      refunds: {
        total: Number(rf.total || 0),
        completed: Number(rf.completed || 0),
        totalRefunded: Number(Number(rf.total_refunded || 0).toFixed(2)),
      },
      commissions: {
        totalCommissionEarned: Number(Number(cm.total_commission || 0).toFixed(2)),
      },
      payouts: {
        completed: Number(Number(po.completed || 0).toFixed(2)),
        pending: Number(Number(po.pending || 0).toFixed(2)),
      },
      support: {
        total: Number(sp.total || 0),
        open: Number(sp.open_tickets || 0),
        resolved: Number(sp.resolved_tickets || 0),
      },
      notifications: {
        total: Number(nt.total || 0),
        sent: Number(nt.sent || 0),
        failed: Number(nt.failed || 0),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. BOOKINGS REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getBookingsReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getBookingsReport) {
      return mockReportsResolver.getBookingsReport(options);
    }

    const {
      startDate,
      endDate,
      status,
      city,
      partnerId,
      customerId,
      vehicleId,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`b.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`b.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (status) {
      conditions.push(`b.booking_status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    if (city) {
      conditions.push(`b.city ILIKE $${idx}`);
      params.push(`%${escapeLikeString(city.trim())}%`);
      idx += 1;
    }
    if (partnerId) {
      conditions.push(`b.partner_id = $${idx}::uuid`);
      params.push(partnerId);
      idx += 1;
    }
    if (customerId) {
      conditions.push(`b.customer_id = $${idx}::uuid`);
      params.push(customerId);
      idx += 1;
    }
    if (vehicleId) {
      conditions.push(`b.vehicle_id = $${idx}::uuid`);
      params.push(vehicleId);
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'b.created_at',
      total_amount: 'b.total_amount',
      start_datetime: 'b.start_datetime',
      booking_status: 'b.booking_status',
    };
    const sortCol = allowedSort[sortBy] || 'b.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT
        b.id AS "bookingId",
        b.booking_number AS "bookingNumber",
        u.name AS "customerName",
        u.phone AS "customerPhone",
        pt.business_name AS "partnerBusinessName",
        v.registration_number AS "vehicleRegistration",
        v.brand AS "vehicleBrand",
        v.model AS "vehicleModel",
        b.city AS "city",
        b.booking_status AS "bookingStatus",
        b.payment_status AS "paymentStatus",
        b.total_amount::numeric AS "totalAmount",
        b.start_datetime AS "startDatetime",
        b.end_datetime AS "endDatetime",
        ROUND((EXTRACT(EPOCH FROM (b.end_datetime - b.start_datetime)) / 3600)::numeric, 1) AS "durationHours",
        b.cancellation_reason AS "cancellationReason",
        b.created_at AS "createdAt",
        COUNT(*) OVER()::int AS full_count
      FROM bookings b
      LEFT JOIN users u ON b.customer_id = u.id
      LEFT JOIN partners pt ON b.partner_id = pt.id
      LEFT JOIN vehicles v ON b.vehicle_id = v.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      copy.totalAmount = Number(copy.totalAmount || 0);
      copy.durationHours = copy.durationHours !== null ? Number(copy.durationHours) : null;
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. CUSTOMERS REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getCustomersReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getCustomersReport) {
      return mockReportsResolver.getCustomersReport(options);
    }

    const {
      startDate,
      endDate,
      status,
      search,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = ["u.role = 'CUSTOMER'"];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`u.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`u.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (status !== undefined && status !== null && status !== '') {
      const isActive = status === 'ACTIVE' || status === true || status === 'true';
      conditions.push(`u.is_active = $${idx}`);
      params.push(isActive);
      idx += 1;
    }
    if (search && search.trim() !== '') {
      const term = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(u.name ILIKE $${idx} OR u.email ILIKE $${idx} OR u.phone ILIKE $${idx})`);
      params.push(term);
      idx += 1;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const allowedSort = {
      created_at: 'u.created_at',
      name: 'u.name',
      total_bookings: 'total_bookings',
      total_spend: 'total_spend',
    };
    const sortCol = allowedSort[sortBy] || 'u.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT
        u.id AS "customerId",
        u.name AS "name",
        u.email AS "email",
        u.phone AS "phone",
        CASE WHEN u.is_active = true THEN 'ACTIVE' ELSE 'INACTIVE' END AS "accountStatus",
        u.created_at AS "registrationDate",
        COUNT(b.id)::int AS "totalBookings",
        COUNT(b.id) FILTER (WHERE b.booking_status = 'COMPLETED')::int AS "completedBookings",
        COUNT(b.id) FILTER (WHERE b.booking_status = 'CANCELLED')::int AS "cancelledBookings",
        COALESCE(SUM(b.total_amount) FILTER (WHERE b.payment_status = 'PAID' OR b.booking_status = 'COMPLETED'), 0)::numeric AS "totalSpend",
        COUNT(*) OVER()::int AS full_count
      FROM users u
      LEFT JOIN bookings b ON b.customer_id = u.id
      ${whereClause}
      GROUP BY u.id
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      copy.totalSpend = Number(Number(copy.totalSpend || 0).toFixed(2));
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. PARTNERS REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getPartnersReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getPartnersReport) {
      return mockReportsResolver.getPartnersReport(options);
    }

    const {
      startDate,
      endDate,
      status,
      kycStatus,
      city,
      search,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`p.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`p.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (status) {
      conditions.push(`p.partner_status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    if (kycStatus) {
      conditions.push(`p.kyc_status = $${idx}`);
      params.push(kycStatus);
      idx += 1;
    }
    if (city) {
      conditions.push(`p.city ILIKE $${idx}`);
      params.push(`%${escapeLikeString(city.trim())}%`);
      idx += 1;
    }
    if (search && search.trim() !== '') {
      const term = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(p.business_name ILIKE $${idx} OR u.name ILIKE $${idx} OR u.email ILIKE $${idx} OR u.phone ILIKE $${idx})`);
      params.push(term);
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'p.created_at',
      business_name: 'p.business_name',
      total_vehicles: 'total_vehicles',
      total_bookings: 'total_bookings',
    };
    const sortCol = allowedSort[sortBy] || 'p.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT
        p.id AS "partnerId",
        p.business_name AS "businessName",
        u.name AS "ownerName",
        u.email AS "email",
        u.phone AS "phone",
        p.city AS "city",
        p.partner_status AS "partnerStatus",
        p.kyc_status AS "kycStatus",
        COUNT(DISTINCT v.id)::int AS "totalVehicles",
        COUNT(DISTINCT v.id) FILTER (WHERE v.manual_status = 'ONLINE')::int AS "activeVehicles",
        COUNT(DISTINCT b.id)::int AS "totalBookings",
        COUNT(DISTINCT b.id) FILTER (WHERE b.booking_status = 'COMPLETED')::int AS "completedBookings",
        p.created_at AS "registrationDate",
        COUNT(*) OVER()::int AS full_count
      FROM partners p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN vehicles v ON v.partner_id = p.id AND v.is_active = true
      LEFT JOIN bookings b ON b.partner_id = p.id
      ${whereClause}
      GROUP BY p.id, u.id
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. VEHICLES REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getVehiclesReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getVehiclesReport) {
      return mockReportsResolver.getVehiclesReport(options);
    }

    const {
      startDate,
      endDate,
      partnerId,
      city,
      verificationStatus,
      rentalStatus,
      search,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = ['v.is_active = true'];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`v.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`v.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (partnerId) {
      conditions.push(`v.partner_id = $${idx}::uuid`);
      params.push(partnerId);
      idx += 1;
    }
    if (city) {
      conditions.push(`pt.city ILIKE $${idx}`);
      params.push(`%${escapeLikeString(city.trim())}%`);
      idx += 1;
    }
    if (verificationStatus) {
      conditions.push(`v.verification_status = $${idx}`);
      params.push(verificationStatus);
      idx += 1;
    }
    if (rentalStatus) {
      conditions.push(`v.rental_status = $${idx}`);
      params.push(rentalStatus);
      idx += 1;
    }
    if (search && search.trim() !== '') {
      const term = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(v.registration_number ILIKE $${idx} OR v.brand ILIKE $${idx} OR v.model ILIKE $${idx} OR pt.business_name ILIKE $${idx})`);
      params.push(term);
      idx += 1;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const allowedSort = {
      created_at: 'v.created_at',
      registration_number: 'v.registration_number',
      total_bookings: 'total_bookings',
      total_revenue: 'total_revenue',
    };
    const sortCol = allowedSort[sortBy] || 'v.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT
        v.id AS "vehicleId",
        v.registration_number AS "registrationNumber",
        pt.business_name AS "partnerBusinessName",
        v.brand AS "brand",
        v.model AS "model",
        pt.city AS "city",
        v.verification_status AS "verificationStatus",
        v.rental_status AS "rentalStatus",
        v.manual_status AS "manualStatus",
        COUNT(b.id)::int AS "totalBookings",
        COUNT(b.id) FILTER (WHERE b.booking_status = 'COMPLETED')::int AS "completedBookings",
        COALESCE(SUM(b.total_amount) FILTER (WHERE b.booking_status = 'COMPLETED'), 0)::numeric AS "totalRevenue",
        v.created_at AS "createdAt",
        COUNT(*) OVER()::int AS full_count
      FROM vehicles v
      LEFT JOIN partners pt ON v.partner_id = pt.id
      LEFT JOIN bookings b ON b.vehicle_id = v.id
      ${whereClause}
      GROUP BY v.id, pt.business_name, pt.city
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      copy.totalRevenue = Number(Number(copy.totalRevenue || 0).toFixed(2));
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 6. PAYMENTS REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getPaymentsReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getPaymentsReport) {
      return mockReportsResolver.getPaymentsReport(options);
    }

    const {
      startDate,
      endDate,
      status,
      provider,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`p.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`p.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (status) {
      conditions.push(`p.status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    if (provider) {
      conditions.push(`p.provider = $${idx}`);
      params.push(provider);
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'p.created_at',
      amount: 'p.amount',
      status: 'p.status',
    };
    const sortCol = allowedSort[sortBy] || 'p.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Note: NEVER select card details, account numbers, or provider secret tokens
    const sql = `
      SELECT
        p.id AS "paymentId",
        p.booking_id AS "bookingId",
        b.booking_number AS "bookingNumber",
        u.name AS "customerName",
        pt.business_name AS "partnerBusinessName",
        p.amount::numeric AS "amount",
        p.currency AS "currency",
        p.payment_type AS "paymentType",
        p.provider AS "provider",
        p.provider_reference AS "providerReference",
        p.status AS "status",
        p.created_at AS "createdAt",
        p.updated_at AS "updatedAt",
        COUNT(*) OVER()::int AS full_count
      FROM payments p
      LEFT JOIN bookings b ON p.booking_id = b.id
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN partners pt ON b.partner_id = pt.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      copy.amount = Number(Number(copy.amount || 0).toFixed(2));
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 7. REFUNDS REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getRefundsReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getRefundsReport) {
      return mockReportsResolver.getRefundsReport(options);
    }

    const {
      startDate,
      endDate,
      status,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`r.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`r.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (status) {
      conditions.push(`r.status = $${idx}`);
      params.push(status);
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'r.created_at',
      requested_amount: 'r.requested_amount',
      status: 'r.status',
      requested_at: 'r.created_at',
    };
    const sortCol = allowedSort[sortBy] || 'r.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT
        r.id AS "refundId",
        r.refund_number AS "refundNumber",
        r.payment_id AS "paymentId",
        r.booking_id AS "bookingId",
        b.booking_number AS "bookingNumber",
        u.name AS "customerName",
        r.requested_amount::numeric AS "requestedAmount",
        r.approved_amount::numeric AS "approvedAmount",
        r.refunded_amount::numeric AS "refundedAmount",
        r.currency AS "currency",
        r.status AS "status",
        r.reason AS "reason",
        r.provider AS "provider",
        r.provider_refund_id AS "providerRefundId",
        r.processed_at AS "processedAt",
        r.created_at AS "createdAt",
        COUNT(*) OVER()::int AS full_count
      FROM refunds r
      LEFT JOIN bookings b ON r.booking_id = b.id
      LEFT JOIN users u ON r.customer_id = u.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      copy.requestedAmount = Number(Number(copy.requestedAmount || 0).toFixed(2));
      copy.approvedAmount = copy.approvedAmount !== null
        ? Number(Number(copy.approvedAmount).toFixed(2))
        : null;
      copy.refundedAmount = Number(Number(copy.refundedAmount || 0).toFixed(2));
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 8. COMMISSIONS REPORT (INTERNAL COMPANY DATA)
  // ══════════════════════════════════════════════════════════════════════════════

  async getCommissionsReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getCommissionsReport) {
      return mockReportsResolver.getCommissionsReport(options);
    }

    const {
      startDate,
      endDate,
      partnerId,
      status,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`cr.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`cr.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (partnerId) {
      conditions.push(`cr.partner_id = $${idx}::uuid`);
      params.push(partnerId);
      idx += 1;
    }
    if (status) {
      conditions.push(`cr.status = $${idx}`);
      params.push(status);
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'cr.created_at',
      commission_amount: 'cr.commission_amount',
      gross_booking_amount: 'cr.gross_booking_amount',
      status: 'cr.status',
    };
    const sortCol = allowedSort[sortBy] || 'cr.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT
        cr.id AS "commissionId",
        cr.booking_id AS "bookingId",
        b.booking_number AS "bookingNumber",
        pt.business_name AS "partnerBusinessName",
        cr.commission_type AS "commissionType",
        cr.commission_rate::numeric AS "commissionRate",
        cr.gross_booking_amount::numeric AS "grossBookingAmount",
        cr.commission_amount::numeric AS "commissionAmount",
        cr.partner_payable_amount::numeric AS "partnerPayableAmount",
        cr.status AS "status",
        cr.created_at AS "createdAt",
        COUNT(*) OVER()::int AS full_count
      FROM commission_records cr
      LEFT JOIN bookings b ON cr.booking_id = b.id
      LEFT JOIN partners pt ON cr.partner_id = pt.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      copy.commissionRate = Number(copy.commissionRate || 0);
      copy.grossBookingAmount = Number(Number(copy.grossBookingAmount || 0).toFixed(2));
      copy.commissionAmount = Number(Number(copy.commissionAmount || 0).toFixed(2));
      copy.partnerPayableAmount = Number(Number(copy.partnerPayableAmount || 0).toFixed(2));
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 9. WALLETS REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getWalletsReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getWalletsReport) {
      return mockReportsResolver.getWalletsReport(options);
    }

    const {
      startDate,
      endDate,
      partnerId,
      transactionType,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`wt.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`wt.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (partnerId) {
      conditions.push(`w.partner_id = $${idx}::uuid`);
      params.push(partnerId);
      idx += 1;
    }
    if (transactionType) {
      conditions.push(`wt.type = $${idx}`);
      params.push(transactionType);
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'wt.created_at',
      amount: 'wt.amount',
      balance_after: 'wt.balance_after',
    };
    const sortCol = allowedSort[sortBy] || 'wt.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT
        wt.id AS "transactionId",
        wt.wallet_id AS "walletId",
        p.business_name AS "partnerBusinessName",
        wt.type AS "transactionType",
        wt.amount::numeric AS "amount",
        wt.balance_after::numeric AS "balanceAfter",
        wt.reference_type AS "referenceType",
        wt.reference_id AS "referenceId",
        wt.description AS "description",
        wt.created_at AS "createdAt",
        COUNT(*) OVER()::int AS full_count
      FROM wallet_transactions wt
      JOIN wallets w ON wt.wallet_id = w.id
      JOIN partners p ON w.partner_id = p.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      copy.amount = Number(Number(copy.amount || 0).toFixed(2));
      copy.balanceAfter = Number(Number(copy.balanceAfter || 0).toFixed(2));
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 10. PAYOUTS REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getPayoutsReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getPayoutsReport) {
      return mockReportsResolver.getPayoutsReport(options);
    }

    const {
      startDate,
      endDate,
      status,
      partnerId,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`po.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`po.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (status) {
      conditions.push(`po.status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    if (partnerId) {
      conditions.push(`po.partner_id = $${idx}::uuid`);
      params.push(partnerId);
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'po.created_at',
      amount: 'po.amount',
      status: 'po.status',
    };
    const sortCol = allowedSort[sortBy] || 'po.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Note: NEVER select unmasked account numbers
    const sql = `
      SELECT
        po.id AS "payoutId",
        po.partner_id AS "partnerId",
        pt.business_name AS "partnerBusinessName",
        po.amount::numeric AS "amount",
        po.status AS "status",
        ba.account_holder_name AS "accountHolderName",
        ba.bank_name AS "bankName",
        ba.account_number_masked AS "accountNumberMasked",
        ba.ifsc_code AS "ifscCode",
        po.requested_at AS "requestedAt",
        po.processed_at AS "processedAt",
        po.failure_reason AS "failureReason",
        po.created_at AS "createdAt",
        COUNT(*) OVER()::int AS full_count
      FROM payouts po
      JOIN partners pt ON po.partner_id = pt.id
      LEFT JOIN partner_bank_accounts ba ON po.bank_account_id = ba.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      copy.amount = Number(Number(copy.amount || 0).toFixed(2));
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 11. KYC / VERIFICATION REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getKycReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getKycReport) {
      return mockReportsResolver.getKycReport(options);
    }

    const {
      startDate,
      endDate,
      entityType,
      status,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (entityType) {
      conditions.push(`entity_type = $${idx}`);
      params.push(entityType.toUpperCase());
      idx += 1;
    }
    if (status) {
      conditions.push(`verification_status = $${idx}`);
      params.push(status);
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'created_at',
      document_type: 'document_type',
      verification_status: 'verification_status',
    };
    const sortCol = allowedSort[sortBy] || 'created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Note: NEVER select storage_key or generate private URLs in reports
    const sql = `
      WITH unified_docs AS (
        SELECT
          pd.id AS "documentId",
          'PARTNER' AS entity_type,
          pd.partner_id AS entity_id,
          p.business_name AS entity_name,
          pd.document_type,
          pd.document_name,
          pd.verification_status,
          pd.valid_till,
          pd.rejection_reason,
          pd.created_at
        FROM partner_documents pd
        JOIN partners p ON pd.partner_id = p.id

        UNION ALL

        SELECT
          vd.id AS "documentId",
          'VEHICLE' AS entity_type,
          vd.vehicle_id AS entity_id,
          v.registration_number AS entity_name,
          vd.document_type,
          vd.document_name,
          vd.verification_status,
          vd.valid_till,
          vd.rejection_reason,
          vd.created_at
        FROM vehicle_documents vd
        JOIN vehicles v ON vd.vehicle_id = v.id

        UNION ALL

        SELECT
          cd.id AS "documentId",
          'CUSTOMER' AS entity_type,
          cd.user_id AS entity_id,
          u.name AS entity_name,
          cd.document_type,
          cd.document_type AS document_name,
          cd.status AS verification_status,
          NULL::timestamptz AS valid_till,
          cd.rejection_reason,
          cd.created_at
        FROM customer_documents cd
        JOIN users u ON cd.user_id = u.id
      )
      SELECT
        "documentId",
        entity_type AS "entityType",
        entity_id AS "entityId",
        entity_name AS "entityName",
        document_type AS "documentType",
        document_name AS "documentName",
        verification_status AS "verificationStatus",
        valid_till AS "validTill",
        rejection_reason AS "rejectionReason",
        created_at AS "submittedAt",
        COUNT(*) OVER()::int AS full_count
      FROM unified_docs
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 12. SUPPORT TICKETS REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getSupportReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getSupportReport) {
      return mockReportsResolver.getSupportReport(options);
    }

    const {
      startDate,
      endDate,
      status,
      priority,
      category,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`st.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`st.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (status) {
      conditions.push(`st.status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    if (priority) {
      conditions.push(`st.priority = $${idx}`);
      params.push(priority);
      idx += 1;
    }
    if (category) {
      conditions.push(`st.category = $${idx}`);
      params.push(category);
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'st.created_at',
      priority: 'st.priority',
      status: 'st.status',
    };
    const sortCol = allowedSort[sortBy] || 'st.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sql = `
      SELECT
        st.id AS "ticketId",
        st.ticket_number AS "ticketNumber",
        st.category AS "category",
        st.priority AS "priority",
        st.status AS "status",
        u.name AS "customerName",
        pt.business_name AS "partnerBusinessName",
        b.booking_number AS "bookingNumber",
        adm.name AS "assignedAdminName",
        st.created_at AS "createdAt",
        st.resolved_at AS "resolvedAt",
        st.closed_at AS "closedAt",
        ROUND((EXTRACT(EPOCH FROM (st.resolved_at - st.created_at)) / 60)::numeric, 1) AS "resolutionDurationMinutes",
        COUNT(*) OVER()::int AS full_count
      FROM support_tickets st
      LEFT JOIN users u ON st.customer_id = u.id
      LEFT JOIN partners pt ON st.partner_id = pt.id
      LEFT JOIN bookings b ON st.booking_id = b.id
      LEFT JOIN users adm ON st.assigned_admin_id = adm.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      copy.resolutionDurationMinutes = copy.resolutionDurationMinutes !== null
        ? Number(copy.resolutionDurationMinutes)
        : null;
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 13. DISPUTES & DAMAGES REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getDisputesReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getDisputesReport) {
      return mockReportsResolver.getDisputesReport(options);
    }

    const {
      startDate,
      endDate,
      status,
      reportType,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (status) {
      conditions.push(`status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    if (reportType) {
      conditions.push(`report_type = $${idx}`);
      params.push(reportType.toUpperCase());
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'created_at',
      amount: 'amount',
      status: 'status',
    };
    const sortCol = allowedSort[sortBy] || 'created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Note: NEVER expose raw evidence images or private S3 URLs in dispute reports
    const sql = `
      WITH unified_disputes AS (
        SELECT
          dr.id AS "id",
          'DAMAGE' AS report_type,
          b.booking_number,
          u.name AS customer_name,
          pt.business_name AS partner_business_name,
          dr.status,
          COALESCE(dr.settlement_amount, dr.estimated_cost, 0)::numeric AS amount,
          dr.description AS reason_or_description,
          dr.created_at,
          dr.updated_at AS resolved_at
        FROM damage_reports dr
        LEFT JOIN bookings b ON dr.booking_id = b.id
        LEFT JOIN users u ON b.customer_id = u.id
        LEFT JOIN partners pt ON b.partner_id = pt.id

        UNION ALL

        SELECT
          dp.id AS "id",
          'DISPUTE' AS report_type,
          b.booking_number,
          u.name AS customer_name,
          pt.business_name AS partner_business_name,
          dp.status,
          COALESCE(dp.claim_amount, 0)::numeric AS amount,
          dp.dispute_reason AS reason_or_description,
          dp.created_at,
          dp.resolved_at
        FROM disputes dp
        LEFT JOIN bookings b ON dp.booking_id = b.id
        LEFT JOIN users u ON b.customer_id = u.id
        LEFT JOIN partners pt ON b.partner_id = pt.id
      )
      SELECT
        "id",
        report_type AS "reportType",
        booking_number AS "bookingNumber",
        customer_name AS "customerName",
        partner_business_name AS "partnerBusinessName",
        status AS "status",
        amount AS "amount",
        reason_or_description AS "reasonOrDescription",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt",
        COUNT(*) OVER()::int AS full_count
      FROM unified_disputes
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      copy.amount = Number(Number(copy.amount || 0).toFixed(2));
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 14. NOTIFICATIONS REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  async getNotificationsReport(options = {}, client = null) {
    if (mockReportsResolver && mockReportsResolver.getNotificationsReport) {
      return mockReportsResolver.getNotificationsReport(options);
    }

    const {
      startDate,
      endDate,
      channel,
      status,
      recipientType,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      maxLimit = 100,
    } = options;

    const { safePage, safeLimit, offset } = this._buildPagination(page, limit, maxLimit);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (startDate instanceof Date) {
      conditions.push(`n.created_at >= $${idx}`);
      params.push(startDate);
      idx += 1;
    }
    if (endDate instanceof Date) {
      conditions.push(`n.created_at < $${idx}`);
      params.push(endDate);
      idx += 1;
    }
    if (channel) {
      conditions.push(`n.channel = $${idx}`);
      params.push(channel);
      idx += 1;
    }
    if (status) {
      conditions.push(`n.status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    if (recipientType) {
      conditions.push(`n.recipient_role = $${idx}`);
      params.push(recipientType.toUpperCase());
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = {
      created_at: 'n.created_at',
      status: 'n.status',
      channel: 'n.channel',
    };
    const sortCol = allowedSort[sortBy] || 'n.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Note: NEVER select FCM device tokens or push secrets
    const sql = `
      SELECT
        n.id AS "notificationId",
        n.recipient_role AS "recipientRole",
        COALESCE(u.name, 'System') AS "recipientName",
        n.channel AS "channel",
        n.title AS "title",
        n.status AS "status",
        n.sent_at AS "sentAt",
        n.failed_at AS "failedAt",
        n.created_at AS "createdAt",
        COUNT(*) OVER()::int AS full_count
      FROM notifications n
      LEFT JOIN users u ON n.recipient_id = u.id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    params.push(safeLimit, offset);
    const executor = this._getExecutor(client);
    const res = await executor(sql, params);

    const total = res.rows.length > 0 ? res.rows[0].full_count : 0;
    const items = res.rows.map((row) => {
      const copy = { ...row };
      delete copy.full_count;
      return copy;
    });

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }
}

const instance = new AdminReportsRepository();
instance.AdminReportsRepository = AdminReportsRepository;

module.exports = instance;
