'use strict';

const BaseRepository = require('../db/base.repository');
const { escapeLikeString } = require('../db/sql-helpers');

const ALLOWED_SORT_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'document_type',
  'verification_status',
]);

let mockStorageResolver = null;

class AdminStorageRepository extends BaseRepository {
  constructor() {
    super('partner_documents', 'id');
  }

  static setMockStorageResolver(resolver) {
    mockStorageResolver = resolver;
  }

  static resetMockStorageResolver() {
    mockStorageResolver = null;
  }

  async _execute(sql, values = [], client = null) {
    if (mockStorageResolver) {
      if (typeof mockStorageResolver === 'function') {
        return mockStorageResolver(sql, values);
      }
      return mockStorageResolver;
    }
    if (client) {
      return client.query(sql, values);
    }
    return this.query(sql, values);
  }

  /**
   * Builds the unified document CTE query SQL.
   * @private
   */
  _getUnifiedDocumentCte() {
    return `
      WITH all_documents AS (
        SELECT
          pd.id,
          'PARTNER' AS owner_type,
          pd.partner_id AS owner_id,
          p.business_name AS owner_name,
          u.email AS owner_email,
          u.phone AS owner_phone,
          pd.partner_id,
          NULL::uuid AS vehicle_id,
          p.user_id AS customer_id,
          pd.document_type,
          pd.document_type AS document_name,
          pd.document_number,
          NULL::date AS valid_till,
          pd.storage_key,
          pd.verification_status,
          true AS is_required,
          pd.version,
          pd.rejection_reason,
          pd.created_at,
          pd.updated_at
        FROM partner_documents pd
        JOIN partners p ON p.id = pd.partner_id
        JOIN users u ON u.id = p.user_id

        UNION ALL

        SELECT
          vd.id,
          'VEHICLE' AS owner_type,
          vd.vehicle_id AS owner_id,
          v.registration_number AS owner_name,
          u.email AS owner_email,
          u.phone AS owner_phone,
          v.partner_id,
          vd.vehicle_id,
          NULL::uuid AS customer_id,
          vd.document_type,
          vd.document_type AS document_name,
          vd.document_number,
          vd.expires_at AS valid_till,
          vd.storage_path AS storage_key,
          vd.verification_status,
          true AS is_required,
          1 AS version,
          vd.rejection_reason,
          vd.created_at,
          vd.updated_at
        FROM vehicle_documents vd
        JOIN vehicles v ON v.id = vd.vehicle_id
        JOIN partners p ON p.id = v.partner_id
        JOIN users u ON u.id = p.user_id

        UNION ALL

        SELECT
          cd.id,
          'CUSTOMER' AS owner_type,
          cd.customer_id AS owner_id,
          u.name AS owner_name,
          u.email AS owner_email,
          u.phone AS owner_phone,
          NULL::uuid AS partner_id,
          NULL::uuid AS vehicle_id,
          cd.customer_id AS customer_id,
          cd.document_type,
          cd.document_type AS document_name,
          cd.document_number,
          NULL::date AS valid_till,
          cd.storage_path AS storage_key,
          cd.verification_status AS verification_status,
          false AS is_required,
          1 AS version,
          cd.rejection_reason,
          cd.created_at,
          cd.updated_at
        FROM customer_documents cd
        JOIN users u ON u.id = cd.customer_id
      )
    `;
  }

