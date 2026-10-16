'use strict';

const BaseRepository = require('../db/base.repository');

class AdminSettingRepository extends BaseRepository {
  constructor() {
    super('admin_settings', 'id');
  }

  /**
   * Retrieves a setting by key.
   *
   * @param {string} key
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByKey(key, client = null) {
    const text = `
      SELECT *
      FROM ${this.tableName}
      WHERE key = $1
      LIMIT 1;
    `;
    const res = client ? await client.query(text, [key]) : await this.query(text, [key]);
    return res.rows[0] || null;
  }

  /**
   * Retrieves all settings in a category.
   *
   * @param {string} category
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async findByCategory(category, client = null) {
    const text = `
      SELECT *
      FROM ${this.tableName}
      WHERE category = $1
      ORDER BY key ASC;
    `;
    const res = client ? await client.query(text, [category]) : await this.query(text, [category]);
    return res.rows;
  }

  /**
   * Upserts a setting value.
   *
   * @param {object} params
   * @param {string} params.category
   * @param {string} params.key
   * @param {object} params.value
   * @param {string} [params.description]
   * @param {string} [params.updatedBy]
   * @param {import('pg').PoolClient} [client]
   */
  async upsertSetting(
    { category, key, value, description = null, updatedBy = null },
    client = null,
  ) {
    const text = `
      INSERT INTO ${this.tableName} (category, key, value, description, updated_by)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (key) DO UPDATE
      SET
        value = EXCLUDED.value,
        category = EXCLUDED.category,
        description = COALESCE(EXCLUDED.description, ${this.tableName}.description),
        updated_by = EXCLUDED.updated_by,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const values = [category, key, JSON.stringify(value), description, updatedBy];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows[0];
  }
}

module.exports = new AdminSettingRepository();
