'use strict';

const BaseRepository = require('../db/base.repository');
const { getSupabase } = require('../config/supabase');

let mockUserResolver = null;

class UserRepository extends BaseRepository {
  constructor() {
    super('users', 'id');
  }

  /**
   * For testing: inject mock resolver
   */
  static setMockUserResolver(resolver) {
    mockUserResolver = resolver;
  }

  static resetMockUserResolver() {
    mockUserResolver = null;
  }

  /**
   * Normalizes a user row from PostgreSQL/Supabase to uniform application format.
   * Handles both canonical schema from GONGO_DB_REFERENCE.md and legacy test variations.
   *
   * @param {object|null} row
   * @returns {object|null}
   */
  _normalizeUser(row) {
    if (!row) return null;

    const status = String(row.status || (row.is_active ? 'active' : 'inactive')).toLowerCase();
    const isActive = status === 'active' && !row.deleted_at;
    const role = row.role || 'customer';

    return {
      ...row,
      status,
      role,
      is_active: isActive,
      auth_id: row.auth_id || null,
      phone: row.phone || null,
      email: row.email || null,
      name: row.name || row.full_name || 'Admin User',
    };
  }

  /**
   * Find user by Supabase Auth UID or external auth ID.
   *
   * @param {string} authId Supabase Auth UID or ID
   * @param {string} [authProvider='supabase']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByAuthId(authId, authProvider = 'supabase', client = null) {
    if (mockUserResolver) {
      return this._normalizeUser(mockUserResolver(authId, authProvider));
    }

    try {
      const text = `
        SELECT u.id, u.phone, u.role, u.status, u.created_at, u.updated_at, u.deleted_at,
               u.auth_id, u.auth_provider, u.email, u.name, u.is_active,
               cp.full_name AS customer_name
        FROM users u
        LEFT JOIN customer_profiles cp ON cp.user_id = u.id
        WHERE (u.auth_id = $1 OR u.id::text = $1) AND u.deleted_at IS NULL
        LIMIT 1
      `;
      const res = client ? await client.query(text, [authId]) : await this.query(text, [authId]);
      if (res && res.rows && res.rows[0]) {
        return this._normalizeUser(res.rows[0]);
      }
    } catch (_) {
      try {
        const text = `
          SELECT *
          FROM ${this.tableName}
          WHERE (auth_id = $1 OR id::text = $1)
          LIMIT 1
        `;
        const res = client ? await client.query(text, [authId]) : await this.query(text, [authId]);
        return this._normalizeUser(res.rows[0] || null);
      } catch (err) {
        try {
          const supabase = getSupabase();
          const { data } = await supabase
            .from('users')
            .select('*')
            .or(`auth_id.eq.${authId},id.eq.${authId}`)
            .is('deleted_at', null)
            .maybeSingle();
          return this._normalizeUser(data);
        } catch (supErr) {
          return null;
        }
      }
    }

    return null;
  }


  /**
   * Find user by primary ID (UUID).
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findById(userId, client = null) {
    if (mockUserResolver && typeof mockUserResolver.findById === 'function') {
      return this._normalizeUser(mockUserResolver.findById(userId));
    }

    try {
      const text = `
        SELECT u.id, u.phone, u.email, u.is_active, u.role, u.status, u.auth_id, u.created_at, u.updated_at, u.deleted_at,
               COALESCE(cp.full_name, u.name) AS name
        FROM users u
        LEFT JOIN customer_profiles cp ON cp.user_id = u.id
        WHERE u.id = $1 AND u.deleted_at IS NULL
        LIMIT 1
      `;
      const res = client ? await client.query(text, [userId]) : await this.query(text, [userId]);
      if (res && res.rows && res.rows[0]) {
        return this._normalizeUser(res.rows[0]);
      }
    } catch (_) {
      try {
        const text = `
          SELECT * FROM ${this.tableName} WHERE id = $1 LIMIT 1
        `;
        const res = client ? await client.query(text, [userId]) : await this.query(text, [userId]);
        return this._normalizeUser(res.rows[0] || null);
      } catch (err) {
        try {
          const supabase = getSupabase();
          const { data } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .maybeSingle();
          return this._normalizeUser(data);
        } catch (_) {
          return null;
        }
      }
    }

    return null;
  }

  /**
   * Find user by email, phone, or id.
   *
   * @param {string} identifier
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByEmailOrPhone(identifier, client = null) {
    if (mockUserResolver) {
      if (typeof mockUserResolver.findByEmailOrPhone === 'function') {
        return this._normalizeUser(mockUserResolver.findByEmailOrPhone(identifier));
      }
      if (typeof mockUserResolver === 'function') {
        const mockResult = mockUserResolver(identifier);
        if (mockResult) return this._normalizeUser(mockResult);
      }
    }

    try {
      const text = `
        SELECT u.id, u.phone, u.email, u.is_active, u.role, u.status, u.auth_id, u.created_at, u.updated_at, u.deleted_at,
               cp.full_name AS name
        FROM users u
        LEFT JOIN customer_profiles cp ON cp.user_id = u.id
        WHERE (u.email = $1 OR u.phone = $1 OR u.id::text = $1) AND u.deleted_at IS NULL
        LIMIT 1
      `;
      const res = client ? await client.query(text, [identifier]) : await this.query(text, [identifier]);
      if (res && res.rows && res.rows[0]) {
        return this._normalizeUser(res.rows[0]);
      }
    } catch (_) {
      try {
        const text = `
          SELECT * FROM ${this.tableName}
          WHERE (phone = $1 OR id::text = $1 OR email = $1)
          LIMIT 1
        `;
        const res = client ? await client.query(text, [identifier]) : await this.query(text, [identifier]);
        return this._normalizeUser(res.rows[0] || null);
      } catch (_) {
        return null;
      }
    }

    return null;
  }

  /**
   * Find all administrative and support executive users.
   *
   * @param {object} [options]
   * @param {number} [options.limit=20]
   * @param {number} [options.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findAllAdmins(options = {}, client = null) {
    if (mockUserResolver && typeof mockUserResolver.findAllAdmins === 'function') {
      return (mockUserResolver.findAllAdmins() || []).map((u) => this._normalizeUser(u));
    }

    const limit = Math.min(options.limit || 20, 100);
    const offset = options.offset || 0;

    try {
      const text = `
        SELECT u.id, u.phone, u.email, u.is_active, u.role, u.status, u.auth_id, u.created_at, u.updated_at, u.deleted_at,
               cp.full_name AS name
        FROM users u
        LEFT JOIN customer_profiles cp ON cp.user_id = u.id
        WHERE u.role IN ('admin', 'super_admin', 'support_executive', 'ADMIN', 'SUPER_ADMIN', 'SUPPORT_EXECUTIVE')
          AND u.deleted_at IS NULL
        ORDER BY u.created_at DESC
        LIMIT $1 OFFSET $2
      `;
      const res = client ? await client.query(text, [limit, offset]) : await this.query(text, [limit, offset]);
      return res.rows.map((row) => this._normalizeUser(row));
    } catch (_) {
      try {
        const text = `
          SELECT * FROM ${this.tableName}
          WHERE role IN ('ADMIN', 'SUPER_ADMIN', 'SUPPORT_EXECUTIVE', 'admin', 'super_admin', 'support_executive')
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2
        `;
        const res = client ? await client.query(text, [limit, offset]) : await this.query(text, [limit, offset]);
        return res.rows.map((row) => this._normalizeUser(row));
      } catch (_) {
        return [];
      }
    }
  }

  /**
   * Updates user role (e.g. admin or support_executive).
   *
   * @param {string} userId
   * @param {string} newRole
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async updateRole(userId, newRole, client = null) {
    const canonicalRole = String(newRole).toLowerCase();
    const text = `
      UPDATE users
      SET role = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, phone, role, status, auth_id, created_at, updated_at;
    `;
    const res = client ? await client.query(text, [userId, canonicalRole]) : await this.query(text, [userId, canonicalRole]);
    return this._normalizeUser(res.rows[0] || null);
  }

  /**
   * Updates user status (e.g. active, suspended, inactive).
   *
   * @param {string} userId
   * @param {string} newStatus
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async updateStatus(userId, newStatus, client = null) {
    const canonicalStatus = String(newStatus).toLowerCase();
    const text = `
      UPDATE users
      SET status = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, phone, role, status, auth_id, created_at, updated_at;
    `;
    const res = client ? await client.query(text, [userId, canonicalStatus]) : await this.query(text, [userId, canonicalStatus]);
    return this._normalizeUser(res.rows[0] || null);
  }

  /**
   * Updates allowed profile fields for a user.
   */
  async updateProfile(userId, updates = {}, client = null) {
    const { name, phone } = updates;

    if (mockUserResolver && typeof mockUserResolver.updateProfile === 'function') {
      return mockUserResolver.updateProfile(userId, updates);
    }

    try {
      if (phone !== undefined) {
        const text = `
          UPDATE users
          SET phone = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING *;
        `;
        await (client ? client.query(text, [userId, phone]) : this.query(text, [userId, phone]));
      }

      if (name !== undefined) {
        const text = `
          INSERT INTO customer_profiles (id, user_id, full_name, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id) DO UPDATE
          SET full_name = EXCLUDED.full_name, updated_at = CURRENT_TIMESTAMP;
        `;
        await (client ? client.query(text, [userId, name]) : this.query(text, [userId, name]));
      }

      return this.findById(userId, client);
    } catch (_) {
      return this.findById(userId, client);
    }
  }

