'use strict';

const BaseRepository = require('../db/base.repository');
const { hashSessionToken, generateSecureToken } = require('../utils/crypto');

let mockSessionResolver = null;

class AdminSessionRepository extends BaseRepository {
  constructor() {
    super('admin_sessions', 'id');
  }

  /**
   * For unit testing: inject mock resolver
   * @param {Function|null} resolver
   */
  static setMockSessionResolver(resolver) {
    mockSessionResolver = resolver;
  }

  static resetMockSessionResolver() {
    mockSessionResolver = null;
  }

  /**
   * Retrieves any session record by token hash regardless of active or expired state.
   * Enables precise distinction between non-existent, expired, and revoked sessions.
   *
   * @param {string} tokenHash SHA-256 hash of raw session token
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByToken(tokenHash, client = null) {
    if (mockSessionResolver && mockSessionResolver.findByToken) {
      return mockSessionResolver.findByToken(tokenHash);
    }

    const text = `
      SELECT id, user_id, session_token, ip_address, user_agent,
             is_active, expires_at, last_active_at, created_at, updated_at
      FROM ${this.tableName}
      WHERE session_token = $1
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [tokenHash])
      : await this.query(text, [tokenHash]);
    return res.rows[0] || null;
  }

  /**
   * Retrieves an administrative session joined with user account and permissions in a single round trip.
   * Eliminates 2-3 sequential round trips and pool checkouts during authentication middleware execution.
   *
   * @param {string} tokenHash SHA-256 hash of raw session token
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ session: object, user: object, permissions: string[] }|null>}
   */
  async findSessionWithUser(tokenHash, client = null) {
    if (mockSessionResolver && mockSessionResolver.findSessionWithUser) {
      return mockSessionResolver.findSessionWithUser(tokenHash);
    }

    const text = `
      SELECT
        s.id AS session_id,
        s.user_id,
        s.session_token,
        s.ip_address,
        s.user_agent,
        s.is_active AS session_is_active,
        s.expires_at,
        s.last_active_at,
        s.created_at AS session_created_at,
        s.updated_at AS session_updated_at,
        u.id AS u_id,
        u.phone AS u_phone,
        u.email AS u_email,
        u.role AS u_role,
        u.status AS u_status,
        u.is_active AS u_is_active,
        u.auth_id AS u_auth_id,
        u.auth_provider AS u_auth_provider,
        u.created_at AS u_created_at,
        u.updated_at AS u_updated_at,
        u.deleted_at AS u_deleted_at,
        COALESCE(cp.full_name, u.name, 'Admin User') AS u_name,
        COALESCE(
          (
            SELECT array_agg(ap.permission ORDER BY ap.permission ASC)
            FROM admin_permissions ap
            WHERE ap.user_id = u.id
          ),
          ARRAY[]::varchar[]
        ) AS permissions
      FROM admin_sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN customer_profiles cp ON cp.user_id = u.id
      WHERE s.session_token = $1
      LIMIT 1;
    `;

    try {
      const res = client
        ? await client.query(text, [tokenHash])
        : await this.query(text, [tokenHash]);

      if (!res || !res.rows || res.rows.length === 0) {
        return null;
      }

      const row = res.rows[0];
      const session = {
        id: row.session_id,
        user_id: row.user_id,
        session_token: row.session_token,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        is_active: row.session_is_active,
        expires_at: row.expires_at,
        last_active_at: row.last_active_at,
        created_at: row.session_created_at,
        updated_at: row.session_updated_at,
      };

      const userStatus = String(row.u_status || (row.u_is_active ? 'active' : 'inactive')).toLowerCase();
      const userIsActive = userStatus === 'active' && !row.u_deleted_at && row.u_is_active !== false;

      const user = {
        id: row.u_id,
        phone: row.u_phone || null,
        email: row.u_email || null,
        role: String(row.u_role || 'admin').toLowerCase(),
        status: userStatus,
        is_active: userIsActive,
        auth_id: row.u_auth_id || null,
        auth_provider: row.u_auth_provider || 'supabase',
        name: row.u_name || 'Admin User',
        created_at: row.u_created_at,
        updated_at: row.u_updated_at,
        deleted_at: row.u_deleted_at,
      };

      const permissions = Array.isArray(row.permissions) ? row.permissions : [];

      return { session, user, permissions };
    } catch (_) {
      // Fallback to separate queries if schema/join differs (e.g. in minimal unit test harnesses)
      const session = await this.findByToken(tokenHash, client);
      return session ? { session, user: null, permissions: null } : null;
    }
  }

