'use strict';

const BaseRepository = require('../db/base.repository');

class AdminOAuthIdentityRepository extends BaseRepository {
  constructor() {
    super('admin_oauth_identities', 'id');
  }

  /**
   * Finds the administrator explicitly linked to a provider subject.
   *
   * @param {string} provider e.g. 'google'
   * @param {string} subject Provider's stable user id (Google "sub")
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByProviderSubject(provider, subject, client = null) {
    const text = `
      SELECT id, user_id, provider, provider_subject, provider_email, last_login_at, created_at
      FROM admin_oauth_identities
      WHERE provider = $1 AND provider_subject = $2
      LIMIT 1;
    `;
    const values = [provider, subject];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows[0] || null;
  }

  /**
   * @param {string} userId
   * @param {string} provider
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByUserAndProvider(userId, provider, client = null) {
    const text = `
      SELECT id, user_id, provider, provider_subject, provider_email, last_login_at, created_at
      FROM admin_oauth_identities
      WHERE user_id = $1 AND provider = $2
      LIMIT 1;
    `;
    const values = [userId, provider];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows[0] || null;
  }

  /**
   * Links an identity to an administrator. Fails (returns null) instead of re-pointing an
   * identity already linked elsewhere, or replacing the user's existing link.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.provider
   * @param {string} params.subject
   * @param {string|null} [params.email]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async link({ userId, provider, subject, email = null }, client = null) {
    const text = `
      INSERT INTO admin_oauth_identities (user_id, provider, provider_subject, provider_email)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
      RETURNING id, user_id, provider, provider_subject, provider_email, created_at;
    `;
    const values = [userId, provider, subject, email];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows[0] || null;
  }

  /**
   * @param {string} id
   * @param {string|null} email Latest verified provider email (informational only)
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<void>}
   */
  async touchLogin(id, email = null, client = null) {
    const text = `
      UPDATE admin_oauth_identities
      SET last_login_at = CURRENT_TIMESTAMP,
          provider_email = COALESCE($2, provider_email),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1;
    `;
    if (client) await client.query(text, [id, email]);
    else await this.query(text, [id, email]);
  }
}

module.exports = new AdminOAuthIdentityRepository();
