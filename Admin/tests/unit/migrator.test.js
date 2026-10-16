'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Migrator, ensureMigrationsTable } = require('../../src/db/migrator');

describe('Unit: Migrator Engine & Lifecycle', () => {
  let tempMigrationsDir;
  let mockClient;
  let mockPool;
  let appliedNames;

  beforeEach(() => {
    tempMigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gongo-migrator-test-'));
    appliedNames = [];

    mockClient = {
      query: jest.fn(async (text, values) => {
        if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
          return { rows: [] };
        }
        if (text.includes('SELECT name FROM schema_migrations ORDER BY id ASC')) {
          return { rows: appliedNames.map((n) => ({ name: n })) };
        }
        if (text.includes('SELECT name, executed_at FROM schema_migrations')) {
          return { rows: appliedNames.map((n) => ({ name: n, executed_at: new Date() })) };
        }
        if (text.includes('SELECT name FROM schema_migrations ORDER BY id DESC')) {
          return { rows: appliedNames.slice().reverse().map((n) => ({ name: n })) };
        }
        if (text.includes('INSERT INTO schema_migrations')) {
          appliedNames.push(values[0]);
          return { rowCount: 1 };
        }
        if (text.includes('DELETE FROM schema_migrations')) {
          appliedNames = appliedNames.filter((n) => n !== values[0]);
          return { rowCount: 1 };
        }
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [] };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: jest.fn(),
    };

    mockPool = {
      connect: jest.fn(async () => mockClient),
    };
  });

  afterEach(() => {
    fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
  });

  it('ensures schema_migrations table is created before running operations', async () => {
    await ensureMigrationsTable(mockClient);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS schema_migrations'),
    );
  });

  it('runs pending migrations sequentially in a transaction and records them', async () => {
    // Create two dummy migration files in temp directory
    const m1Path = path.join(tempMigrationsDir, '001_initial.js');
    const m2Path = path.join(tempMigrationsDir, '002_add_field.js');

    fs.writeFileSync(m1Path, `
      exports.up = jest.fn(async () => {});
      exports.down = jest.fn(async () => {});
    `);
    fs.writeFileSync(m2Path, `
      exports.up = jest.fn(async () => {});
      exports.down = jest.fn(async () => {});
    `);

    const migrator = new Migrator({
      dbPool: mockPool,
      migrationsDir: tempMigrationsDir,
    });

    const applied = await migrator.up();

    expect(applied).toEqual(['001_initial.js', '002_add_field.js']);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(appliedNames).toEqual(['001_initial.js', '002_add_field.js']);
  });

  it('rolls back on error and aborts transaction if a migration fails', async () => {
    const m1Path = path.join(tempMigrationsDir, '001_fail.js');
    fs.writeFileSync(m1Path, `
      exports.up = jest.fn(async () => { throw new Error('Syntax error in DDL'); });
      exports.down = jest.fn(async () => {});
    `);

    const migrator = new Migrator({
      dbPool: mockPool,
      migrationsDir: tempMigrationsDir,
    });

    await expect(migrator.up()).rejects.toThrow('Migration 001_fail.js failed: Syntax error in DDL');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(appliedNames).not.toContain('001_fail.js');
  });

  it('correctly tracks and returns migration status', async () => {
    const m1Path = path.join(tempMigrationsDir, '001_test.js');
    const m2Path = path.join(tempMigrationsDir, '002_test.js');
    fs.writeFileSync(m1Path, 'exports.up = async () => {}; exports.down = async () => {};');
    fs.writeFileSync(m2Path, 'exports.up = async () => {}; exports.down = async () => {};');

    // Simulate 001 already applied
    appliedNames = ['001_test.js'];

    const migrator = new Migrator({
      dbPool: mockPool,
      migrationsDir: tempMigrationsDir,
    });

    const statuses = await migrator.status();

    expect(statuses).toEqual([
      expect.objectContaining({ name: '001_test.js', applied: true }),
      expect.objectContaining({ name: '002_test.js', applied: false }),
    ]);
  });

  it('rolls back the last applied migration using down()', async () => {
    const m1Path = path.join(tempMigrationsDir, '001_test.js');
    fs.writeFileSync(m1Path, 'exports.up = async () => {}; exports.down = async () => {};');
    appliedNames = ['001_test.js'];

    const migrator = new Migrator({
      dbPool: mockPool,
      migrationsDir: tempMigrationsDir,
    });

    const rolledBack = await migrator.down();

    expect(rolledBack).toBe('001_test.js');
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM schema_migrations WHERE name = $1'),
      ['001_test.js'],
    );
  });

  it('creates new migration with auto-incremented sequence prefix', () => {
    const migrator = new Migrator({
      dbPool: mockPool,
      migrationsDir: tempMigrationsDir,
    });

    const filePath = migrator.create('test_table_creation');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(path.basename(filePath)).toBe('038_test_table_creation.js');

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('exports.up = async (pgm) =>');
    expect(content).toContain('exports.down = async (pgm) =>');
  });
});
