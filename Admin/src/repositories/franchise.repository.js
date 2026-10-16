'use strict';

const BaseRepository = require('../db/base.repository');

let mockFranchiseResolver = null;

class FranchiseRepository extends BaseRepository {
  constructor() {
    super('franchise_applications', 'id');
  }

  static setMockResolver(resolver) {
    mockFranchiseResolver = resolver;
  }

  static resetMockResolver() {
    mockFranchiseResolver = null;
  }

  async createApplication(data, client = null) {
    if (mockFranchiseResolver && mockFranchiseResolver.createApplication) {
      return mockFranchiseResolver.createApplication(data);
    }

    const sql = `
      INSERT INTO franchise_applications (
        applicant_name,
        phone,
        email,
        city,
        state,
        investment_capacity,
        business_experience,
        message,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new')
      RETURNING *;
    `;
    const params = [
      data.applicantName,
      data.phone,
      data.email,
      data.city,
      data.state || null,
      data.investmentCapacity || null,
      data.businessExperience || null,
      data.message || null,
    ];

    const res = client ? await client.query(sql, params) : await this.query(sql, params);
    return res.rows[0];
  }

  async findRecentDuplicate(phone, email, minutes = 10, client = null) {
    if (mockFranchiseResolver && mockFranchiseResolver.findRecentDuplicate) {
      return mockFranchiseResolver.findRecentDuplicate(phone, email, minutes);
    }

    const sql = `
      SELECT id, created_at
      FROM franchise_applications
      WHERE (phone = $1 OR LOWER(email) = LOWER($2))
        AND created_at >= NOW() - ($3 || ' minutes')::INTERVAL
      LIMIT 1;
    `;
    const res = client
      ? await client.query(sql, [phone, email, minutes])
      : await this.query(sql, [phone, email, minutes]);
    return res.rows[0] || null;
  }

  async listApplications({
    search = null,
    status = null,
    limit = 10,
    offset = 0,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  } = {}, client = null) {
    if (mockFranchiseResolver && mockFranchiseResolver.listApplications) {
      return mockFranchiseResolver.listApplications({
        search,
        status,
        limit,
        offset,
        sortBy,
        sortOrder,
      });
    }

    const conditions = [];
    const values = [];
    let idx = 1;

    if (search && typeof search === 'string' && search.trim()) {
      const pattern = `%${search.trim().replace(/([%_\\])/g, '\\$1')}%`;
      conditions.push(`(
        fa.applicant_name ILIKE $${idx} OR
        fa.email ILIKE $${idx} OR
        fa.phone ILIKE $${idx} OR
        fa.city ILIKE $${idx} OR
        fa.state ILIKE $${idx}
      )`);
      values.push(pattern);
      idx += 1;
    }

    if (status && status !== 'all' && typeof status === 'string' && status.trim()) {
      conditions.push(`fa.status = $${idx}`);
      values.push(status.toLowerCase().trim());
      idx += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*)::int AS total FROM franchise_applications fa ${whereClause};`;
    const countRes = client ? await client.query(countSql, values) : await this.query(countSql, values);
    const total = countRes.rows[0] ? countRes.rows[0].total : 0;

    const allowedSortCols = {
      created_at: 'created_at',
      updated_at: 'updated_at',
      applicant_name: 'applicant_name',
      status: 'status',
      city: 'city',
    };
    const orderCol = allowedSortCols[String(sortBy).toLowerCase()] || 'created_at';
    const orderDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const listSql = `
      SELECT
        fa.*,
        u.email AS reviewer_email,
        u.name AS reviewer_name
      FROM franchise_applications fa
      LEFT JOIN users u ON u.id = fa.reviewed_by
      ${whereClause}
      ORDER BY fa.${orderCol} ${orderDir}
      LIMIT $${idx} OFFSET $${idx + 1};
    `;
    const listValues = [...values, limit, offset];
    const listRes = client ? await client.query(listSql, listValues) : await this.query(listSql, listValues);

    return {
      items: listRes.rows,
      total,
    };
  }

  async getApplicationById(id, client = null) {
    if (mockFranchiseResolver && mockFranchiseResolver.getApplicationById) {
      return mockFranchiseResolver.getApplicationById(id);
    }

    const sql = `
      SELECT
        fa.*,
        u.email AS reviewer_email,
        u.name AS reviewer_name
      FROM franchise_applications fa
      LEFT JOIN users u ON u.id = fa.reviewed_by
      WHERE fa.id = $1
      LIMIT 1;
    `;
    const res = client ? await client.query(sql, [id]) : await this.query(sql, [id]);
    return res.rows[0] || null;
  }

  async updateStatus(id, { status, adminNotes = null, reviewedBy = null }, client = null) {
    if (mockFranchiseResolver && mockFranchiseResolver.updateStatus) {
      return mockFranchiseResolver.updateStatus(id, { status, adminNotes, reviewedBy });
    }

    const sql = `
      UPDATE franchise_applications
      SET
        status = $2,
        admin_notes = COALESCE($3, admin_notes),
        reviewed_by = COALESCE($4, reviewed_by),
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;
    const res = client
      ? await client.query(sql, [id, status, adminNotes, reviewedBy])
      : await this.query(sql, [id, status, adminNotes, reviewedBy]);
    return res.rows[0] || null;
  }
}

module.exports = new FranchiseRepository();
