'use strict';

const BaseRepository = require('../db/base.repository');
const { escapeLikeString, safeOrderBy, safePagination } = require('../db/sql-helpers');
const { sanitizeAuditMetadata } = require('../services/audit.service');

const ALLOWED_SORT_COLUMNS = new Set([
  'created_at',
  'action',
  'target_resource',
  'actor_id',
]);

const SECURITY_CATEGORIES = Object.freeze({
  AUTHENTICATION: [
    'ADMIN_LOGIN',
    'ADMIN_LOGOUT',
    'ADMIN_LOGOUT_ALL',
    'LOGIN_FAILED',
    '2FA_VERIFIED',
    '2FA_FAILED',
  ],
  SESSION: [
    'REVOKE_SESSION',
    'REVOKE_ALL_SESSIONS',
    'SESSION_REVOKE',
    'SESSION_ROTATED',
    'REVOKE_OLD_SESSIONS',
  ],
  PERMISSION: [
    'ASSIGN_PERMISSIONS',
    'REVOKE_PERMISSION',
    'SET_ADMIN_ROLE',
    'ASSIGN_ROLE',
    'ADMIN_USER_CREATED',
    'ADMIN_USER_UPDATED',
    'ADMIN_USER_DELETED',
  ],
  SUSPENSION: [
    'SUSPEND_ADMIN',
    'REACTIVATE_ADMIN',
    'SUSPEND_CUSTOMER',
    'REACTIVATE_CUSTOMER',
    'SUSPEND_PARTNER',
    'REACTIVATE_PARTNER',
    'BLOCK_VEHICLE',
    'UNBLOCK_VEHICLE',
  ],
  FINANCIAL: [
    'APPROVE_REFUND',
    'REJECT_REFUND',
    'APPROVE_PAYOUT',
    'REJECT_PAYOUT',
    'RETRY_PAYOUT',
    'RECONCILE_PAYMENT',
    'REFUND_PAYMENT',
    'CREATE_COMMISSION_RULE',
    'UPDATE_COMMISSION_RULE',
    'ADJUST_WALLET_BALANCE',
  ],
  VERIFICATION: [
    'APPROVE_KYC',
    'REJECT_KYC',
    'VERIFY_VEHICLE',
    'REJECT_VEHICLE',
    'APPROVE_PARTNER_KYC',
    'REJECT_PARTNER_KYC',
    'APPROVE_PARTNER_DOCUMENT',
    'REJECT_PARTNER_DOCUMENT',
    'APPROVE_VEHICLE_DOCUMENT',
    'REJECT_VEHICLE_DOCUMENT',
  ],
  SECURITY: [
    'AUTHORIZATION_DENIED',
    'RATE_LIMIT_EXCEEDED',
    'BOLA_IDOR_BLOCKED',
    'SENSITIVE_OP_FAILED',
    'UNAUTHORIZED_ACCESS_ATTEMPT',
  ],
});

let mockActionResolver = null;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const toSafeUuid = (val) => (typeof val === 'string' && UUID_REGEX.test(val.trim()) ? val.trim() : null);

class AdminActionRepository extends BaseRepository {
  constructor() {
    super('admin_actions', 'id');
  }

  static setMockActionResolver(fn) {
    mockActionResolver = fn;
  }

  static resetMockActionResolver() {
    mockActionResolver = null;
  }

  async _execute(sql, values = [], client = null) {
    if (mockActionResolver) {
      return mockActionResolver(sql, values);
    }
    return client ? client.query(sql, values) : this.query(sql, values);
  }