  /**
   * Lists administrative documents with rich multi-field filtering, search, and pagination.
   *
   * @param {object} [options={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async listDocuments(options = {}, client = null) {
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const whereClauses = [];
    const values = [];
    let paramIndex = 1;

    // Search query over document_type, document_name, document_number, owner_name, owner_email
    if (options.search && typeof options.search === 'string' && options.search.trim()) {
      const escaped = `%${escapeLikeString(options.search.trim())}%`;
      whereClauses.push(`(
        document_type ILIKE $${paramIndex}
        OR document_name ILIKE $${paramIndex}
        OR document_number ILIKE $${paramIndex}
        OR owner_name ILIKE $${paramIndex}
        OR owner_email ILIKE $${paramIndex}
      )`);
      values.push(escaped);
      paramIndex += 1;
    }

    // Owner type filter (PARTNER, VEHICLE, CUSTOMER)
    const ownerTypeFilter = options.ownerType || options.entityType;
    if (ownerTypeFilter && typeof ownerTypeFilter === 'string' && ownerTypeFilter.trim()) {
      whereClauses.push(`owner_type = $${paramIndex}`);
      values.push(ownerTypeFilter.trim().toUpperCase());
      paramIndex += 1;
    }

    // Owner ID filter
    const ownerIdFilter = options.ownerId || options.entityId;
    if (ownerIdFilter && typeof ownerIdFilter === 'string' && ownerIdFilter.trim()) {
      whereClauses.push(`owner_id = $${paramIndex}::uuid`);
      values.push(ownerIdFilter.trim());
      paramIndex += 1;
    }

    // Direct partner ID filter
    if (options.partnerId && typeof options.partnerId === 'string' && options.partnerId.trim()) {
      whereClauses.push(`partner_id = $${paramIndex}::uuid`);
      values.push(options.partnerId.trim());
      paramIndex += 1;
    }

    // Direct vehicle ID filter
    if (options.vehicleId && typeof options.vehicleId === 'string' && options.vehicleId.trim()) {
      whereClauses.push(`vehicle_id = $${paramIndex}::uuid`);
      values.push(options.vehicleId.trim());
      paramIndex += 1;
    }

    // Direct customer ID filter
    if (options.customerId && typeof options.customerId === 'string' && options.customerId.trim()) {
      whereClauses.push(`customer_id = $${paramIndex}::uuid`);
      values.push(options.customerId.trim());
      paramIndex += 1;
    }

    // Document type filter
    if (options.documentType && typeof options.documentType === 'string' && options.documentType.trim()) {
      whereClauses.push(`document_type = $${paramIndex}`);
      values.push(options.documentType.trim().toUpperCase());
      paramIndex += 1;
    }

    // Verification status filter
    const statusFilter = options.verificationStatus || options.status;
    if (statusFilter && typeof statusFilter === 'string' && statusFilter.trim()) {
      whereClauses.push(`verification_status = $${paramIndex}`);
      values.push(statusFilter.trim().toUpperCase());
      paramIndex += 1;
    }

    // Has file filter
    if (options.hasFile !== undefined && options.hasFile !== null) {
      const hasFileBool = options.hasFile === true || options.hasFile === 'true';
      if (hasFileBool) {
        whereClauses.push('storage_key IS NOT NULL AND storage_key != \'\'');
      } else {
        whereClauses.push('(storage_key IS NULL OR storage_key = \'\')');
      }
    }

    // Date range bounds (startDate / fromDate / from)
    const start = options.startDate || options.fromDate || options.from;
    if (start) {
      const parsedStart = new Date(start);
      if (!Number.isNaN(parsedStart.getTime())) {
        whereClauses.push(`created_at >= $${paramIndex}`);
        values.push(parsedStart.toISOString());
        paramIndex += 1;
      }
    }

    // Date range bounds (endDate / toDate / to)
    const end = options.endDate || options.toDate || options.to;
    if (end) {
      const parsedEnd = new Date(end);
      if (!Number.isNaN(parsedEnd.getTime())) {
        whereClauses.push(`created_at <= $${paramIndex}`);
        values.push(parsedEnd.toISOString());
        paramIndex += 1;
      }
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Safe sorting
    const requestedSort = (options.sortBy || 'created_at').toLowerCase().trim();
    const sortBy = ALLOWED_SORT_COLUMNS.has(requestedSort) ? requestedSort : 'created_at';
    const sortOrder = (options.sortOrder || 'DESC').toUpperCase().trim() === 'ASC' ? 'ASC' : 'DESC';

    const cte = this._getUnifiedDocumentCte();

    // 1. Total count query
    const countSql = `
      ${cte}
      SELECT COUNT(*) AS total
      FROM all_documents
      ${whereSql};
    `;
    const countRes = await this._execute(countSql, values, client);
    const total = parseInt(countRes.rows[0]?.total || 0, 10);

    // 2. Items query
    const itemsSql = `
      ${cte}
      SELECT *
      FROM all_documents
      ${whereSql}
      ORDER BY ${sortBy} ${sortOrder}, id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;
    const itemsRes = await this._execute(itemsSql, [...values, limit, offset], client);
    const items = itemsRes.rows.map((row) => this._formatDocumentRow(row));

    const totalPages = Math.ceil(total / limit) || (total === 0 ? 1 : 0);

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    };
  }

  /**
   * Retrieves single document by ID from partner, vehicle, or customer documents.
   *
   * @param {string} id Document UUID
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findDocumentById(id, client = null) {
    const cte = this._getUnifiedDocumentCte();
    const sql = `
      ${cte}
      SELECT *
      FROM all_documents
      WHERE id = $1::uuid
      LIMIT 1;
    `;
    const res = await this._execute(sql, [id], client);
    if (!res.rows || res.rows.length === 0) return null;
    return this._formatDocumentRow(res.rows[0]);
  }

  /**
   * Retrieves documents belonging to a specific partner.
   *
   * @param {string} partnerId
   * @param {object} [_options={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ partner: object, documents: object[] }|null>}
   */
  async findDocumentsByPartner(partnerId, _options = {}, client = null) {
    const partnerSql = `
      SELECT p.id, p.business_name, p.kyc_status, p.city, u.name AS owner_name, u.email, u.phone
      FROM partners p
      JOIN users u ON u.id = p.user_id
      WHERE p.id = $1::uuid
      LIMIT 1;
    `;
    const partnerRes = await this._execute(partnerSql, [partnerId], client);
    if (!partnerRes.rows || partnerRes.rows.length === 0) return null;

    const partner = partnerRes.rows[0];

    const docsSql = `
      SELECT
        id,
        'PARTNER' AS owner_type,
        partner_id AS owner_id,
        document_type,
        document_name,
        document_number,
        valid_till,
        storage_key,
        verification_status,
        is_required,
        version,
        rejection_reason,
        created_at,
        updated_at
      FROM partner_documents
      WHERE partner_id = $1::uuid
      ORDER BY created_at DESC, id DESC;
    `;
    const docsRes = await this._execute(docsSql, [partnerId], client);
    const documents = docsRes.rows.map((row) => this._formatDocumentRow({
      ...row,
      owner_name: partner.business_name,
      owner_email: partner.email,
      owner_phone: partner.phone,
    }));

    return {
      partner: {
        id: partner.id,
        businessName: partner.business_name,
        kycStatus: partner.kyc_status,
        city: partner.city,
        ownerName: partner.owner_name,
        email: partner.email,
        phone: partner.phone,
      },
      documents,
    };
  }

