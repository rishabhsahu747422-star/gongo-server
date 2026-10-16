'use strict';

/* eslint-disable no-restricted-syntax, no-await-in-loop */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newDb, DataType } = require('pg-mem');
const { getMigrationFiles } = require('../../../src/db/migrator');

const CANONICAL_MIGRATIONS_DIR = path.resolve(__dirname, '../../../../Partner/database/migrations');

/**
 * Reads canonical shared migrations from Partner backend.
 */
function getCanonicalMigrations() {
  if (!fs.existsSync(CANONICAL_MIGRATIONS_DIR)) {
    return [];
  }
  const files = fs
    .readdirSync(CANONICAL_MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('.'))
    .sort();

  return files.map((file) => {
    const fullPath = path.join(CANONICAL_MIGRATIONS_DIR, file);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(fullPath);
    return { name: file, fullPath, module: mod };
  });
}

/**
 * Statements that real PostgreSQL/Supabase accepts but the pg-mem SQL parser cannot parse
 * (row-level security, policies, ownership changes; currently only Partner 044_create_ratings_table
 * uses RLS/POLICY). They carry no table/column/
 * constraint semantics that this suite asserts on, so the in-memory harness drops ONLY these
 * individual statements and executes everything else in the migration chunk unchanged.
 * Real migrations are unaffected (this list lives in the test harness only).
 */
