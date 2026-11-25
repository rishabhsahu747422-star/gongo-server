'use strict';

const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const migration = require('../../../database/migrations/1726300000000_create-users-table');

describe('Database Migration: 1726300000000_create-users-table', () => {
  let db;

  beforeEach(() => {
    db = newDb();
    db.registerExtension('pgcrypto', (schema) => {
      schema.registerFunction({
        name: 'gen_random_uuid',
        returns: DataType.uuid,
        impure: true,
        implementation: () => crypto.randomUUID(),
      });
    });
  });

  it('should export up and down migration functions', () => {
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });

  it('should successfully apply up migration and create the users schema', async () => {
    // Collect all executed SQL statements
    const executedSql = [];
    const pgm = {
      sql: (statement) => {
        executedSql.push(statement);
        // Execute statements supported by pg-mem
        // (skip plpgsql functions & triggers in memory test)
        if (!statement.includes('LANGUAGE plpgsql') && !statement.includes('CREATE TRIGGER')) {
          db.public.none(statement);
        }
      },
    };

    await migration.up(pgm);

    expect(executedSql.length).toBeGreaterThanOrEqual(4);

    // Verify users table exists with all required columns
    const columns = db.public.many(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'users'
      ORDER BY ordinal_position;
    `);

    const colNames = columns.map((c) => c.column_name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('role');
    expect(colNames).toContain('name');
    expect(colNames).toContain('country_code');
    expect(colNames).toContain('phone');
    expect(colNames).toContain('email');
    expect(colNames).toContain('auth_provider');
    expect(colNames).toContain('auth_id');
    expect(colNames).toContain('is_active');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');

    // Verify primary key constraint
    const row = db.public.one(`
      INSERT INTO users (phone, email)
      VALUES ('9876543210', 'migration_test@gongo.in')
      RETURNING id, role, country_code, is_active;
    `);

    expect(row.id).toBeDefined();
    expect(row.role).toBe('customer');
    expect(row.country_code).toBe('+91');
    expect(row.is_active).toBe(true);
  });

  it('should execute down migration cleanly', async () => {
    const pgm = {
      sql: (statement) => {
        // Test statement capture for rollback
        expect(typeof statement).toBe('string');
      },
    };

    await expect(migration.down(pgm)).resolves.not.toThrow();
  });
});