  /**
   * Retrieves documents belonging to a specific vehicle.
   *
   * @param {string} vehicleId
   * @param {object} [_options={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ vehicle: object, documents: object[] }|null>}
   */
  async findDocumentsByVehicle(vehicleId, _options = {}, client = null) {
    const vehicleSql = `
      SELECT
        v.id,
        v.partner_id,
        v.registration_number,
        v.brand,
        v.model,
        v.verification_status,
        p.business_name AS partner_name
      FROM vehicles v
      JOIN partners p ON p.id = v.partner_id
      WHERE v.id = $1::uuid
      LIMIT 1;
    `;
    const vehicleRes = await this._execute(vehicleSql, [vehicleId], client);
    if (!vehicleRes.rows || vehicleRes.rows.length === 0) return null;

    const vehicle = vehicleRes.rows[0];

    const docsSql = `
      SELECT
        id,
        'VEHICLE' AS owner_type,
        vehicle_id AS owner_id,
        document_type,
        document_name,
        document_number,
        valid_till,
        storage_key,
        verification_status,
        is_required,
        version,
        rejection_reason,
        created_at,
        updated_at
      FROM vehicle_documents
      WHERE vehicle_id = $1::uuid
      ORDER BY created_at DESC, id DESC;
    `;
    const docsRes = await this._execute(docsSql, [vehicleId], client);
    const documents = docsRes.rows.map((row) => this._formatDocumentRow({
      ...row,
      owner_name: vehicle.registration_number,
    }));

    return {
      vehicle: {
        id: vehicle.id,
        partnerId: vehicle.partner_id,
        registrationNumber: vehicle.registration_number,
        brand: vehicle.brand,
        model: vehicle.model,
        verificationStatus: vehicle.verification_status,
        partnerName: vehicle.partner_name,
      },
      documents,
    };
  }