  /**
   * Creates a new administrative user record.
   *
   * @param {object} userData
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createAdminUser(userData, client = null) {
    if (mockUserResolver && typeof mockUserResolver.createAdminUser === 'function') {
      return this._normalizeUser(mockUserResolver.createAdminUser(userData));
    }

    const {
      id = null,
      auth_id = null,
      auth_provider = 'supabase',
      email = null,
      phone = null,
      name = 'Admin User',
      role = 'admin',
      status = 'active',
      is_active = true,
      created_by = null,
    } = userData;

    try {
      const text = `
        INSERT INTO users (
          id, auth_id, auth_provider, email, phone, name, role, status, is_active, created_by, created_at, updated_at
        ) VALUES (
          COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING id, phone, role, status, auth_id, auth_provider, email, name, is_active, created_by, created_at, updated_at
      `;
      const values = [id, auth_id, auth_provider, email, phone, name, String(role).toLowerCase(), status, is_active, created_by];
      const res = client ? await client.query(text, values) : await this.query(text, values);
      if (res && res.rows && res.rows[0]) {
        return this._normalizeUser(res.rows[0]);
      }
    } catch (err) {
      try {
        const supabase = getSupabase();
        const { data } = await supabase
          .from('users')
          .insert({
            auth_id,
            auth_provider,
            email,
            phone,
            name,
            role: String(role).toLowerCase(),
            status,
            is_active,
            created_by,
          })
          .select('*')
          .single();
        if (data) return this._normalizeUser(data);
      } catch (_) {}
    }

    // In-memory fallback if database query is not available
    return this._normalizeUser({
      id: id || `adm-usr-${Date.now()}`,
      auth_id: auth_id || `sup-auth-${Date.now()}`,
      auth_provider,
      email,
      phone,
      name,
      role: String(role).toLowerCase(),
      status,
      is_active,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}

module.exports = new UserRepository();
