'use strict';

const BaseRepository = require('../db/base.repository');

class UserRepository extends BaseRepository {
  constructor() {
    super('users', 'id');
  }

  /**
   * Find user by Supabase auth ID and provider.
   *
   * @param {string} authId Supabase UUID
   * @param {string} [authProvider='supabase']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByAuthId(authId, authProvider = 'supabase', client = null) {
    const text = `
      SELECT id, auth_id, auth_provider, role, name, country_code, phone, email, is_active, created_at, updated_at
      FROM ${this.tableName}
      WHERE auth_id = $1 AND auth_provider = $2
      LIMIT 1
    `;
    const res = client
      ? await client.query(text, [authId, authProvider])
      : await this.query(text, [authId, authProvider]);
    return res.rows[0] || null;
  }

  /**
   * Find user by phone number.
   *
   * @param {string} phone 10-digit mobile number or full phone
   * @param {string} [countryCode='+91']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByPhone(phone, countryCode = '+91', client = null) {
    const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);
    const fullPhone = `${countryCode}${cleanPhone}`;
    const text = `
      SELECT id, auth_id, auth_provider, role, name, country_code, phone, email, is_active, created_at, updated_at
      FROM ${this.tableName}
      WHERE (phone = $1 OR phone = $2 OR RIGHT(phone, 10) = $1)
      ORDER BY CASE WHEN LOWER(role) = 'partner' THEN 0 ELSE 1 END
      LIMIT 1
    `;
    const res = client
      ? await client.query(text, [cleanPhone, fullPhone])
      : await this.query(text, [cleanPhone, fullPhone]);
    return res.rows[0] || null;
  }

  /**
   * Create a new user record within an existing client/transaction.
   *
   * @param {object} userData
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async createUser(userData, client) {
    const text = `
      INSERT INTO ${this.tableName} (
        auth_id, auth_provider, role, name, country_code, phone, email, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, auth_id, auth_provider, role, name, country_code, phone, email, is_active, created_at, updated_at
    `;
    const cleanPhone = userData.phone ? String(userData.phone).replace(/[^0-9]/g, '').slice(-10) : null;
    const values = [
      userData.authId,
      userData.authProvider || 'supabase',
      userData.role || 'PARTNER',
      userData.name ? userData.name.trim() : null,
      userData.countryCode || '+91',
      cleanPhone,
      userData.email ? userData.email.trim().toLowerCase() : null,
      userData.isActive !== undefined ? userData.isActive : true,
    ];

    const res = await client.query(text, values);
    return res.rows[0];
  }

  /**
   * Find user by primary ID.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findById(userId, client = null) {
    const text = `
      SELECT id, auth_id, auth_provider, role, name, country_code, phone, email, is_active, created_at, updated_at
      FROM ${this.tableName}
      WHERE id = $1
      LIMIT 1
    `;
    const res = client ? await client.query(text, [userId]) : await this.query(text, [userId]);
    return res.rows[0] || null;
  }

  /**
   * Update user details (name, email) by primary ID.
   * Phone number is immutable via normal update.
   *
   * @param {string} userId
   * @param {object} updates
   * @param {string} [updates.name]
   * @param {string} [updates.email]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateUser(userId, updates, client = null) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (updates.name !== undefined) {
      fields.push(`name = $${idx}`);
      idx += 1;
      values.push(updates.name ? updates.name.trim() : null);
    }

    if (updates.email !== undefined) {
      fields.push(`email = $${idx}`);
      idx += 1;
      values.push(updates.email ? updates.email.trim().toLowerCase() : null);
    }

    if (fields.length === 0) {
      return this.findById(userId, client);
    }

    values.push(userId);
    const text = `
      UPDATE ${this.tableName}
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING id, auth_id, auth_provider, role, name, country_code, phone, email, is_active, created_at, updated_at
    `;

    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows[0] || null;
  }
}

module.exports = UserRepository;