  /**
   * Retrieves documents belonging to a specific customer.
   *
   * @param {string} customerId
   * @param {object} [_options={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ customer: object, documents: object[] }|null>}
   */
  async findDocumentsByCustomer(customerId, _options = {}, client = null) {
    const userSql = `
      SELECT id, name, email, phone, role, is_active
      FROM users
      WHERE id = $1::uuid AND role = 'CUSTOMER'
      LIMIT 1;
    `;
    const userRes = await this._execute(userSql, [customerId], client);
    if (!userRes.rows || userRes.rows.length === 0) return null;

    const customer = userRes.rows[0];

    const docsSql = `
      SELECT
        id,
        'CUSTOMER' AS owner_type,
        user_id AS owner_id,
        document_type,
        document_type AS document_name,
        NULL AS document_number,
        NULL::date AS valid_till,
        storage_key,
        status AS verification_status,
        false AS is_required,
        1 AS version,
        rejection_reason,
        created_at,
        updated_at
      FROM customer_documents
      WHERE user_id = $1::uuid
      ORDER BY created_at DESC, id DESC;
    `;
    const docsRes = await this._execute(docsSql, [customerId], client);
    const documents = docsRes.rows.map((row) => this._formatDocumentRow({
      ...row,
      owner_name: customer.name,
      owner_email: customer.email,
      owner_phone: customer.phone,
    }));

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        isActive: customer.is_active,
      },
      documents,
    };
  }

  /**
   * Retrieves chronological administrative history for a document from admin_actions.
   *
   * @param {string} documentId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async findDocumentHistory(documentId, client = null) {
    const sql = `
      SELECT
        a.id,
        a.actor_id,
        a.actor_role,
        a.action,
        a.target_resource,
        a.target_resource_id,
        a.request_id,
        a.metadata,
        a.created_at,
        u.name AS actor_name,
        u.email AS actor_email
      FROM admin_actions a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE (
        a.target_resource_id = $1
        OR (a.metadata->>'documentId') = $1
      )
      ORDER BY a.created_at DESC, a.id DESC;
    `;
    const res = await this._execute(sql, [documentId], client);
    return res.rows.map((r) => ({
      id: r.id,
      actor: {
        id: r.actor_id,
        name: r.actor_name || null,
        email: r.actor_email || null,
        role: r.actor_role || 'ADMIN',
      },
      action: r.action,
      targetResource: r.target_resource,
      targetResourceId: r.target_resource_id,
      requestId: r.request_id,
      metadata: r.metadata || {},
      createdAt: r.created_at,
    }));
  }

  /**
   * Formats a raw document row into safe projection.
   *
   * @param {object} row
   * @returns {object}
   * @private
   */
  _formatDocumentRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      owner: {
        id: row.owner_id,
        name: row.owner_name || null,
        email: row.owner_email || null,
        phone: row.owner_phone || null,
      },
      documentType: row.document_type,
      documentName: row.document_name || row.document_type,
      documentNumber: row.document_number || null,
      validTill: row.valid_till || null,
      storageKey: row.storage_key || null,
      hasFile: Boolean(row.storage_key && row.storage_key.trim()),
      verificationStatus: row.verification_status || 'PENDING',
      isRequired: Boolean(row.is_required),
      version: row.version || 1,
      rejectionReason: row.rejection_reason || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

const instance = new AdminStorageRepository();
instance.AdminStorageRepository = AdminStorageRepository;

module.exports = instance;