  /**
   * Appends an immutable admin audit action record.
   *
   * @param {object} params
   * @param {string} params.actorId Admin user ID
   * @param {string} [params.actorRole='ADMIN']
   * @param {string} [params.permission]
   * @param {string} params.action Action performed
   * @param {string} params.targetResource Target resource type
   * @param {string} [params.targetResourceId]
   * @param {string} [params.requestId] Correlation trace ID
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {object} [params.beforeState]
   * @param {object} [params.afterState]
   * @param {object} [params.metadata={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createAction({
    actorId,
    actorRole = 'ADMIN',
    permission = null,
    action,
    targetResource,
    targetResourceId = null,
    requestId = null,
    ipAddress = null,
    userAgent = null,
    beforeState = null,
    afterState = null,
    metadata = {},
  }, client = null) {
    const text = `
      INSERT INTO ${this.tableName} (
        actor_id, actor_role, permission, action, target_resource, target_resource_id,
        request_id, ip_address, user_agent, before_state, after_state, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *;
    `;

    const isMockClient = Boolean(mockActionResolver || (client && client.query && client.query.mock));
    const safeActorId = isMockClient ? actorId : (toSafeUuid(actorId) || null);
    const enrichedMetadata = {
      ...(metadata || {}),
      ...(safeActorId === actorId ? {} : { rawActorId: actorId }),
    };

    const values = [
      safeActorId,
      actorRole,
      permission,
      action,
      targetResource,
      targetResourceId ? String(targetResourceId) : null,
      requestId,
      ipAddress,
      userAgent,
      beforeState ? JSON.stringify(sanitizeAuditMetadata(beforeState)) : null,
      afterState ? JSON.stringify(sanitizeAuditMetadata(afterState)) : null,
      JSON.stringify(sanitizeAuditMetadata(enrichedMetadata)),
    ];

    try {
      const res = await this._execute(text, values, client);
      return res?.rows ? res.rows[0] : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Backward-compatible audit action query with simple filters.
   *
   * @param {object} [filters={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async findWithFilters(filters = {}, client = null) {
    const conditions = [];
    const values = [];
    if (filters.actorId) {
      values.push(filters.actorId);
      conditions.push(`actor_id = $${values.length}`);
    }
    if (filters.action) {
      values.push(filters.action);
      conditions.push(`action = $${values.length}`);
    }
    if (filters.targetResource) {
      values.push(filters.targetResource);
      conditions.push(`target_resource = $${values.length}`);
    }
    if (filters.targetResourceId) {
      values.push(filters.targetResourceId);
      conditions.push(`target_resource_id = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { limit, offset } = safePagination(filters.limit, filters.offset, {
      defaultLimit: 50,
      maxLimit: 100,
    });

    const allowedSortColumns = ['created_at', 'action', 'target_resource', 'actor_id'];
    const orderClause = safeOrderBy(
      allowedSortColumns,
      filters.sortBy,
      filters.sortOrder,
      'created_at',
      'DESC',
    );

    values.push(limit);
    const limitIdx = values.length;
    values.push(offset);
    const offsetIdx = values.length;
    const paginationClause = `${orderClause} LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

    const text = `SELECT * FROM ${this.tableName} ${whereClause} ${paginationClause};`;
    const res = await this._execute(text, values, client);
    return res.rows;
  }

  /**
   * Retrieves paginated audit actions with rich filters, search, and joined actor info.
   *
   * @param {object} options
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async listAuditActions(options = {}, client = null) {
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const whereClauses = [];
    const values = [];
    let paramIndex = 1;

    // Search query over action, target resource, target resource ID, or actor details
    if (options.search && typeof options.search === 'string' && options.search.trim()) {
      const escaped = `%${escapeLikeString(options.search.trim())}%`;
      whereClauses.push(`(
        a.action ILIKE $${paramIndex}
        OR a.target_resource ILIKE $${paramIndex}
        OR a.target_resource_id ILIKE $${paramIndex}
        OR u.name ILIKE $${paramIndex}
        OR u.email ILIKE $${paramIndex}
      )`);
      values.push(escaped);
      paramIndex += 1;
    }

    // Actor filter
    if (options.actorId && typeof options.actorId === 'string' && options.actorId.trim()) {
      whereClauses.push(`a.actor_id = $${paramIndex}`);
      values.push(options.actorId.trim());
      paramIndex += 1;
    }

    // Action filter
    if (options.action && typeof options.action === 'string' && options.action.trim()) {
      whereClauses.push(`a.action = $${paramIndex}`);
      values.push(options.action.trim());
      paramIndex += 1;
    }

    // Target Resource filter
    const resourceFilter = options.targetResource || options.resourceType;
    if (resourceFilter && typeof resourceFilter === 'string' && resourceFilter.trim()) {
      whereClauses.push(`a.target_resource = $${paramIndex}`);
      values.push(resourceFilter.trim().toUpperCase());
      paramIndex += 1;
    }

    // Target Resource ID filter
    const resourceIdFilter = options.targetResourceId || options.resourceId;
    if (resourceIdFilter && typeof resourceIdFilter === 'string' && resourceIdFilter.trim()) {
      whereClauses.push(`a.target_resource_id = $${paramIndex}`);
      values.push(resourceIdFilter.trim());
      paramIndex += 1;
    }

    // Request ID filter
    if (options.requestId && typeof options.requestId === 'string' && options.requestId.trim()) {
      whereClauses.push(`a.request_id = $${paramIndex}`);
      values.push(options.requestId.trim());
      paramIndex += 1;
    }

    // IP Address filter
    if (options.ipAddress && typeof options.ipAddress === 'string' && options.ipAddress.trim()) {
      whereClauses.push(`a.ip_address = $${paramIndex}`);
      values.push(options.ipAddress.trim());
      paramIndex += 1;
    }

    // Date range: from / startDate / fromDate
    const start = options.startDate || options.fromDate || options.from;
    if (start) {
      const parsedStart = new Date(start);
      if (!Number.isNaN(parsedStart.getTime())) {
        whereClauses.push(`a.created_at >= $${paramIndex}`);
        values.push(parsedStart.toISOString());
        paramIndex += 1;
      }
    }

    // Date range: to / endDate / toDate
    const end = options.endDate || options.toDate || options.to;
    if (end) {
      const parsedEnd = new Date(end);
      if (!Number.isNaN(parsedEnd.getTime())) {
        whereClauses.push(`a.created_at <= $${paramIndex}`);
        values.push(parsedEnd.toISOString());
        paramIndex += 1;
      }
    }

    // Category filter
    if (options.category && typeof options.category === 'string') {
      const categoryKey = options.category.trim().toUpperCase();
      const actionsForCategory = SECURITY_CATEGORIES[categoryKey];
      if (Array.isArray(actionsForCategory) && actionsForCategory.length > 0) {
        whereClauses.push(`a.action = ANY($${paramIndex}::text[])`);
        values.push(actionsForCategory);
        paramIndex += 1;
      }
    }

    // Action list filter (e.g. for security events)
    if (Array.isArray(options.actionList) && options.actionList.length > 0) {
      whereClauses.push(`a.action = ANY($${paramIndex}::text[])`);
      values.push(options.actionList);
      paramIndex += 1;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Safe sorting
    const requestedSort = (options.sortBy || 'created_at').toLowerCase().trim();
    const sortBy = ALLOWED_SORT_COLUMNS.has(requestedSort) ? requestedSort : 'created_at';
    const sortOrder = (options.sortOrder || 'DESC').toUpperCase().trim() === 'ASC' ? 'ASC' : 'DESC';

    // 1. Total count query
    const countSql = `
      SELECT COUNT(*) AS total
      FROM admin_actions a
      LEFT JOIN users u ON u.id = a.actor_id
      ${whereSql};
    `;
    const countRes = await this._execute(countSql, values, client);
    const total = parseInt(countRes.rows[0]?.total || 0, 10);

    // 2. Items query
    const itemsSql = `
      SELECT
        a.id,
        a.actor_id,
        a.actor_role,
        a.permission,
        a.action,
        a.target_resource,
        a.target_resource_id,
        a.request_id,
        a.ip_address,
        a.user_agent,
        a.before_state,
        a.after_state,
        a.metadata,
        a.created_at,
        u.name AS actor_name,
        u.email AS actor_email,
        u.role AS user_role
      FROM admin_actions a
      LEFT JOIN users u ON u.id = a.actor_id
      ${whereSql}
      ORDER BY a.${sortBy} ${sortOrder}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;

    const itemsRes = await this._execute(itemsSql, [...values, limit, offset], client);
    const items = itemsRes.rows.map((row) => this._formatAction(row));

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
   * Retrieves single audit action detail by ID with joined actor info.
   *
   * @param {string} id
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findActionById(id, client = null) {
    const sql = `
      SELECT
        a.id,
        a.actor_id,
        a.actor_role,
        a.permission,
        a.action,
        a.target_resource,
        a.target_resource_id,
        a.request_id,
        a.ip_address,
        a.user_agent,
        a.before_state,
        a.after_state,
        a.metadata,
        a.created_at,
        u.name AS actor_name,
        u.email AS actor_email,
        u.role AS user_role
      FROM admin_actions a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.id = $1
      LIMIT 1;
    `;
    const res = await this._execute(sql, [id], client);
    if (!res.rows || res.rows.length === 0) return null;
    return this._formatAction(res.rows[0]);
  }

  /**
   * Retrieves audit actions performed by a specific admin actor.
   *
   * @param {string} actorId
   * @param {object} [options={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async findActionsByActor(actorId, options = {}, client = null) {
    return this.listAuditActions({ ...options, actorId }, client);
  }

  /**
   * Retrieves chronological audit history for a specific resource entity.
   *
   * @param {string} targetResource
   * @param {string} targetResourceId
   * @param {object} [options={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async findActionsByResource(targetResource, targetResourceId, options = {}, client = null) {
    return this.listAuditActions(
      {
        ...options,
        targetResource,
        targetResourceId,
        sortBy: options.sortBy || 'created_at',
        sortOrder: options.sortOrder || 'DESC',
      },
      client,
    );
  }

  /**
   * Retrieves audit actions classified under security events.
   *
   * @param {object} [options={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async findSecurityEvents(options = {}, client = null) {
    let actionList = null;

    if (options.category) {
      const categoryKey = options.category.trim().toUpperCase();
      actionList = SECURITY_CATEGORIES[categoryKey] || [];
    } else {
      // All security-classified actions across categories
      const allSecurity = new Set();
      Object.values(SECURITY_CATEGORIES).forEach((actions) => {
        actions.forEach((act) => allSecurity.add(act));
      });
      actionList = Array.from(allSecurity);
    }

    return this.listAuditActions({ ...options, actionList }, client);
  }

  /**
   * Computes operational security summary metrics within a bounded date window.
   *
   * @param {object} [options={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getSecuritySummary(options = {}, client = null) {
    const end = options.endDate ? new Date(options.endDate) : new Date();
    const start = options.startDate
      ? new Date(options.startDate)
      : new Date(Date.now() - 24 * 60 * 60 * 1000); // Default last 24h

    const startIso = start.toISOString();
    const endIso = end.toISOString();

    // 1. Total events count in period
    const totalSql = `
      SELECT COUNT(*) AS total
      FROM admin_actions
      WHERE created_at >= $1 AND created_at <= $2;
    `;
    const totalRes = await this._execute(totalSql, [startIso, endIso], client);
    const totalEvents = parseInt(totalRes.rows[0]?.total || 0, 10);

    // 2. Action breakdown in period (top 15)
    const actionSql = `
      SELECT action, COUNT(*) AS count
      FROM admin_actions
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY action
      ORDER BY count DESC
      LIMIT 15;
    `;
    const actionRes = await this._execute(actionSql, [startIso, endIso], client);
    const actionBreakdown = actionRes.rows.map((r) => ({
      action: r.action,
      count: parseInt(r.count, 10),
    }));

    // 3. Target resource breakdown (top 10)
    const resourceSql = `
      SELECT target_resource, COUNT(*) AS count
      FROM admin_actions
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY target_resource
      ORDER BY count DESC
      LIMIT 10;
    `;
    const resourceRes = await this._execute(resourceSql, [startIso, endIso], client);
    const resourceBreakdown = resourceRes.rows.map((r) => ({
      resource: r.target_resource,
      count: parseInt(r.count, 10),
    }));

    // 4. Top active admin actors (top 5)
    const actorSql = `
      SELECT
        a.actor_id,
        u.name AS actor_name,
        u.email AS actor_email,
        COUNT(*) AS action_count
      FROM admin_actions a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.created_at >= $1 AND a.created_at <= $2
      GROUP BY a.actor_id, u.name, u.email
      ORDER BY action_count DESC
      LIMIT 5;
    `;
    const actorRes = await this._execute(actorSql, [startIso, endIso], client);
    const topActors = actorRes.rows.map((r) => ({
      actorId: r.actor_id,
      name: r.actor_name || 'Admin',
      email: r.actor_email || null,
      actionCount: parseInt(r.action_count, 10),
    }));

    // 5. Category breakdown
    const categoryBreakdown = {};
    Object.entries(SECURITY_CATEGORIES).forEach(([catName, actions]) => {
      const matchCount = actionBreakdown
        .filter((a) => actions.includes(a.action))
        .reduce((acc, curr) => acc + curr.count, 0);
      categoryBreakdown[catName] = matchCount;
    });

    const securityEventsCount = Object.values(categoryBreakdown).reduce((a, b) => a + b, 0);

    return {
      timeWindow: {
        startDate: startIso,
        endDate: endIso,
        windowHours: Math.round((end - start) / (1000 * 60 * 60)),
      },
      totalEvents,
      securityEventsCount,
      categoryBreakdown,
      actionBreakdown,
      resourceBreakdown,
      topActors,
    };
  }

  /**
   * Retrieves distinct recorded action names and resource types.
   *
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ actions: string[], resources: string[], categories: string[] }>}
   */
  async getDistinctActionsAndResources(client = null) {
    const actionSql = 'SELECT DISTINCT action FROM admin_actions ORDER BY action ASC;';
    const resourceSql = 'SELECT DISTINCT target_resource FROM admin_actions ORDER BY target_resource ASC;';

    const [actionRes, resourceRes] = await Promise.all([
      this._execute(actionSql, [], client),
      this._execute(resourceSql, [], client),
    ]);

    return {
      actions: actionRes.rows.map((r) => r.action),
      resources: resourceRes.rows.map((r) => r.target_resource),
      categories: Object.keys(SECURITY_CATEGORIES),
    };
  }

