'use strict';

const BaseRepository = require('../db/base.repository');

/** Roles allowed to sign in to the Admin Portal (users.role is stored lowercase). */
const ADMIN_PORTAL_ROLES = ['admin', 'super_admin', 'support_executive'];

const ADMIN_LOGIN_COLUMNS = `
  u.id, u.email, u.phone, u.role, u.status, u.is_active, u.deleted_at, u.auth_id,
  u.name,
  c.password_hash, c.must_change_password, c.failed_login_count, c.locked_until
`;

class AdminCredentialRepository extends BaseRepository {
  constructor() {
    super('admin_credentials', 'user_id');
  }

  /**
   * Finds Admin Portal accounts (admin roles only) by normalized email, joined with their
   * credential row. Customer/partner accounts sharing the contact are never returned.
   * Returns up to two rows so callers can fail closed on ambiguous matches.
   *
   * @param {string} email Lowercased, trimmed email
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async findAdminsByEmail(email, client = null) {
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const text = `
      SELECT ${ADMIN_LOGIN_COLUMNS}
      FROM users u
      LEFT JOIN admin_credentials c ON c.user_id = u.id
      WHERE LOWER(TRIM(u.email)) = $1
        AND LOWER(u.role) = ANY($2::text[])
        AND u.deleted_at IS NULL
      LIMIT 2;
    `;
    const values = [cleanEmail, ADMIN_PORTAL_ROLES];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows;
  }

  /**
   * Finds Admin Portal accounts by 10-digit national mobile number, tolerating the stored
   * formats in use ("9876543210", "+919876543210", "09876543210").
   *
   * @param {string} mobile 10-digit national number
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async findAdminsByMobile(mobile, client = null) {
    const text = `
      SELECT ${ADMIN_LOGIN_COLUMNS}
      FROM users u
      LEFT JOIN admin_credentials c ON c.user_id = u.id
      WHERE regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') IN ($1, '91' || $1, '0' || $1)
        AND LOWER(u.role) = ANY($2::text[])
        AND u.deleted_at IS NULL
      LIMIT 2;
    `;
    const values = [mobile, ADMIN_PORTAL_ROLES];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows;
  }

  /**
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByUserId(userId, client = null) {
    const text = `
      SELECT user_id, password_hash, must_change_password, failed_login_count,
             locked_until, password_updated_at, last_login_at
      FROM admin_credentials
      WHERE user_id = $1
      LIMIT 1;
    `;
    const res = client ? await client.query(text, [userId]) : await this.query(text, [userId]);
    return res.rows[0] || null;
  }

  /**
   * Creates the credential row only if none exists. Never overwrites an existing password.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.passwordHash
   * @param {boolean} [params.mustChangePassword=false]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>} true when a row was inserted
   */
  async createIfAbsent({ userId, passwordHash, mustChangePassword = false }, client = null) {
    const text = `
      INSERT INTO admin_credentials (user_id, password_hash, must_change_password)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
      RETURNING user_id;
    `;
    const values = [userId, passwordHash, mustChangePassword];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows.length > 0;
  }

  /**
   * Replaces the password hash for an existing credential row and clears lockout state.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.passwordHash
   * @param {boolean} [params.mustChangePassword=false]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>}
   */
  async updatePassword({ userId, passwordHash, mustChangePassword = false }, client = null) {
    const text = `
      UPDATE admin_credentials
      SET password_hash = $2,
          must_change_password = $3,
          password_updated_at = CURRENT_TIMESTAMP,
          failed_login_count = 0,
          locked_until = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1;
    `;
    const values = [userId, passwordHash, mustChangePassword];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    return (res.rowCount || 0) > 0;
  }

  /**
   * Atomically records a failed password attempt; locks the account once maxAttempts is
   * reached (and resets the counter so the next window starts fresh after the lock).
   *
   * @param {string} userId
   * @param {number} maxAttempts
   * @param {number} lockSeconds
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ locked: boolean }>}
   */
  async recordFailedAttempt(userId, maxAttempts, lockSeconds, client = null) {
    const text = `
      UPDATE admin_credentials
      SET failed_login_count = CASE
            WHEN failed_login_count + 1 >= $2 THEN 0
            ELSE failed_login_count + 1
          END,
          locked_until = CASE
            WHEN failed_login_count + 1 >= $2 THEN $3::timestamptz
            ELSE locked_until
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
      RETURNING locked_until;
    `;
    const lockUntil = new Date(Date.now() + lockSeconds * 1000);
    const values = [userId, maxAttempts, lockUntil];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    const lockedUntil = res.rows[0] && res.rows[0].locked_until;
    return { locked: Boolean(lockedUntil && new Date(lockedUntil).getTime() > Date.now()) };
  }

  /**
   * Clears failed-attempt state and stamps last_login_at after a successful login.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<void>}
   */
  async recordSuccessfulLogin(userId, client = null) {
    const text = `
      UPDATE admin_credentials
      SET failed_login_count = 0, locked_until = NULL,
          last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1;
    `;
    if (client) await client.query(text, [userId]);
    else await this.query(text, [userId]);
  }
}

module.exports = new AdminCredentialRepository();
module.exports.ADMIN_PORTAL_ROLES = ADMIN_PORTAL_ROLES;
