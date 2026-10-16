'use strict';

/**
 * AppError — base class for all application-level errors.
 *
 * Design decisions:
 * - `isOperational`: true  → Known, expected error (bad input, not found).
 *                            Safe to send a client-facing message.
 *                            The process continues.
 *   `isOperational`: false → Programmer error or unexpected failure.
 *                            Generic "Internal Server Error" is sent to client.
 *                            The process should restart (handled in server.js).
 *
 * - `code`: Machine-readable string for client-side error handling
 *           (e.g. "NOT_FOUND", "VALIDATION_ERROR"). Never expose internals.
 *
 * - Never attach raw SQL errors, file paths, or stack frames to this object
 *   for client consumption — the error handler strips them in production.
 */
class AppError extends Error {
  /**
   * @param {string} message - Safe, human-readable message for the client.
   * @param {number} statusCode - HTTP status code.
   * @param {string} code - Machine-readable error code.
   * @param {boolean} [isOperational=true] - Whether this is a known, expected error.
   */
  constructor(message, statusCode, code, isOperational = true) {
    super(message);

    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    // Capture stack trace (omits the AppError constructor frame)
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
