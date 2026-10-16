'use strict';

const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const baseUsersMigration = require('../../../database/migrations/1726300000000_create-users-table');
const addAvatarMigration = require('../../../database/migrations/1728200000000_add-avatar-to-users');

describe('Database Migration: 1728200000000_add-avatar-to-users', () => {
  let db;
  let pgm;

  beforeEach(async () => {
    db = newDb();
    db.registerExtension('pgcrypto', (schema) => {
      schema.registerFunction({
        name: 'gen_random_uuid',
        returns: DataType.uuid,
        impure: true,
        implementation: () => crypto.randomUUID(),
      });
    });

    pgm = {
      sql: (statement) => {
        if (
          !statement.includes('LANGUAGE plpgsql')
          && !statement.includes('CREATE TRIGGER')
          && !statement.includes('DO $$')
        ) {
          db.public.none(statement);
        }
      },
    };

    // Apply base users migration
    await baseUsersMigration.up(pgm);
  });

  it('1. exports up and down functions', () => {
    expect(typeof addAvatarMigration.up).toBe('function');
    expect(typeof addAvatarMigration.down).toBe('function');
  });

  it('2. adds avatar_storage_key column idempotently', async () => {
    await addAvatarMigration.up(pgm);

    // Verify insertion with avatar_storage_key works
    db.public.none(`
      INSERT INTO users (id, role, name, phone, avatar_storage_key)
      VALUES (
        '11111111-1111-1111-1111-111111111111',
        'customer',
        'Avatar Test User',
        '9876543210',
        'customers/11111111-1111-1111-1111-111111111111/profile/test.jpg'
      );
    `);

    const user = db.public.one("SELECT * FROM users WHERE id = '11111111-1111-1111-1111-111111111111'");
    expect(user.avatar_storage_key).toBe('customers/11111111-1111-1111-1111-111111111111/profile/test.jpg');
  });

  it('3. down migration drops avatar_storage_key cleanly', async () => {
    await addAvatarMigration.down(pgm);

    const check = () => db.public.one('SELECT avatar_storage_key FROM users LIMIT 1');
    expect(check).toThrow();
  });
});
