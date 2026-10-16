'use strict';

const BaseRepository = require('../db/base.repository');

class AdminPermissionRepository extends BaseRepository {
  constructor() {
    super('admin_permissions', 'id');
  }

  /**
   * Retrieves all permissions assigned to an admin user.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<string[]>}
   */
  async findPermissionsByUserId(userId, client = null) {
    const text = `
      SELECT permission
      FROM ${this.tableName}
      WHERE user_id = $1
      ORDER BY permission ASC;
    `;
    const res = client ? await client.query(text, [userId]) : await this.query(text, [userId]);
    return res.rows.map((row) => row.permission);
  }

  /**
   * Assigns a permission group to an admin user.
   *
   * @param {string} userId
   * @param {string} permission
   * @param {string} [assignedBy=null]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async assignPermission(userId, permission, assignedBy = null, client = null) {
    const text = `
      INSERT INTO ${this.tableName} (user_id, permission, assigned_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, permission) DO NOTHING
      RETURNING *;
    `;
    const res = client
      ? await client.query(text, [userId, permission, assignedBy])
      : await this.query(text, [userId, permission, assignedBy]);
    return res.rows[0] || null;
  }

  /**
   * Revokes a specific permission from an admin user.
   *
   * @param {string} userId
   * @param {string} permission
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>}
   */
  async revokePermission(userId, permission, client = null) {
    const text = `
      DELETE FROM ${this.tableName}
      WHERE user_id = $1 AND permission = $2;
    `;
    const res = client
      ? await client.query(text, [userId, permission])
      : await this.query(text, [userId, permission]);
    return (res.rowCount || 0) > 0;
  }

  /**
   * Retrieves all permission records (full rows) assigned to an admin user.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async findAllByUserId(userId, client = null) {
    const text = `
      SELECT id, user_id, permission, assigned_by, created_at
      FROM ${this.tableName}
      WHERE user_id = $1
      ORDER BY permission ASC;
    `;
    const res = client ? await client.query(text, [userId]) : await this.query(text, [userId]);
    return res.rows;
  }

  /**
   * Revokes all permissions for a user. Used during admin deactivation.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>} Count of revoked permissions
   */
  async revokeAllPermissions(userId, client = null) {
    const text = `
      DELETE FROM ${this.tableName}
      WHERE user_id = $1;
    `;
    const res = client
      ? await client.query(text, [userId])
      : await this.query(text, [userId]);
    return res.rowCount || 0;
  }
}

module.exports = new AdminPermissionRepository();