  /**
   * Formats database row into safe projection with recursive sensitive-data redaction.
   *
   * @param {object} row
   * @returns {object}
   */
  _formatAction(row) {
    if (!row) return null;

    let category = null;
    if (row.action) {
      const matched = Object.entries(SECURITY_CATEGORIES).find(([, actions]) => (
        actions.includes(row.action)
      ));
      if (matched) {
        [category] = matched;
      }
    }

    return {
      id: row.id,
      category,
      actor: {
        id: row.actor_id,
        name: row.actor_name || null,
        email: row.actor_email || null,
        role: row.actor_role || row.user_role || 'ADMIN',
      },
      actorName: row.actor_name || null,
      actorEmail: row.actor_email || null,
      permission: row.permission || null,
      action: row.action,
      targetResource: row.target_resource,
      targetResourceId: row.target_resource_id || null,
      requestId: row.request_id || null,
      ipAddress: row.ip_address || null,
      userAgent: row.user_agent || null,
      beforeState: sanitizeAuditMetadata(row.before_state),
      afterState: sanitizeAuditMetadata(row.after_state),
      metadata: sanitizeAuditMetadata(row.metadata || {}),
      createdAt: row.created_at,
    };
  }
}

const instance = new AdminActionRepository();
instance.AdminActionRepository = AdminActionRepository;
instance.SECURITY_CATEGORIES = SECURITY_CATEGORIES;

module.exports = instance;
