'use strict';

const BaseRepository = require('./base.repository');
const { NotFoundError } = require('../errors');

/**
 * Strict allowlist of columns a caller may supply when creating or updating an address.
 */
const ALLOWED_ADDRESS_COLUMNS = new Set([
  'label',
  'address_label',
  'full_address',
  'address_line1',
  'address_line2',
  'landmark',
  'city',
  'state',
  'postal_code',
  'country_code',
  'latitude',
  'longitude',
]);

/**
 * AddressRepository encapsulates all SQL for customer addresses.
 * Primary authoritative Supabase table: `customer_saved_addresses`.
 * Fallback table for test environments: `customer_addresses`.
 *
 * Security invariant: every query is ownership-scoped to userId / customerId.
 */
class AddressRepository extends BaseRepository {
  /**
   * Creates a new address for the given user.
   *
   * @param {string} userId - Authenticated user's UUID
   * @param {object} fields - Validated address fields
   * @returns {Promise<object>} Created address row
   */
  async create(userId, fields) {
    const label = fields.addressLabel || fields.label || 'home';
    const line1 = fields.addressLine1 || fields.fullAddress || fields.address_line1 || '';
    const line2 = fields.addressLine2 || fields.address_line2 || null;
    const postalCode = fields.postalCode || fields.postal_code || null;
    const lat = fields.latitude !== undefined && fields.latitude !== null ? parseFloat(fields.latitude) : null;
    const lng = fields.longitude !== undefined && fields.longitude !== null ? parseFloat(fields.longitude) : null;

    try {
      // 1. Authoritative Supabase table
      const sql = `
        INSERT INTO customer_saved_addresses (
          customer_id, address_label, address_line1, address_line2,
          postal_code, latitude, longitude, is_default, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, true)
        RETURNING *
      `;
      const result = await this.query(sql, [userId, label, line1, line2, postalCode, lat, lng]);
      return this._toDto(result.rows[0]);
    } catch (err) {
      if (err.message && (err.message.includes('customer_saved_addresses') || err.message.includes('relation'))) {
        // 2. Fallback to legacy test table
        const safeFields = this._pickAllowed(fields);
        const columns = ['user_id', ...Object.keys(safeFields)];
        const values = [userId, ...Object.values(safeFields)];
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        const legacySql = `
          INSERT INTO customer_addresses (${columns.join(', ')})
          VALUES (${placeholders})
          RETURNING *
        `;
        const result = await this.query(legacySql, values);
        return this._toDto(result.rows[0]);
      }
      throw err;
    }
  }

  /**
   * Retrieves all addresses belonging to the given user, newest first.
   *
   * @param {string} userId
   * @returns {Promise<object[]>}
   */
  async findByUserId(userId) {
    try {
      const sql = `
        SELECT * FROM customer_saved_addresses
        WHERE customer_id = $1 AND is_active = true
        ORDER BY is_default DESC, created_at DESC
      `;
      const result = await this.query(sql, [userId]);
      return result.rows.map((r) => this._toDto(r));
    } catch {
      const sql = `
        SELECT * FROM customer_addresses
        WHERE user_id = $1
        ORDER BY is_default DESC, created_at DESC
      `;
      const result = await this.query(sql, [userId]);
      return result.rows.map((r) => this._toDto(r));
    }
  }

  /**
   * Finds a single address by id, scoped to the given user.
   *
   * @param {string} id - Address UUID
   * @param {string} userId - Authenticated user's UUID
   * @returns {Promise<object|null>}
   */
  async findByIdAndUserId(id, userId) {
    try {
      const sql = `
        SELECT * FROM customer_saved_addresses
        WHERE id = $1 AND customer_id = $2
      `;
      const result = await this.query(sql, [id, userId]);
      return result.rows[0] ? this._toDto(result.rows[0]) : null;
    } catch {
      const sql = `
        SELECT * FROM customer_addresses
        WHERE id = $1 AND user_id = $2
      `;
      const result = await this.query(sql, [id, userId]);
      return result.rows[0] ? this._toDto(result.rows[0]) : null;
    }
  }