  /**
   * Retrieves an active, non-expired session by token hash.
   *
   * @param {string} tokenHash SHA-256 hash of raw token
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findActiveByToken(tokenHash, client = null) {
    if (mockSessionResolver && mockSessionResolver.findActiveByToken) {
      return mockSessionResolver.findActiveByToken(tokenHash);
    }

    const text = `
      SELECT id, user_id, session_token, ip_address, user_agent,
             is_active, expires_at, last_active_at, created_at, updated_at
      FROM ${this.tableName}
      WHERE session_token = $1 AND is_active = true AND expires_at > CURRENT_TIMESTAMP
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [tokenHash])
      : await this.query(text, [tokenHash]);
    return res.rows[0] || null;
  }

  /**
   * Finds an active session by raw plaintext token by computing its SHA-256 hash.
   *
   * @param {string} rawToken
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findActiveByRawToken(rawToken, client = null) {
    const tokenHash = hashSessionToken(rawToken);
    return this.findActiveByToken(tokenHash, client);
  }

  /**
   * Creates a new administrative session row.
   * Stores ONLY hashed token in session_token column.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.sessionToken SHA-256 hashed token
   * @param {Date} params.expiresAt
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createSession(
    { userId, sessionToken, expiresAt, ipAddress = null, userAgent = null },
    client = null,
  ) {
    if (mockSessionResolver && mockSessionResolver.createSession) {
      return mockSessionResolver.createSession({
        userId,
        sessionToken,
        expiresAt,
        ipAddress,
        userAgent,
      });
    }

    const text = `
      INSERT INTO ${this.tableName} (user_id, session_token, expires_at, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, session_token, ip_address, user_agent,
                is_active, expires_at, last_active_at, created_at, updated_at;
    `;
    const values = [userId, sessionToken, expiresAt, ipAddress, userAgent];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows[0];
  }

  /**
   * Creates a cryptographically secure session.
   * Generates a 256-bit random raw token and stores its SHA-256 hash.
   * Raw token is returned ONLY in the function output and is NEVER persisted in DB.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {Date} params.expiresAt
   * @param {string} [params.ipAddress]
   * @param {string} [params.userAgent]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ session: object, rawToken: string }>}
   */
  async createSecureSession(
    { userId, expiresAt, ipAddress = null, userAgent = null },
    client = null,
  ) {
    const rawToken = generateSecureToken(32);
    const tokenHash = hashSessionToken(rawToken);
    const session = await this.createSession(
      {
        userId,
        sessionToken: tokenHash,
        expiresAt,
        ipAddress,
        userAgent,
      },
      client,
    );
    return { session, rawToken };
  }

  /**
   * Revokes a session by session token hash.
   *
   * @param {string} sessionTokenHash
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>}
   */
  async revokeSession(sessionTokenHash, client = null) {
    if (mockSessionResolver && mockSessionResolver.revokeSession) {
      return mockSessionResolver.revokeSession(sessionTokenHash);
    }

    const text = `
      UPDATE ${this.tableName}
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE session_token = $1 AND is_active = true;
    `;
    const res = client
      ? await client.query(text, [sessionTokenHash])
      : await this.query(text, [sessionTokenHash]);
    return (res.rowCount || 0) > 0;
  }

  /**
   * Revokes a session by raw plaintext token.
   *
   * @param {string} rawToken
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>}
   */
  async revokeRawSession(rawToken, client = null) {
    const tokenHash = hashSessionToken(rawToken);
    return this.revokeSession(tokenHash, client);
  }

  /**
   * Revokes all active sessions for a specific user (Logout-all).
   * Strictly isolated to the provided user ID to prevent BOLA/IDOR.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>} Number of sessions revoked
   */
  async revokeAllUserSessions(userId, client = null) {
    if (mockSessionResolver && mockSessionResolver.revokeAllUserSessions) {
      return mockSessionResolver.revokeAllUserSessions(userId);
    }

    const text = `
      UPDATE ${this.tableName}
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND is_active = true;
    `;
    const res = client ? await client.query(text, [userId]) : await this.query(text, [userId]);
    return res.rowCount || 0;
  }

  /**
   * Revokes every active session for a user except one (e.g. after a password change).
   *
   * @param {string} userId
   * @param {string|null} keepSessionId Session to keep active
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>} Number of sessions revoked
   */
  async revokeOtherUserSessions(userId, keepSessionId, client = null) {
    if (mockSessionResolver && mockSessionResolver.revokeOtherUserSessions) {
      return mockSessionResolver.revokeOtherUserSessions(userId, keepSessionId);
    }

    const text = `
      UPDATE ${this.tableName}
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND is_active = true AND ($2::uuid IS NULL OR id <> $2::uuid);
    `;
    const values = [userId, keepSessionId || null];
    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rowCount || 0;
  }

  /**
   * Updates last active timestamp for a session.
   * Concurrency-safe, updates only active sessions without extending expires_at.
   *
   * @param {string} sessionTokenHash
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>}
   */
  async touchSession(sessionTokenHash, client = null) {
    if (mockSessionResolver && mockSessionResolver.touchSession) {
      return mockSessionResolver.touchSession(sessionTokenHash);
    }

    const text = `
      UPDATE ${this.tableName}
      SET last_active_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE session_token = $1 AND is_active = true;
    `;
    const res = client
      ? await client.query(text, [sessionTokenHash])
      : await this.query(text, [sessionTokenHash]);
    return (res.rowCount || 0) > 0;
  }

