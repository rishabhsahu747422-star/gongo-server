'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');
const logger = require('../config/logger');

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../database/migrations');

/**
 * Ensures the schema_migrations tracking table exists.
 * Matches the canonical table used across the GONGO shared database.
 *
 * @param {import('pg').PoolClient} client
 */
async function ensureMigrationsTable(client) {
  const sql = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await client.query(sql);
}

/**
 * Reads all migration files from directory in alphabetical order.
 *
 * @param {string} [dir=DEFAULT_MIGRATIONS_DIR]
 * @returns {Array<{ name: string, fullPath: string, module: object }>}
 */
function getMigrationFiles(dir = DEFAULT_MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.js') && !file.startsWith('.'))
    .sort();

  return files.map((file) => {
    const fullPath = path.join(dir, file);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(fullPath);
    return { name: file, fullPath, module: mod };
  });
}

/**
 * Migration Engine for Admin Backend on Shared PostgreSQL Database.
 */
class Migrator {
  /**
   * @param {object} [options={}]
   * @param {import('pg').Pool} [options.dbPool=pool]
   * @param {string} [options.migrationsDir=DEFAULT_MIGRATIONS_DIR]
   */
  constructor(options = {}) {
    this.pool = options.dbPool || pool;
    this.migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  }

  /**
   * Creates a pgm runner wrapper for executing raw SQL.
   *
   * @param {import('pg').PoolClient} client
   */
  _createPgm(client) {
    return {
      sql: async (queryText) => {
        if (!queryText || typeof queryText !== 'string' || !queryText.trim()) {
          return;
        }
        await client.query(queryText);
      },
    };
  }