  /**
   * Updates allowlisted fields of an address, scoped to the given user.
   *
   * @param {string} id - Address UUID
   * @param {string} userId - Authenticated user's UUID
   * @param {object} fields - Fields to update
   * @returns {Promise<object>} Updated address row
   */
  async update(id, userId, fields) {
    const existing = await this.findByIdAndUserId(id, userId);
    if (!existing) {
      throw new NotFoundError('Address not found', 'ADDRESS_NOT_FOUND');
    }

    const safeFields = this._pickAllowed(fields);
    if (Object.keys(safeFields).length === 0) {
      return existing;
    }

    try {
      const setClauses = [];
      const values = [];
      let idx = 1;

      if (fields.label !== undefined || fields.addressLabel !== undefined) {
        setClauses.push(`address_label = $${idx}`);
        values.push(fields.addressLabel || fields.label);
        idx += 1;
      }
      if (fields.addressLine1 !== undefined || fields.fullAddress !== undefined) {
        setClauses.push(`address_line1 = $${idx}`);
        values.push(fields.addressLine1 || fields.fullAddress);
        idx += 1;
      }
      if (fields.addressLine2 !== undefined) {
        setClauses.push(`address_line2 = $${idx}`);
        values.push(fields.addressLine2);
        idx += 1;
      }
      if (fields.postalCode !== undefined) {
        setClauses.push(`postal_code = $${idx}`);
        values.push(fields.postalCode);
        idx += 1;
      }
      if (fields.latitude !== undefined) {
        setClauses.push(`latitude = $${idx}`);
        values.push(fields.latitude ? parseFloat(fields.latitude) : null);
        idx += 1;
      }
      if (fields.longitude !== undefined) {
        setClauses.push(`longitude = $${idx}`);
        values.push(fields.longitude ? parseFloat(fields.longitude) : null);
        idx += 1;
      }

      setClauses.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id, userId);

      const sql = `
        UPDATE customer_saved_addresses
        SET ${setClauses.join(', ')}
        WHERE id = $${idx} AND customer_id = $${idx + 1}
        RETURNING *
      `;

      const result = await this.query(sql, values);
      return this._toDto(result.rows[0]);
    } catch (err) {
      if (err.message && (err.message.includes('customer_saved_addresses') || err.message.includes('relation'))) {
        const setClauses = Object.keys(safeFields).map((col, i) => `${col} = $${i + 3}`);
        const values = [id, userId, ...Object.values(safeFields)];

        const legacySql = `
          UPDATE customer_addresses
          SET ${setClauses.join(', ')}
          WHERE id = $1 AND user_id = $2
          RETURNING *
        `;

        const result = await this.query(legacySql, values);
        return this._toDto(result.rows[0]);
      }
      throw err;
    }
  }

  /**
   * Deletes an address by id, scoped to the given user.
   *
   * @param {string} id - Address UUID
   * @param {string} userId - Authenticated user's UUID
   * @returns {Promise<void>}
   */
  async deleteByIdAndUserId(id, userId) {
    try {
      const sql = `
        DELETE FROM customer_saved_addresses
        WHERE id = $1 AND customer_id = $2
        RETURNING id
      `;
      const result = await this.query(sql, [id, userId]);
      if (result.rows.length === 0) {
        throw new NotFoundError('Address not found', 'ADDRESS_NOT_FOUND');
      }
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      const legacySql = `
        DELETE FROM customer_addresses
        WHERE id = $1 AND user_id = $2
        RETURNING id
      `;
      const result = await this.query(legacySql, [id, userId]);
      if (result.rows.length === 0) {
        throw new NotFoundError('Address not found', 'ADDRESS_NOT_FOUND');
      }
    }
  }

  /**
   * Sets the specified address as the default for the user.
   *
   * @param {string} id - Address UUID to set as default
   * @param {string} userId - Authenticated user's UUID
   * @returns {Promise<object>} Updated address row
   */
  async setDefault(id, userId) {
    return this.transaction(async (client) => {
      try {
        // Try Supabase table first
        const check = await client.query(
          'SELECT id FROM customer_saved_addresses WHERE id = $1 AND customer_id = $2',
          [id, userId],
        );
        if (check.rows.length === 0) {
          throw new NotFoundError('Address not found', 'ADDRESS_NOT_FOUND');
        }

        await client.query(
          'UPDATE customer_saved_addresses SET is_default = false WHERE customer_id = $1 AND is_default = true',
          [userId],
        );

        const updateResult = await client.query(
          'UPDATE customer_saved_addresses SET is_default = true WHERE id = $1 AND customer_id = $2 RETURNING *',
          [id, userId],
        );

        return this._toDto(updateResult.rows[0]);
      } catch (err) {
        if (err instanceof NotFoundError) throw err;
        // Fallback to legacy test table
        const check = await client.query(
          'SELECT id FROM customer_addresses WHERE id = $1 AND user_id = $2',
          [id, userId],
        );
        if (check.rows.length === 0) {
          throw new NotFoundError('Address not found', 'ADDRESS_NOT_FOUND');
        }

        await client.query(
          'UPDATE customer_addresses SET is_default = false WHERE user_id = $1 AND is_default = true',
          [userId],
        );

        const updateResult = await client.query(
          'UPDATE customer_addresses SET is_default = true WHERE id = $1 AND user_id = $2 RETURNING *',
          [id, userId],
        );

        return this._toDto(updateResult.rows[0]);
      }
    });
  }

  /**
   * Filters input fields.
   */
  _pickAllowed(fields) {
    const result = {};
    const camelToSnake = (str) => str.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);

    Object.entries(fields || {}).forEach(([key, value]) => {
      const snakeKey = camelToSnake(key);
      if (ALLOWED_ADDRESS_COLUMNS.has(snakeKey) && value !== undefined) {
        result[snakeKey] = value;
      }
    });

    return result;
  }

  /**
   * Maps a raw database row to a safe camelCase DTO.
   */
  _toDto(row) {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.customer_id || row.user_id,
      label: row.address_label || row.label,
      fullAddress: row.full_address || row.address_line1,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2 || null,
      landmark: row.landmark || null,
      city: row.city || null,
      state: row.state || null,
      postalCode: row.postal_code,
      countryCode: row.country_code || '+91',
      latitude: row.latitude !== null && row.latitude !== undefined
        ? parseFloat(row.latitude) : null,
      longitude: row.longitude !== null && row.longitude !== undefined
        ? parseFloat(row.longitude) : null,
      isDefault: Boolean(row.is_default),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = AddressRepository;