  /**
   * Counts active, non-expired sessions for a user.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async countActiveSessionsByUserId(userId, client = null) {
    if (mockSessionResolver && mockSessionResolver.countActiveSessionsByUserId) {
      return mockSessionResolver.countActiveSessionsByUserId(userId);
    }

    const text = `
      SELECT COUNT(*)::int AS count
      FROM ${this.tableName}
      WHERE user_id = $1 AND is_active = true AND expires_at > CURRENT_TIMESTAMP;
    `;
    const res = client ? await client.query(text, [userId]) : await this.query(text, [userId]);
    return res.rows[0]?.count || 0;
  }

  /**
   * Safely revokes oldest active sessions for a user when concurrent session limit is exceeded.
   * Keeps the newest `keepCount` sessions and revokes older active sessions.
   *
   * @param {string} userId
   * @param {number} keepCount Number of newest sessions to keep
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>} Number of sessions revoked
   */
  async revokeOldestSessions(userId, keepCount, client = null) {
    if (mockSessionResolver && mockSessionResolver.revokeOldestSessions) {
      return mockSessionResolver.revokeOldestSessions(userId, keepCount);
    }

    const text = `
      WITH to_revoke AS (
        SELECT id
        FROM ${this.tableName}
        WHERE user_id = $1 AND is_active = true AND expires_at > CURRENT_TIMESTAMP
        ORDER BY created_at DESC
        OFFSET $2
      )
      UPDATE ${this.tableName}
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id IN (SELECT id FROM to_revoke);
    `;
    const res = client
      ? await client.query(text, [userId, keepCount])
      : await this.query(text, [userId, keepCount]);
    return res.rowCount || 0;
  }

  /**
   * Cleanup contract for expired and inactive sessions older than a retention threshold.
   * Never deletes active non-expired sessions.
   *
   * @param {Date} olderThanDate
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async cleanupExpiredSessions(olderThanDate, client = null) {
    if (mockSessionResolver && mockSessionResolver.cleanupExpiredSessions) {
      return mockSessionResolver.cleanupExpiredSessions(olderThanDate);
    }

    const text = `
      DELETE FROM ${this.tableName}
      WHERE (is_active = false OR expires_at < CURRENT_TIMESTAMP)
        AND updated_at < $1;
    `;
    const res = client
      ? await client.query(text, [olderThanDate])
      : await this.query(text, [olderThanDate]);
    return res.rowCount || 0;
  }

  /**
   * Retrieves all active non-expired sessions for a user.
   * Safe projection: never includes session_token.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async findActiveSessionsByUserId(userId, client = null) {
    if (mockSessionResolver && mockSessionResolver.findActiveSessionsByUserId) {
      return mockSessionResolver.findActiveSessionsByUserId(userId);
    }

    const text = `
      SELECT id, user_id, ip_address, user_agent,
             is_active, expires_at, last_active_at, created_at, updated_at
      FROM ${this.tableName}
      WHERE user_id = $1 AND is_active = true AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC;
    `;
    const res = client ? await client.query(text, [userId]) : await this.query(text, [userId]);
    return res.rows;
  }

  /**
   * Finds a session by session ID and strictly verifies ownership by userId.
   *
   * @param {string} sessionId
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findSessionByIdForUser(sessionId, userId, client = null) {
    if (mockSessionResolver && mockSessionResolver.findSessionByIdForUser) {
      return mockSessionResolver.findSessionByIdForUser(sessionId, userId);
    }

    const text = `
      SELECT id, user_id, ip_address, user_agent,
             is_active, expires_at, last_active_at, created_at, updated_at
      FROM ${this.tableName}
      WHERE id = $1 AND user_id = $2
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [sessionId, userId])
      : await this.query(text, [sessionId, userId]);
    return res.rows[0] || null;
  }

  /**
   * Revokes a session by ID strictly scoped to the owner userId.
   * Prevents cross-user session revocation (BOLA/IDOR).
   *
   * @param {string} sessionId
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>}
   */
  async revokeSessionByIdForUser(sessionId, userId, client = null) {
    if (mockSessionResolver && mockSessionResolver.revokeSessionByIdForUser) {
      return mockSessionResolver.revokeSessionByIdForUser(sessionId, userId);
    }

    const text = `
      UPDATE ${this.tableName}
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND user_id = $2 AND is_active = true;
    `;
    const res = client
      ? await client.query(text, [sessionId, userId])
      : await this.query(text, [sessionId, userId]);
    return (res.rowCount || 0) > 0;
  }
}

module.exports = new AdminSessionRepository();