  /**
   * Runs all pending migrations in transaction-safe sequential order.
   *
   * @returns {Promise<string[]>} List of executed migration names
   */
  async up() {
    const client = await this.pool.connect();
    const executed = [];

    try {
      await ensureMigrationsTable(client);

      const res = await client.query('SELECT name FROM schema_migrations ORDER BY id ASC;');
      const appliedNames = new Set(res.rows.map((row) => row.name));

      const allMigrations = getMigrationFiles(this.migrationsDir);
      const pending = allMigrations.filter((m) => !appliedNames.has(m.name));

      if (pending.length === 0) {
        logger.info('Database schema is already up to date. No pending migrations.');
        return [];
      }

      logger.info(`Found ${pending.length} pending migration(s) to execute.`);

      /* eslint-disable no-restricted-syntax, no-await-in-loop */
      for (const m of pending) {
        const start = Date.now();
        logger.info(`Applying migration: ${m.name}...`);

        await client.query('BEGIN');
        try {
          const pgm = this._createPgm(client);
          await m.module.up(pgm);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1);', [m.name]);
          await client.query('COMMIT');

          const durationMs = Date.now() - start;
          logger.info(`Migration applied successfully: ${m.name} (${durationMs}ms)`);
          executed.push(m.name);
        } catch (err) {
          await client.query('ROLLBACK');
          logger.error(`Migration failed and rolled back: ${m.name}`, { error: err.message });
          throw new Error(`Migration ${m.name} failed: ${err.message}`);
        }
      }
      /* eslint-enable no-restricted-syntax, no-await-in-loop */

      return executed;
    } finally {
      client.release();
    }
  }

  /**
   * Rolls back the single most recently executed migration managed by this migrator.
   *
   * @returns {Promise<string|null>} Name of rolled back migration or null
   */
  async down() {
    const client = await this.pool.connect();

    try {
      await ensureMigrationsTable(client);

      const allMigrations = getMigrationFiles(this.migrationsDir);
      if (allMigrations.length === 0) {
        logger.info('No migration files available in configured migrations directory.');
        return null;
      }

      const fileNames = new Set(allMigrations.map((m) => m.name));

      // Find the last applied migration that belongs to our migrations directory
      const res = await client.query('SELECT name FROM schema_migrations ORDER BY id DESC;');
      const targetRow = res.rows.find((row) => fileNames.has(row.name));

      if (!targetRow) {
        logger.info('No migrations from this project are currently applied to rollback.');
        return null;
      }

      const targetMigrationName = targetRow.name;
      const target = allMigrations.find((m) => m.name === targetMigrationName);

      if (!target) {
        throw new Error(`Migration file not found for applied migration: ${targetMigrationName}`);
      }

      logger.info(`Rolling back migration: ${targetMigrationName}...`);

      await client.query('BEGIN');
      try {
        const pgm = this._createPgm(client);
        await target.module.down(pgm);
        await client.query('DELETE FROM schema_migrations WHERE name = $1;', [targetMigrationName]);
        await client.query('COMMIT');

        logger.info(`Rollback completed: ${targetMigrationName}`);
        return targetMigrationName;
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Rollback failed for ${targetMigrationName}`, { error: err.message });
        throw new Error(`Rollback for ${targetMigrationName} failed: ${err.message}`);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Returns status of all migrations (applied and pending).
   *
   * @returns {Promise<Array<{ name: string, applied: boolean, executedAt: string|null }>>}
   */
  async status() {
    const client = await this.pool.connect();

    try {
      await ensureMigrationsTable(client);

      const res = await client.query('SELECT name, executed_at FROM schema_migrations ORDER BY id ASC;');
      const appliedMap = new Map(res.rows.map((row) => [row.name, row.executed_at]));

      const allMigrations = getMigrationFiles(this.migrationsDir);

      const statusList = allMigrations.map((m) => ({
        name: m.name,
        applied: appliedMap.has(m.name),
        executedAt: appliedMap.get(m.name) || null,
      }));

      return statusList;
    } finally {
      client.release();
    }
  }

  /**
   * Creates a new template migration file in the migrations directory.
   *
   * @param {string} rawName Descriptive migration name
   * @returns {string} File path of newly created migration
   */
  create(rawName) {
    if (!rawName || typeof rawName !== 'string') {
      throw new Error('Migration name is required');
    }

    const sanitized = rawName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '');

    if (!fs.existsSync(this.migrationsDir)) {
      fs.mkdirSync(this.migrationsDir, { recursive: true });
    }

    const existingFiles = fs
      .readdirSync(this.migrationsDir)
      .filter((file) => file.endsWith('.js'))
      .sort();

    let nextSeq = 38;
    if (existingFiles.length > 0) {
      const lastFile = existingFiles[existingFiles.length - 1];
      const match = lastFile.match(/^(\d+)_/);
      if (match) {
        nextSeq = parseInt(match[1], 10) + 1;
      }
    }

    const prefix = String(nextSeq).padStart(3, '0');
    const filename = `${prefix}_${sanitized}.js`;
    const targetPath = path.join(this.migrationsDir, filename);

    const template = `'use strict';

/**
 * Migration: ${sanitized}
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(\`
    -- Write safe, additive DDL here
  \`);
};

exports.down = async (pgm) => {
  await pgm.sql(\`
    -- Write safe rollback DDL here
  \`);
};
`;

    fs.writeFileSync(targetPath, template, 'utf8');
    logger.info(`Created new migration: ${targetPath}`);
    return targetPath;
  }
}

// CLI Execution support
if (require.main === module) {
  const migrator = new Migrator();
  const command = process.argv[2] || 'status';
  const param = process.argv[3];

  (async () => {
    try {
      if (command === 'up') {
        const applied = await migrator.up();
        // eslint-disable-next-line no-console
        console.log(`Successfully applied ${applied.length} migration(s).`);
      } else if (command === 'down') {
        const reverted = await migrator.down();
        // eslint-disable-next-line no-console
        console.log(reverted ? `Successfully rolled back ${reverted}.` : 'No migration to rollback.');
      } else if (command === 'status') {
        const statuses = await migrator.status();
        // eslint-disable-next-line no-console
        console.log('Migration Status:');
        // eslint-disable-next-line no-console
        statuses.forEach((s) => console.log(`  [${s.applied ? 'APPLIED' : 'PENDING'}] ${s.name} ${s.executedAt ? `(${s.executedAt.toISOString ? s.executedAt.toISOString() : s.executedAt})` : ''}`));
      } else if (command === 'create') {
        if (!param) {
          throw new Error('Migration name is required. Usage: node src/db/migrator.js create <name>');
        }
        const createdPath = migrator.create(param);
        // eslint-disable-next-line no-console
        console.log(`Created migration: ${createdPath}`);
      } else {
        // eslint-disable-next-line no-console
        console.error(`Unknown command: ${command}. Available: up, down, status, create`);
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Migration error: ${err.message}`);
      process.exit(1);
    }
  })();
}

module.exports = {
  Migrator,
  ensureMigrationsTable,
  getMigrationFiles,
  DEFAULT_MIGRATIONS_DIR,
};