const PG_MEM_UNSUPPORTED_STATEMENTS = [
  /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?[\w."]+\s+(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY$/i,
  /^(?:CREATE|DROP|ALTER)\s+POLICY\b/i,
  /^ALTER\s+(?:TABLE|FUNCTION|SEQUENCE|VIEW|TYPE|SCHEMA)\b[\s\S]*\bOWNER\s+TO\b/i,
];

/**
 * Splits a SQL chunk into top-level statements on ';', respecting single/double quotes,
 * dollar-quoted bodies ($$ ... $$ / $tag$ ... $tag$) and -- / block comments.
 */
function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const rest = sql.slice(i);
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
    } else if (ch === '\'' || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) { j += 2; } else if (sql[j] === ch) { break; } else { j += 1; }
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '$' && /^\$[A-Za-z_]*\$/.test(rest)) {
      const tag = rest.match(/^\$[A-Za-z_]*\$/)[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
    } else if (ch === ';') {
      statements.push(current);
      current = '';
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  statements.push(current);
  return statements.filter((s) => s.trim().length > 0);
}

function stripCommentsForMatch(statement) {
  return statement
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Removes only pg-mem-unparseable statements (see PG_MEM_UNSUPPORTED_STATEMENTS). */
function removePgMemUnsupportedStatements(sql) {
  const statements = splitSqlStatements(sql);
  const kept = statements.filter((s) => {
    const normalized = stripCommentsForMatch(s);
    return !PG_MEM_UNSUPPORTED_STATEMENTS.some((re) => re.test(normalized));
  });
  if (kept.length === statements.length) return sql;
  return kept.map((s) => `${s};`).join('\n');
}

/**
 * Admin migrations written against the live Supabase schema: they ALTER tables that exist only
 * in the production database baseline (created out-of-band, e.g. via Partner/scripts/
 * apply_supabase_alignment.js) and are not created by any migration in this repository, so they
 * cannot be replayed on a clean in-memory chain. They are still discovered and checked for
 * up/down exports; a dedicated test below verifies each listed table is really referenced and
 * really absent from the repo migration chain, so this list cannot silently go stale.
 */
const SUPABASE_BASELINE_DEPENDENT_MIGRATIONS = {
  '050_partner_payout_requests_and_manual_payment.js': ['partner_payouts'],
  '054_add_global_public_reference_ids.js': ['customer_profiles'],
  '055_add_car_platform_charge_settings.js': ['platform_charge_settings'],
};

describe('Phase 1: Database Migrations & Schema Foundation Test Suite', () => {
  let db;
  let canonicalMigrations;
  let adminMigrations;
  // Admin migrations replayable on the clean canonical chain (all except the documented
  // Supabase-baseline-dependent ones above).
  let replayableAdminMigrations;
  let pgm;

  beforeAll(() => {
    canonicalMigrations = getCanonicalMigrations();
    adminMigrations = getMigrationFiles();
    replayableAdminMigrations = adminMigrations.filter(
      (m) => !Object.prototype.hasOwnProperty.call(SUPABASE_BASELINE_DEPENDENT_MIGRATIONS, m.name),
    );
  });

  beforeEach(() => {
    db = newDb();

    // Register pgcrypto gen_random_uuid in pg-mem
    db.registerExtension('pgcrypto', (schema) => {
      schema.registerFunction({
        name: 'gen_random_uuid',
        returns: DataType.uuid,
        impure: true,
        implementation: () => crypto.randomUUID(),
      });
    });

    // pg-mem SQL adapter
    pgm = {
      sql: async (statement) => {
        if (!statement || typeof statement !== 'string' || !statement.trim()) return;
        // Skip PL/pgSQL function bodies, triggers, and function drops in memory tests
        if (
          !statement.includes('LANGUAGE plpgsql')
          && !statement.includes('CREATE TRIGGER')
          && !statement.includes('DROP TRIGGER')
          && !statement.includes('DROP FUNCTION')
          && !statement.includes('admin_actions ALTER COLUMN admin_id')
          && !statement.includes('admin_actions ALTER COLUMN action_type')
          && !statement.includes('admin_actions ALTER COLUMN target_type')
        ) {
          const executable = removePgMemUnsupportedStatements(statement);
          if (executable.trim()) {
            db.public.none(executable);
          }

          // Workaround for pg-mem bug where implicit primary key / unique indexes
          // persist after DROP TABLE
          const dropMatches = [...statement.matchAll(/DROP TABLE (?:IF EXISTS )?([a-z_0-9]+)/gi)];
          for (const match of dropMatches) {
            const tbl = match[1];
            const indicesToClean = [
              `${tbl}_pkey`,
              `${tbl}_key_key`,
              `${tbl}_session_token_key`,
              `${tbl}_refund_number_key`,
              `${tbl}_dispute_number_key`,
              `${tbl}_template_key_key`,
              `uq_${tbl}_user_permission`,
              `uq_${tbl}_type_tier`, // 051 cancellation_refund_rules UNIQUE (vehicle_type, tier)
              `uq_${tbl}_subject`, // 056 admin_oauth_identities UNIQUE (provider, provider_subject)
              `uq_${tbl}_user_provider`, // 056 admin_oauth_identities UNIQUE (user_id, provider)
            ];
            for (const idx of indicesToClean) {
              try {
                db.public.none(`DROP INDEX IF EXISTS ${idx};`);
              } catch (_) {
                // Ignore if already dropped
              }
            }
          }
        }
      },
    };
  });

  // ── 1. Migration Discovery & Ordering ─────────────────────────────────────────
  describe('1. Migration Discovery & Ordering', () => {
    it('discovers all canonical shared migrations (37+ files)', () => {
      expect(canonicalMigrations.length).toBeGreaterThanOrEqual(37);
      expect(canonicalMigrations[0].name).toBe('001_extensions.js');
    });

    it('discovers all Admin migrations (19 files: foundation 038-049 + 050-056) sequentially starting at 038', () => {
      expect(adminMigrations.length).toBe(19);
      expect(adminMigrations[0].name).toBe('038_create_admin_actions_table.js');
      expect(adminMigrations[1].name).toBe('039_create_admin_permissions_table.js');
      expect(adminMigrations[2].name).toBe('040_create_admin_settings_table.js');
      expect(adminMigrations[3].name).toBe('041_create_admin_sessions_table.js');
      expect(adminMigrations[4].name).toBe('042_update_admin_permissions_check.js');
      expect(adminMigrations[5].name).toBe('043_create_refunds_and_commission_rules_tables.js');
      expect(adminMigrations[6].name).toBe('044_create_disputes_table.js');
      expect(adminMigrations[7].name).toBe('045_reconcile_support_tickets_table.js');
      expect(adminMigrations[8].name).toBe('046_reconcile_notifications_and_templates.js');
      expect(adminMigrations[9].name).toBe('047_add_outbox_locking_columns.js');
      expect(adminMigrations[10].name).toBe('048_align_admin_user_schema_and_roles.js');
      expect(adminMigrations[11].name).toBe('049_add_vehicle_image_verification_and_versioning.js');
      expect(adminMigrations[12].name).toBe('050_partner_payout_requests_and_manual_payment.js');
      expect(adminMigrations[13].name).toBe('051_create_cancellation_refund_rules_table.js');
      expect(adminMigrations[14].name).toBe('052_create_franchise_applications_table.js');
      expect(adminMigrations[15].name).toBe('053_refund_manual_payout_and_status_alignment.js');
      expect(adminMigrations[16].name).toBe('054_add_global_public_reference_ids.js');
      expect(adminMigrations[17].name).toBe('055_add_car_platform_charge_settings.js');
      expect(adminMigrations[18].name).toBe('056_create_admin_credentials_and_oauth_identities.js');
    });

    it('documents every Admin migration that depends on Supabase-baseline tables absent from the repo migration chain', () => {
      const allSources = [...canonicalMigrations, ...adminMigrations]
        .map((m) => fs.readFileSync(m.fullPath, 'utf8'));
      for (const [name, tables] of Object.entries(SUPABASE_BASELINE_DEPENDENT_MIGRATIONS)) {
        const migration = adminMigrations.find((m) => m.name === name);
        expect(migration).toBeDefined();
        const source = fs.readFileSync(migration.fullPath, 'utf8');
        for (const table of tables) {
          // The migration really targets the table...
          expect(source).toMatch(new RegExp(`\\b${table}\\b`));
          // ...and no migration in this repo creates it (it only exists in the live Supabase DB).
          const createRe = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`, 'i');
          expect(allSources.some((src) => createRe.test(src))).toBe(false);
        }
      }
      // Every migration executed below is the full list minus exactly these documented ones.
      expect(replayableAdminMigrations.length + Object.keys(SUPABASE_BASELINE_DEPENDENT_MIGRATIONS).length)
        .toBe(adminMigrations.length);
    });

    it('ensures all Admin migrations export both up and down functions', () => {
      for (const m of adminMigrations) {
        expect(typeof m.module.up).toBe('function');
        expect(typeof m.module.down).toBe('function');
      }
    });
  });

  // ── 2. Sequential Execution & Shared DB Compatibility ─────────────────────────
  describe('2. Sequential Execution on Canonical Shared Database', () => {
    it('applies all canonical migrations followed by admin migrations without conflict', async () => {
      // 1. Run canonical migrations (001 - 037)
      for (const m of canonicalMigrations) {
        await m.module.up(pgm);
      }

      // Verify canonical tables exist
      const usersCheck = db.public.many('SELECT * FROM users;');
      expect(usersCheck).toEqual([]);

      const bookingsCheck = db.public.many('SELECT * FROM bookings;');
      expect(bookingsCheck).toEqual([]);

      const auditLogsCheck = db.public.many('SELECT * FROM audit_logs;');
      expect(auditLogsCheck).toEqual([]);

      // 2. Run Admin migrations (038 - 041)
      for (const m of replayableAdminMigrations) {
        await m.module.up(pgm);
      }

      // Verify Admin tables exist
      const adminActions = db.public.many('SELECT * FROM admin_actions;');
      expect(adminActions).toEqual([]);

      const adminPermissions = db.public.many('SELECT * FROM admin_permissions;');
      expect(adminPermissions).toEqual([]);

      const adminSettings = db.public.many('SELECT * FROM admin_settings;');
      expect(adminSettings).toEqual([]);

      const adminSessions = db.public.many('SELECT * FROM admin_sessions;');
      expect(adminSessions).toEqual([]);

      const disputes = db.public.many('SELECT * FROM disputes;');
      expect(disputes).toEqual([]);

      const templates = db.public.many('SELECT * FROM notification_templates;');
      expect(templates).toEqual([]);

      // 051 seeds 3 bike + 3 car cancellation tiers
      const refundRules = db.public.many('SELECT vehicle_type FROM cancellation_refund_rules;');
      expect(refundRules).toHaveLength(6);

      const franchiseApplications = db.public.many('SELECT * FROM franchise_applications;');
      expect(franchiseApplications).toEqual([]);

      // 053 adds manual refund payout columns
      const refundColumns = db.public.many('SELECT utr, payment_method, notes FROM refunds;');
      expect(refundColumns).toEqual([]);
    });
  });

  // ── 3. Table Constraints & Foreign Key Integrity ──────────────────────────────
  describe('3. Table Constraints & Data Integrity', () => {
    beforeEach(async () => {
      for (const m of canonicalMigrations) {
        await m.module.up(pgm);
      }
      for (const m of replayableAdminMigrations) {
        await m.module.up(pgm);
      }
    });

    it('enforces foreign key integrity on admin_actions (actor_id -> users.id)', async () => {
      // Insertion without valid user must fail
      const nonExistentId = 'a0000000-0000-0000-0000-000000000001';
      expect(() => {
        db.public.none(`
          INSERT INTO admin_actions (actor_id, action, target_resource)
          VALUES ('${nonExistentId}', 'APPROVE_KYC', 'PARTNER');
        `);
      }).toThrow();

      // Insert valid user first
      db.public.none(`
        INSERT INTO users (id, auth_id, role, name, phone, email)
        VALUES ('${nonExistentId}', 'firebase_admin_1', 'ADMIN', 'Admin User', '+919999999999', 'admin@gongo.com');
      `);

      // Insertion with valid user succeeds
      db.public.none(`
        INSERT INTO admin_actions (actor_id, action, target_resource, metadata)
        VALUES ('${nonExistentId}', 'APPROVE_KYC', 'PARTNER', '{"partnerId":"p123"}');
      `);

      const rows = db.public.many('SELECT * FROM admin_actions;');
      expect(rows.length).toBe(1);
      expect(rows[0].actor_id).toBe(nonExistentId);
      expect(rows[0].actor_role).toBe('ADMIN');
      expect(rows[0].action).toBe('APPROVE_KYC');
    });

    it('enforces check constraints on admin_actions action and target_resource', () => {
      const validUserId = 'a0000000-0000-0000-0000-000000000002';
      db.public.none(`
        INSERT INTO users (id, auth_id, role, name, phone, email)
        VALUES ('${validUserId}', 'firebase_admin_2', 'ADMIN', 'Admin 2', '+919999999998', 'admin2@gongo.com');
      `);

      // Empty action string must fail
      expect(() => {
        db.public.none(`
          INSERT INTO admin_actions (actor_id, action, target_resource)
          VALUES ('${validUserId}', '', 'PARTNER');
        `);
      }).toThrow();

      // Empty target_resource string must fail
      expect(() => {
        db.public.none(`
          INSERT INTO admin_actions (actor_id, action, target_resource)
          VALUES ('${validUserId}', 'ACTION_1', '');
        `);
      }).toThrow();
    });

    it('enforces RBAC permission check constraint and uniqueness on admin_permissions', () => {
      const adminId = 'a0000000-0000-0000-0000-000000000003';
      db.public.none(`
        INSERT INTO users (id, auth_id, role, name, phone, email)
        VALUES ('${adminId}', 'firebase_admin_3', 'ADMIN', 'Admin 3', '+919999999997', 'admin3@gongo.com');
      `);

      // After Phase 4 migration 042, the restrictive CHECK constraint is dropped.
      // Application-layer validation (VALID_PERMISSIONS set) now enforces the permission catalog.
      // The DB still enforces UNIQUE(user_id, permission) and VARCHAR(50) length.
      // Granular domain.action permissions (e.g. 'customers.read') are now valid.
      db.public.none(`
        INSERT INTO admin_permissions (user_id, permission)
        VALUES ('${adminId}', 'customers.read');
      `);

      // Clean up the test row so we can test SUPER_ADMIN insertion below
      db.public.none(`
        DELETE FROM admin_permissions WHERE user_id = '${adminId}' AND permission = 'customers.read';
      `);

      // Valid permission succeeds
      db.public.none(`
        INSERT INTO admin_permissions (user_id, permission)
        VALUES ('${adminId}', 'SUPER_ADMIN');
      `);

      // Duplicate permission fails unique constraint
      expect(() => {
        db.public.none(`
          INSERT INTO admin_permissions (user_id, permission)
          VALUES ('${adminId}', 'SUPER_ADMIN');
        `);
      }).toThrow();

      // Different valid permission for same user succeeds
      db.public.none(`
        INSERT INTO admin_permissions (user_id, permission)
        VALUES ('${adminId}', 'FINANCE_ADMIN');
      `);

      const perms = db.public.many(`SELECT permission FROM admin_permissions WHERE user_id = '${adminId}' ORDER BY permission;`);
      expect(perms).toEqual([{ permission: 'FINANCE_ADMIN' }, { permission: 'SUPER_ADMIN' }]);
    });

    it('enforces unique key constraint and category check on admin_settings', () => {
      // Invalid category fails
      expect(() => {
        db.public.none(`
          INSERT INTO admin_settings (category, key, value)
          VALUES ('unsupported_cat', 'test_key', '{"enabled": true}');
        `);
      }).toThrow();

      // Valid setting succeeds
      db.public.none(`
        INSERT INTO admin_settings (category, key, value, description)
        VALUES ('commission', 'base_commission_rate', '{"percentage": 10}', 'Default partner commission');
      `);

      // Duplicate key fails
      expect(() => {
        db.public.none(`
          INSERT INTO admin_settings (category, key, value)
          VALUES ('commission', 'base_commission_rate', '{"percentage": 15}');
        `);
      }).toThrow();
    });

    it('enforces session token uniqueness and cascade deletion on admin_sessions', () => {
      const adminId = 'a0000000-0000-0000-0000-000000000004';
      db.public.none(`
        INSERT INTO users (id, auth_id, role, name, phone, email)
        VALUES ('${adminId}', 'firebase_admin_4', 'ADMIN', 'Admin 4', '+919999999996', 'admin4@gongo.com');
      `);

      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      db.public.none(`
        INSERT INTO admin_sessions (user_id, session_token, expires_at)
        VALUES ('${adminId}', 'session_token_xyz', '${expiresAt}');
      `);

      // Duplicate token fails
      expect(() => {
        db.public.none(`
          INSERT INTO admin_sessions (user_id, session_token, expires_at)
          VALUES ('${adminId}', 'session_token_xyz', '${expiresAt}');
        `);
      }).toThrow();

      // Deleting user cascades to admin_sessions
      db.public.none(`DELETE FROM users WHERE id = '${adminId}';`);
      const sessions = db.public.many(`SELECT * FROM admin_sessions WHERE user_id = '${adminId}';`);
      expect(sessions.length).toBe(0);
    });

    it('enforces one credential per admin and unique Google identity links (056)', () => {
      const adminA = 'a0000000-0000-0000-0000-00000000000a';
      const adminB = 'a0000000-0000-0000-0000-00000000000b';
      db.public.none(`
        INSERT INTO users (id, auth_id, role, name, phone, email) VALUES
          ('${adminA}', 'auth_a', 'ADMIN', 'Admin A', '+919999999981', 'a@gongo.com'),
          ('${adminB}', 'auth_b', 'ADMIN', 'Admin B', '+919999999982', 'b@gongo.com');
      `);

      db.public.none(`INSERT INTO admin_credentials (user_id, password_hash) VALUES ('${adminA}', 'scrypt$x');`);
      expect(() => db.public.none(
        `INSERT INTO admin_credentials (user_id, password_hash) VALUES ('${adminA}', 'scrypt$y');`,
      )).toThrow();
      const [cred] = db.public.many(`SELECT * FROM admin_credentials WHERE user_id = '${adminA}';`);
      expect(cred.must_change_password).toBe(false);
      expect(cred.failed_login_count).toBe(0);

      db.public.none(`
        INSERT INTO admin_oauth_identities (user_id, provider, provider_subject)
        VALUES ('${adminA}', 'google', 'google-sub-1');
      `);
      // Same Google subject cannot be linked to a second admin
      expect(() => db.public.none(`
        INSERT INTO admin_oauth_identities (user_id, provider, provider_subject)
        VALUES ('${adminB}', 'google', 'google-sub-1');
      `)).toThrow();
      // One Google link per admin
      expect(() => db.public.none(`
        INSERT INTO admin_oauth_identities (user_id, provider, provider_subject)
        VALUES ('${adminA}', 'google', 'google-sub-2');
      `)).toThrow();
      // Unknown providers rejected
      expect(() => db.public.none(`
        INSERT INTO admin_oauth_identities (user_id, provider, provider_subject)
        VALUES ('${adminB}', 'facebook', 'fb-1');
      `)).toThrow();

      db.public.none(`DELETE FROM users WHERE id = '${adminA}';`);
      expect(db.public.many(`SELECT * FROM admin_credentials WHERE user_id = '${adminA}';`)).toHaveLength(0);
      expect(db.public.many(`SELECT * FROM admin_oauth_identities WHERE user_id = '${adminA}';`)).toHaveLength(0);
    });
  });

  // ── 4. Reversibility & Rollback Safety ─────────────────────────────────────────
  describe('4. Reversibility & Rollback Execution', () => {
    it('executes down migration in reverse order cleanly without leaving orphaned tables', async () => {
      for (const m of canonicalMigrations) {
        await m.module.up(pgm);
      }
      for (const m of replayableAdminMigrations) {
        await m.module.up(pgm);
      }

      // Rollback Admin migrations in reverse order (041 -> 040 -> 039 -> 038)
      const reversedAdmin = [...replayableAdminMigrations].reverse();
      for (const m of reversedAdmin) {
        await m.module.down(pgm);
      }

      // Verify Admin tables were dropped
      expect(() => db.public.many('SELECT * FROM admin_sessions;')).toThrow();
      expect(() => db.public.many('SELECT * FROM admin_settings;')).toThrow();
      expect(() => db.public.many('SELECT * FROM admin_permissions;')).toThrow();
      expect(() => db.public.many('SELECT * FROM admin_actions;')).toThrow();
      expect(() => db.public.many('SELECT * FROM disputes;')).toThrow();
      expect(() => db.public.many('SELECT * FROM notification_templates;')).toThrow();

      // Verify canonical shared tables remain intact
      const usersCheck = db.public.many('SELECT * FROM users;');
      expect(usersCheck).toEqual([]);
      const bookingsCheck = db.public.many('SELECT * FROM bookings;');
      expect(bookingsCheck).toEqual([]);
      const auditLogsCheck = db.public.many('SELECT * FROM audit_logs;');
      expect(auditLogsCheck).toEqual([]);
    });

    it('supports re-applying migrations after rollback (idempotency/reversibility)', async () => {
      for (const m of canonicalMigrations) {
        await m.module.up(pgm);
      }
      for (const m of replayableAdminMigrations) {
        await m.module.up(pgm);
      }

      // Rollback
      for (const m of [...replayableAdminMigrations].reverse()) {
        await m.module.down(pgm);
      }

      // Re-apply
      for (const m of replayableAdminMigrations) {
        await m.module.up(pgm);
      }

      const adminActions = db.public.many('SELECT * FROM admin_actions;');
      expect(adminActions).toEqual([]);
    });
  });
});
