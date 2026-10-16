'use strict';

const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const usersMigration = require('../../../database/migrations/1726300000000_create-users-table');
const docMigration = require('../../../database/migrations/1726400000000_create-customer-documents-table');

describe('Database Migration: 1726400000000_create-customer-documents-table', () => {
  let db;

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

    // Run users migration first
    const pgmUsers = {
      sql: (statement) => {
        if (!statement.includes('LANGUAGE plpgsql') && !statement.includes('CREATE TRIGGER')) {
          db.public.none(statement);
        }
      },
    };
    await usersMigration.up(pgmUsers);
  });

  it('should export up and down migration functions', () => {
    expect(typeof docMigration.up).toBe('function');
    expect(typeof docMigration.down).toBe('function');
  });

  it('should successfully apply up migration and create customer_documents schema', async () => {
    const executedSql = [];
    const pgm = {
      sql: (statement) => {
        executedSql.push(statement);
        if (!statement.includes('LANGUAGE plpgsql') && !statement.includes('CREATE TRIGGER')) {
          db.public.none(statement);
        }
      },
    };

    await docMigration.up(pgm);
    expect(executedSql.length).toBeGreaterThanOrEqual(3);

    const columns = db.public.many(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'customer_documents'
      ORDER BY ordinal_position;
    `);

    const colNames = columns.map((c) => c.column_name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('document_type');
    expect(colNames).toContain('status');
    expect(colNames).toContain('storage_key');
    expect(colNames).toContain('metadata');
    expect(colNames).toContain('rejection_reason');
    expect(colNames).toContain('verified_at');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');
  });

  it('should execute down migration cleanly', async () => {
    const executedSql = [];
    const pgm = {
      sql: (statement) => {
        executedSql.push(statement);
        if (!statement.includes('LANGUAGE plpgsql') && !statement.includes('TRIGGER')) {
          db.public.none(statement);
        }
      },
    };

    await docMigration.up(pgm);
    await docMigration.down(pgm);

    expect(executedSql).toContain('DROP TABLE IF EXISTS customer_documents CASCADE;');
  });
});
