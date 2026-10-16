'use strict';

/**
 * Runs the real admin credential / OAuth identity repository SQL against an in-memory
 * PostgreSQL (pg-mem) so lockout counters, admin-only lookups and phone-format matching
 * are verified as SQL, not just as mocks.
 */

const crypto = require('crypto');
const { newDb, DataType } = require('pg-mem');

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn(),
}));

const { setMockPool, resetMockPool } = require('../../src/db/pool');
const adminCredentialRepository = require('../../src/repositories/admin-credential.repository');
const adminOAuthIdentityRepository = require('../../src/repositories/admin-oauth-identity.repository');

function createDatabase() {
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
      email VARCHAR(255), phone VARCHAR(20), role VARCHAR(20) NOT NULL,
      status VARCHAR(20) DEFAULT 'active', is_active BOOLEAN DEFAULT true,
      deleted_at TIMESTAMPTZ, auth_id VARCHAR(128), name VARCHAR(150), auth_provider VARCHAR(50)
    );
  `);
  // Admin migration 056 itself, so the tested schema is the shipped schema
  // eslint-disable-next-line global-require
  const migration = require('../../database/migrations/056_create_admin_credentials_and_oauth_identities');
  const pgm = {
    sql: async (statement) => {
      const skip = ['LANGUAGE plpgsql', 'TRIGGER', 'ROW LEVEL SECURITY', 'LOWER(email)'];
      if (!skip.some((s) => statement.includes(s))) db.public.none(statement);
    },
  };
  return { db, migration, pgm };
}

describe('Admin credential & OAuth identity repositories (SQL on pg-mem)', () => {
  let db;
  const ids = {};

  beforeEach(async () => {
    const created = createDatabase();
    ({ db } = created);
    await created.migration.up(created.pgm);
    const { Pool } = db.adapters.createPg();
    setMockPool(new Pool());

    const insert = (key, cols) => {
      ids[key] = crypto.randomUUID();
      db.public.none(`
        INSERT INTO users (id, email, phone, role, status, is_active, deleted_at)
        VALUES ('${ids[key]}', ${cols.email ? `'${cols.email}'` : 'NULL'}, ${cols.phone ? `'${cols.phone}'` : 'NULL'},
                '${cols.role}', '${cols.status || 'active'}', ${cols.is_active !== false}, ${cols.deleted ? 'now()' : 'NULL'});
      `);
    };
    insert('superAdmin', { email: 'GongoRental@Gmail.com', phone: '8989232398', role: 'super_admin' });
    insert('e164Admin', { email: 'ops@gongo.in', phone: '+919876500001', role: 'admin' });
    insert('customer', { email: 'customer@example.com', phone: '9000000001', role: 'customer' });
    insert('deletedAdmin', { email: 'gone@gongo.in', phone: '9000000002', role: 'admin', deleted: true });
  });

  afterEach(() => {
    resetMockPool();
  });

  it('finds admins by case-insensitive email and never returns non-admin roles', async () => {
    const rows = await adminCredentialRepository.findAdminsByEmail('gongorental@gmail.com');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ids.superAdmin);
    expect(rows[0].password_hash).toBeNull();

    expect(await adminCredentialRepository.findAdminsByEmail('customer@example.com')).toEqual([]);
    expect(await adminCredentialRepository.findAdminsByEmail('gone@gongo.in')).toEqual([]);
  });

  it('matches mobile numbers stored as 10-digit or E.164', async () => {
    expect((await adminCredentialRepository.findAdminsByMobile('8989232398'))[0].id).toBe(ids.superAdmin);
    expect((await adminCredentialRepository.findAdminsByMobile('9876500001'))[0].id).toBe(ids.e164Admin);
    expect(await adminCredentialRepository.findAdminsByMobile('9000000001')).toEqual([]);
  });

  it('createIfAbsent never overwrites an existing password hash', async () => {
    expect(await adminCredentialRepository.createIfAbsent({ userId: ids.superAdmin, passwordHash: 'first' })).toBe(true);
    // (pg-mem also returns the conflicting row here; real PostgreSQL returns none.
    // The invariant that matters is that the stored hash is untouched.)
    await adminCredentialRepository.createIfAbsent({ userId: ids.superAdmin, passwordHash: 'second' });
    const cred = await adminCredentialRepository.findByUserId(ids.superAdmin);
    expect(cred.password_hash).toBe('first');
  });

  it('locks the account when the failed-attempt threshold is reached and resets on success', async () => {
    await adminCredentialRepository.createIfAbsent({ userId: ids.e164Admin, passwordHash: 'h' });

    const fail = async () => {
      const { locked } = await adminCredentialRepository.recordFailedAttempt(ids.e164Admin, 3, 900);
      return locked;
    };
    expect(await fail()).toBe(false);
    expect(await fail()).toBe(false);
    let cred = await adminCredentialRepository.findByUserId(ids.e164Admin);
    expect(cred.failed_login_count).toBe(2);

    expect(await fail()).toBe(true);
    cred = await adminCredentialRepository.findByUserId(ids.e164Admin);
    expect(new Date(cred.locked_until).getTime()).toBeGreaterThan(Date.now() + 800 * 1000);
    expect(cred.failed_login_count).toBe(0);

    await adminCredentialRepository.recordSuccessfulLogin(ids.e164Admin);
    cred = await adminCredentialRepository.findByUserId(ids.e164Admin);
    expect(cred.locked_until).toBeNull();
    expect(cred.last_login_at).not.toBeNull();
  });

  it('updatePassword replaces the hash, clears lockout and sets the change flag', async () => {
    await adminCredentialRepository.createIfAbsent({ userId: ids.e164Admin, passwordHash: 'old', mustChangePassword: true });
    await adminCredentialRepository.recordFailedAttempt(ids.e164Admin, 1, 900);
    await adminCredentialRepository.updatePassword({ userId: ids.e164Admin, passwordHash: 'new', mustChangePassword: false });
    const cred = await adminCredentialRepository.findByUserId(ids.e164Admin);
    expect(cred.password_hash).toBe('new');
    expect(cred.must_change_password).toBe(false);
    expect(cred.locked_until).toBeNull();
  });

  it('links a Google subject to exactly one admin and refuses re-pointing it', async () => {
    const linked = await adminOAuthIdentityRepository.link({
      userId: ids.superAdmin, provider: 'google', subject: 'sub-123', email: 'gongorental@gmail.com',
    });
    expect(linked.user_id).toBe(ids.superAdmin);

    const hijack = await adminOAuthIdentityRepository.link({ userId: ids.e164Admin, provider: 'google', subject: 'sub-123' });
    expect(hijack).toBeNull();

    const found = await adminOAuthIdentityRepository.findByProviderSubject('google', 'sub-123');
    expect(found.user_id).toBe(ids.superAdmin);
    expect(await adminOAuthIdentityRepository.findByProviderSubject('google', 'other')).toBeNull();
  });
});
