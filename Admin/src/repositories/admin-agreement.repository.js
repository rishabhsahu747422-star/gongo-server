'use strict';

const BaseRepository = require('../db/base.repository');

class AdminAgreementRepository extends BaseRepository {
  constructor() {
    super('rental_agreements', 'id');
  }

  _getExecutor(client) {
    return client
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
  }

  async listAgreements({ search, status, partnerId, customerId, page = 1, limit = 20 } = {}, client = null) {
    const executor = this._getExecutor(client);
    const conditions = [];
    const params = [];
    let pIdx = 1;

    if (search && search.trim()) {
      conditions.push(`ra.agreement_number ILIKE $${pIdx}`);
      params.push(`%${search.trim()}%`);
      pIdx++;
    }

    if (status) {
      conditions.push(`ra.status = $${pIdx}`);
      params.push(status);
      pIdx++;
    }

    if (partnerId) {
      conditions.push(`ra.partner_id = $${pIdx}`);
      params.push(partnerId);
      pIdx++;
    }

    if (customerId) {
      conditions.push(`ra.customer_id = $${pIdx}`);
      params.push(customerId);
      pIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    try {
      const countSql = `SELECT COUNT(*)::int AS total FROM rental_agreements ra ${whereClause};`;
      const dataSql = `
        SELECT ra.id, ra.booking_id, ra.customer_id, ra.partner_id, ra.vehicle_id,
               ra.agreement_number, ra.agreement_version, ra.rental_start_at, ra.rental_end_at,
               ra.rental_amount, ra.security_deposit, ra.extra_charges, ra.discount_amount,
               ra.tax_amount, ra.total_amount, ra.customer_accepted, ra.accepted_at,
               ra.partner_acknowledged, ra.acknowledged_at, ra.document_url, ra.storage_path,
               ra.status, ra.created_at, ra.updated_at,
               b.booking_number,
               u.phone AS customer_phone,
               pt.business_name AS partner_name,
               v.registration_number AS vehicle_reg
        FROM rental_agreements ra
        LEFT JOIN bookings b ON ra.booking_id = b.id
        LEFT JOIN users u ON ra.customer_id = u.id
        LEFT JOIN partners pt ON ra.partner_id = pt.id
        LEFT JOIN vehicles v ON ra.vehicle_id = v.id
        ${whereClause}
        ORDER BY ra.created_at DESC
        LIMIT $${pIdx} OFFSET $${pIdx + 1};
      `;

      const [countRes, dataRes] = await Promise.all([
        executor(countSql, params),
        executor(dataSql, [...params, safeLimit, offset]),
      ]);

      const total = countRes.rows[0] ? Number(countRes.rows[0].total) : 0;
      return {
        agreements: dataRes.rows || [],
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 1,
      };
    } catch (_) {
      return { agreements: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    }
  }

  async findAgreementById(id, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT ra.*,
               b.booking_number,
               u.phone AS customer_phone,
               pt.business_name AS partner_name,
               v.registration_number AS vehicle_reg
        FROM rental_agreements ra
        LEFT JOIN bookings b ON ra.booking_id = b.id
        LEFT JOIN users u ON ra.customer_id = u.id
        LEFT JOIN partners pt ON ra.partner_id = pt.id
        LEFT JOIN vehicles v ON ra.vehicle_id = v.id
        WHERE ra.id = $1
        LIMIT 1;
      `;
      const res = await executor(sql, [id]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }

  async findAgreementByBookingId(bookingId, client = null) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        SELECT ra.*,
               b.booking_number,
               u.phone AS customer_phone,
               pt.business_name AS partner_name,
               v.registration_number AS vehicle_reg
        FROM rental_agreements ra
        LEFT JOIN bookings b ON ra.booking_id = b.id
        LEFT JOIN users u ON ra.customer_id = u.id
        LEFT JOIN partners pt ON ra.partner_id = pt.id
        LEFT JOIN vehicles v ON ra.vehicle_id = v.id
        WHERE ra.booking_id = $1
        LIMIT 1;
      `;
      const res = await executor(sql, [bookingId]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }
}

module.exports = new AdminAgreementRepository();
