'use strict';

const BaseRepository = require('../db/base.repository');

class AdminReviewRepository extends BaseRepository {
  constructor() {
    super('reviews', 'id');
  }

  _getExecutor(client) {
    return client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
  }

  async listReviews({ search, status, rating, partnerId, vehicleId, page = 1, limit = 20 } = {}, client = null) {
    const executor = this._getExecutor(client);
    const conditions = [];
    const params = [];
    let pIdx = 1;

    if (search && search.trim()) {
      conditions.push(`(r.review_text ILIKE $${pIdx} OR b.booking_number ILIKE $${pIdx})`);
      params.push(`%${search.trim()}%`);
      pIdx++;
    }

    if (status) {
      conditions.push(`r.status = $${pIdx}`);
      params.push(status);
      pIdx++;
    }

    if (rating) {
      conditions.push(`r.rating = $${pIdx}`);
      params.push(parseInt(rating, 10));
      pIdx++;
    }

    if (partnerId) {
      conditions.push(`r.partner_id = $${pIdx}`);
      params.push(partnerId);
      pIdx++;
    }

    if (vehicleId) {
      conditions.push(`r.vehicle_id = $${pIdx}`);
      params.push(vehicleId);
      pIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    try {
      const countSql = `SELECT COUNT(*)::int AS total FROM reviews r LEFT JOIN bookings b ON r.booking_id = b.id ${whereClause};`;
      const dataSql = `
        SELECT r.id, r.booking_id, r.customer_id, r.partner_id, r.vehicle_id,
               r.rating, r.review_text, r.status, r.created_at, r.updated_at,
               b.booking_number,
               u.phone AS customer_phone,
               pt.business_name AS partner_name,
               v.registration_number AS vehicle_reg
        FROM reviews r
        LEFT JOIN bookings b ON r.booking_id = b.id
        LEFT JOIN users u ON r.customer_id = u.id
        LEFT JOIN partners pt ON r.partner_id = pt.id
        LEFT JOIN vehicles v ON r.vehicle_id = v.id
        ${whereClause}
        ORDER BY r.created_at DESC
        LIMIT $${pIdx} OFFSET $${pIdx + 1};
      `;

      const [countRes, dataRes] = await Promise.all([
        executor(countSql, params),
        executor(dataSql, [...params, safeLimit, offset]),
      ]);

      const total = countRes.rows[0] ? Number(countRes.rows[0].total) : 0;
      return {
        reviews: dataRes.rows || [],
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 1,
      };
    } catch (_) {
      return { reviews: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    }
  }

  async findReviewById(id, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT r.*,
               b.booking_number,
               u.phone AS customer_phone,
               pt.business_name AS partner_name,
               v.registration_number AS vehicle_reg
        FROM reviews r
        LEFT JOIN bookings b ON r.booking_id = b.id
        LEFT JOIN users u ON r.customer_id = u.id
        LEFT JOIN partners pt ON r.partner_id = pt.id
        LEFT JOIN vehicles v ON r.vehicle_id = v.id
        WHERE r.id = $1
        LIMIT 1;
      `;
      const res = await executor(sql, [id]);
      if (!res.rows[0]) return null;

      const review = res.rows[0];

      // Fetch replies & reports
      const [repliesRes, reportsRes] = await Promise.all([
        executor(`SELECT * FROM review_replies WHERE review_id = $1 ORDER BY created_at ASC;`, [id]).catch(() => ({ rows: [] })),
        executor(`SELECT * FROM review_reports WHERE review_id = $1 ORDER BY created_at DESC;`, [id]).catch(() => ({ rows: [] })),
      ]);

      return {
        ...review,
        replies: repliesRes.rows || [],
        reports: reportsRes.rows || [],
      };
    } catch (_) {
      return null;
    }
  }

  async updateReviewStatus(id, status, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        UPDATE reviews
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *;
      `;
      const res = await executor(sql, [status, id]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }

  async listReviewReports({ status, page = 1, limit = 20 } = {}, client = null) {
    const executor = this._getExecutor(client);
    const conditions = [];
    const params = [];
    let pIdx = 1;

    if (status) {
      conditions.push(`rr.status = $${pIdx}`);
      params.push(status);
      pIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    try {
      const countSql = `SELECT COUNT(*)::int AS total FROM review_reports rr ${whereClause};`;
      const dataSql = `
        SELECT rr.*, r.review_text, r.rating, r.status AS review_status,
               u.phone AS reporter_phone
        FROM review_reports rr
        LEFT JOIN reviews r ON rr.review_id = r.id
        LEFT JOIN users u ON rr.reported_by = u.id
        ${whereClause}
        ORDER BY rr.created_at DESC
        LIMIT $${pIdx} OFFSET $${pIdx + 1};
      `;

      const [countRes, dataRes] = await Promise.all([
        executor(countSql, params),
        executor(dataSql, [...params, safeLimit, offset]),
      ]);

      const total = countRes.rows[0] ? Number(countRes.rows[0].total) : 0;
      return {
        reports: dataRes.rows || [],
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 1,
      };
    } catch (_) {
      return { reports: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    }
  }

  async resolveReviewReport(id, { resolvedBy, resolutionNote, newStatus = 'resolved' }, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        UPDATE review_reports
        SET status = $1,
            resolved_by = $2,
            resolved_at = CURRENT_TIMESTAMP,
            resolution_note = $3,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING *;
      `;
      const res = await executor(sql, [newStatus, resolvedBy, resolutionNote, id]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }
}

module.exports = new AdminReviewRepository();
