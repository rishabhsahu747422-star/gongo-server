'use strict';

const pool = require('./pool');
const { ConflictError, NotFoundError } = require('../errors');

class BaseRepository {
  /**
   * @param {string} tableName Database table name
   * @param {string} [primaryKey='id'] Primary key column name
   */
  constructor(tableName, primaryKey = 'id') {
    this.tableName = tableName;
    this.primaryKey = primaryKey;
  }

  /**
   * Safe parameterized query executor.
   */
  async query(text, params = []) {
    return pool.query(text, params);
  }

  /**
   * Transaction executor.
   */
  async withTransaction(callback) {
    return pool.transaction(callback);
  }

  /**
   * Finds a single record by primary key.
   */
  async findById(id, client = null) {
    const text = `SELECT * FROM ${this.tableName} WHERE ${this.primaryKey} = $1 LIMIT 1`;
    const res = client ? await client.query(text, [id]) : await this.query(text, [id]);
    return res.rows[0] || null;
  }

  /**
   * Finds a single record by arbitrary column key-value.
   */
  async findOneBy(column, value, client = null) {
    const text = `SELECT * FROM ${this.tableName} WHERE ${column} = $1 LIMIT 1`;
    const res = client ? await client.query(text, [value]) : await this.query(text, [value]);
    return res.rows[0] || null;
  }

  /**
   * Normalizes known Postgres errors into application errors.
   */
  handleDbError(err, context = 'Database operation') {
    if (err.code === '23505') {
      throw new ConflictError(`${context}: A record with the provided unique field already exists`);
    }
    if (err.code === '23503') {
      throw new NotFoundError(`${context}: Referenced record does not exist`);
    }
    throw err;
  }
}

module.exports = BaseRepository;
