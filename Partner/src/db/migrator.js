'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');
const logger = require('../config/logger');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../database/migrations');

/**
 * Ensures the migration tracking table exists.
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
 * Reads all migration files in alphabetical order.
 *
 * @returns {Array<{ name: string, fullPath: string, module: object }>}
 */
function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.js') && !file.startsWith('.'))
    .sort();

  return files.map((file) => {
    const fullPath = path.join(MIGRATIONS_DIR, file);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(fullPath);
    return { name: file, fullPath, module: mod };
  });
}

/**
 * Migration Engine for PostgreSQL.
 */
class Migrator {
  /**
   * @param {import('pg').Pool} [dbPool=pool]
   */
  constructor(dbPool = pool) {
    this.pool = dbPool;
  }

  /**
   * Creates a pgm runner wrapper for a client.
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

      const allMigrations = getMigrationFiles();
      const pending = allMigrations.filter((m) => !appliedNames.has(m.name));

      if (pending.length === 0) {
        logger.info('Database is already up to date. No pending migrations.');
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
   * Rolls back the single most recently executed migration.
   *
   * @returns {Promise<string|null>} Name of rolled back migration or null
   */
  async down() {
    const client = await this.pool.connect();

    try {
      await ensureMigrationsTable(client);

      const res = await client.query('SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1;');
      if (res.rows.length === 0) {
        logger.info('No migrations to rollback.');
        return null;
      }

      const lastMigrationName = res.rows[0].name;
      const allMigrations = getMigrationFiles();
      const target = allMigrations.find((m) => m.name === lastMigrationName);

      if (!target) {
        throw new Error(`Migration file not found for applied migration: ${lastMigrationName}`);
      }

      logger.info(`Rolling back migration: ${lastMigrationName}...`);

      await client.query('BEGIN');
      try {
        const pgm = this._createPgm(client);
        await target.module.down(pgm);
        await client.query('DELETE FROM schema_migrations WHERE name = $1;', [lastMigrationName]);
        await client.query('COMMIT');

        logger.info(`Rollback completed: ${lastMigrationName}`);
        return lastMigrationName;
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Rollback failed for ${lastMigrationName}`, { error: err.message });
        throw new Error(`Rollback for ${lastMigrationName} failed: ${err.message}`);
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

      const allMigrations = getMigrationFiles();

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
}

// CLI Execution support
if (require.main === module) {
  const migrator = new Migrator();
  const command = process.argv[2] || 'status';

  (async () => {
    try {
      if (command === 'up') {
        const applied = await migrator.up();
        // eslint-disable-next-line no-console
        console.log(`Successfully applied ${applied.length} migration(s).`);
      } else if (command === 'down' || command === 'rollback') {
        const rolledBack = await migrator.down();
        // eslint-disable-next-line no-console
        console.log(rolledBack ? `Rolled back: ${rolledBack}` : 'No migration to roll back.');
      } else if (command === 'status') {
        const list = await migrator.status();
        // eslint-disable-next-line no-console
        console.table(list);
      } else {
        // eslint-disable-next-line no-console
        console.error(`Unknown command: ${command}. Use 'up', 'down', or 'status'.`);
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Migration error:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  Migrator,
  getMigrationFiles,
};
