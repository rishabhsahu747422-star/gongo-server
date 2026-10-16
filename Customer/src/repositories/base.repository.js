'use strict';

const { query, transaction, pool } = require('../config/database');
const {
  ConflictError,
  BadRequestError,
  UnprocessableEntityError,
} = require('../errors');

/**
 * Base repository providing database access, parameterized query execution,
 * transaction coordination, and PostgreSQL error mapping.
 *
 * Controllers and business services must NEVER write raw SQL queries.
 * All SQL statements must be encapsulated within repository classes.
 */
class BaseRepository {
  constructor() {
    this.pool = pool;
  }

  /**
   * Executes a parameterized query via the database pool.
   *
   * @param {string} text - SQL query with positional parameters ($1, $2, etc.)
   * @param {Array<any>} [params] - Bound parameters
   * @returns {Promise<import('pg').QueryResult>}
   */
  async query(text, params = []) {
    try {
      return await query(text, params);
    } catch (err) {
      throw this.handleDatabaseError(err);
    }
  }

  /**
   * Executes a callback within a managed transaction (BEGIN, COMMIT, ROLLBACK).
   *
   * @template T
   * @param {(client: import('pg').PoolClient) => Promise<T>} callback
   * @returns {Promise<T>}
   */
  async transaction(callback) {
    try {
      return await transaction(callback);
    } catch (err) {
      throw this.handleDatabaseError(err);
    }
  }

  /**
   * Maps database-level constraint violations to safe, client-facing AppErrors.
   * Internal details (table names, column names, schema internals) are never leaked.
   *
   * @param {Error} err - Raw database error
   * @returns {Error} Safe AppError or original error
   */
  handleDatabaseError(err) {
    const code = err.code || '';
    const msg = err.message || '';

    // Unique constraint violation (PostgreSQL 23505)
    if (code === '23505' || /unique/i.test(msg)) {
      return new ConflictError('A record with the provided information already exists', 'DUPLICATE_RESOURCE');
    }

    // Check constraint violation (PostgreSQL 23514)
    if (code === '23514' || /check constraint/i.test(msg)) {
      return new BadRequestError('The provided data violates data integrity constraints', 'CONSTRAINT_VIOLATION');
    }

    // Not-null constraint violation (PostgreSQL 23502)
    if (code === '23502' || /not-null/i.test(msg)) {
      return new UnprocessableEntityError('A required field was omitted or null', 'MISSING_REQUIRED_FIELD');
    }

    // Invalid text representation (PostgreSQL 22P02)
    if (code === '22P02' || /invalid input syntax/i.test(msg)) {
      return new BadRequestError('Invalid format for one or more parameters', 'INVALID_PARAMETER_FORMAT');
    }

    // Foreign key violation (PostgreSQL 23503)
    if (code === '23503' || /foreign key/i.test(msg)) {
      return new ConflictError('Referenced resource does not exist', 'FOREIGN_KEY_VIOLATION');
    }

    // Exclusion constraint violation (PostgreSQL 23P01)
    if (code === '23P01' || /exclusion|no_overlapping_blocking_bookings/i.test(msg)) {
      return new ConflictError('Vehicle is unavailable for the selected dates/times', 'BOOKING_VEHICLE_UNAVAILABLE');
    }

    return err;
  }
}

module.exports = BaseRepository;
