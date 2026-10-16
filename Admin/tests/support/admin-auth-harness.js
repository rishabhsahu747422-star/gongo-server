'use strict';

/**
 * Test harness for admin authentication.
 *
 * - users / customer_profiles / admin_permissions plus the real migration 056 tables run on
 *   pg-mem, so the production repositories execute their real SQL.
 * - admin_sessions is backed by an in-memory store through the repository's existing mock
 *   resolver hook (same pattern as the other admin integration suites).
 *
 * Nothing in the authentication logic itself is mocked.
 */

const crypto = require('crypto');
const { newDb, DataType } = require('pg-mem');
const { setMockPool, resetMockPool } = require('../../src/db/pool');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const { hashPassword } = require('../../src/utils/password');

const migration056 = require('../../database/migrations/056_create_admin_credentials_and_oauth_identities');

function createSessionStore() {
  const sessions = new Map(); // tokenHash -> session row
  const now = () => new Date();
  const live = (s) => s.is_active && new Date(s.expires_at) > now();
  const resolver = {
    findByToken: async (hash) => sessions.get(hash) || null,
    findActiveByToken: async (hash) => {
      const s = sessions.get(hash);
      return s && live(s) ? s : null;
    },
    createSession: async ({
      userId, sessionToken, expiresAt, ipAddress, userAgent,
    }) => {
      const session = {
        id: crypto.randomUUID(),
        user_id: userId,
        session_token: sessionToken,
        is_active: true,
        expires_at: (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)).toISOString(),
        last_active_at: now().toISOString(),
        created_at: now().toISOString(),
        updated_at: now().toISOString(),
        ip_address: ipAddress,
        user_agent: userAgent,
      };
      sessions.set(sessionToken, session);
      return session;
    },
    revokeSession: async (hash) => {
      const s = sessions.get(hash);
      if (s && s.is_active) {
        s.is_active = false;
        return true;
      }
      return false;
    },
    revokeAllUserSessions: async (userId) => {
      let n = 0;
      sessions.forEach((s) => {
        if (s.user_id === userId && s.is_active) {
          s.is_active = false;
          n += 1;
        }
      });
      return n;
    },
    revokeOtherUserSessions: async (userId, keepId) => {
      let n = 0;
      sessions.forEach((s) => {
        if (s.user_id === userId && s.is_active && s.id !== keepId) {
          s.is_active = false;
          n += 1;
        }
      });
      return n;
    },
    touchSession: async () => true,
    countActiveSessionsByUserId: async (userId) => [...sessions.values()]
      .filter((s) => s.user_id === userId && live(s)).length,
    revokeOldestSessions: async (userId, keep) => {
      const active = [...sessions.values()]
        .filter((s) => s.user_id === userId && live(s))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const toRevoke = active.slice(keep);
      toRevoke.forEach((s) => { s.is_active = false; });
      return toRevoke.length;
    },
    findSessionByIdForUser: async (id, userId) => [...sessions.values()]
      .find((s) => s.id === id && s.user_id === userId) || null,
  };
  return { sessions, resolver };
}

function createAuthHarness() {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => crypto.randomUUID(),
  });
  db.public.registerFunction({
    name: 'regexp_replace',
    args: [DataType.text, DataType.text, DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (s, p, r, f) => s.replace(new RegExp(p, f.includes('g') ? 'g' : ''), r),
  });
  db.public.registerFunction({
    name: 'trim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (s) => (typeof s === 'string' ? s.trim() : s),
  });
  db.public.registerFunction({
    name: 'btrim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (s) => (typeof s === 'string' ? s.trim() : s),
  });
  db.public.none(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255),
      phone VARCHAR(20),
      role VARCHAR(20) NOT NULL DEFAULT 'customer',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      is_active BOOLEAN DEFAULT true,
      deleted_at TIMESTAMPTZ,
      auth_id VARCHAR(128),
      auth_provider VARCHAR(50),
      name VARCHAR(150),
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE customer_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID UNIQUE REFERENCES users(id),
      full_name VARCHAR(150),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE admin_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission VARCHAR(50) NOT NULL,
      assigned_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_admin_permissions_user_permission UNIQUE (user_id, permission)
    );
  `);

  const pgm = {
    sql: async (statement) => {
      // pg-mem cannot run PL/pgSQL, triggers, RLS or expression indexes
      const unsupported = ['LANGUAGE plpgsql', 'TRIGGER', 'ROW LEVEL SECURITY', 'LOWER(email)'];
      if (!unsupported.some((s) => statement.includes(s))) db.public.none(statement);
    },
  };

  const store = createSessionStore();

  const harness = {
    db,
    sessions: store.sessions,

    async install() {
      await migration056.up(pgm);
      const { Pool } = db.adapters.createPg();
      setMockPool(new Pool());
      adminSessionRepository.constructor.setMockSessionResolver(store.resolver);
    },

    uninstall() {
      resetMockPool();
      adminSessionRepository.constructor.resetMockSessionResolver();
    },

    addUser({
      email = null, phone = null, role = 'admin', status = 'active', isActive = true, name = null, authId = null,
    } = {}) {
      const id = crypto.randomUUID();
      const lit = (v) => (v ? `'${v}'` : 'NULL');
      db.public.none(`
        INSERT INTO users (id, email, phone, role, status, is_active, name, auth_id)
        VALUES ('${id}', ${lit(email)}, ${lit(phone)}, '${role}', '${status}', ${isActive}, ${lit(name)}, ${lit(authId)});
      `);
      return id;
    },

    async setPassword(userId, password, { mustChange = false } = {}) {
      const hash = await hashPassword(password);
      db.public.none(`
        INSERT INTO admin_credentials (user_id, password_hash, must_change_password)
        VALUES ('${userId}', '${hash}', ${mustChange});
      `);
    },

    grant(userId, permission) {
      db.public.none(`INSERT INTO admin_permissions (user_id, permission) VALUES ('${userId}', '${permission}');`);
    },

    linkGoogle(userId, subject, email = null) {
      db.public.none(`
        INSERT INTO admin_oauth_identities (user_id, provider, provider_subject, provider_email)
        VALUES ('${userId}', 'google', '${subject}', ${email ? `'${email}'` : 'NULL'});
      `);
    },

    setUserStatus(userId, status) {
      db.public.none(`UPDATE users SET status = '${status}' WHERE id = '${userId}';`);
    },

    one(sql) {
      return db.public.many(sql)[0] || null;
    },

    many(sql) {
      return db.public.many(sql);
    },
  };
  return harness;
}

module.exports = { createAuthHarness };
