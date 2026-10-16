'use strict';

const { BadRequestError } = require('../errors');

/**
 * Strict allowlist of fields that a customer is permitted to update.
 * Any field not in this set triggers immediate validation failure.
 */
const ALLOWED_PROFILE_UPDATE_FIELDS = new Set(['name', 'email']);

/**
 * Name regex: Alphabetic characters, spaces, hyphens, periods, and apostrophes.
 * Length constraint: 2 to 100 characters.
 */
const NAME_REGEX = /^[a-zA-Z\s\-'.]{2,100}$/;

/**
 * Standard RFC 5322 compatible email regex for web form validation.
 */
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/**
 * Middleware validating customer profile update payload (PATCH /api/v1/customers/me).
 *
 * Enforces:
 * 1. Request body must be a non-empty object.
 * 2. Strict allowlisting: Any unknown/disallowed fields are explicitly rejected.
 * 3. At least one allowed field must be provided.
 * 4. Format and type validation for 'name' and 'email'.
 * 5. In-place normalization (trimming and lowercasing).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validateUpdateProfile(req, res, next) {
  const { body } = req;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(
      new BadRequestError(
        'Request body must be a valid JSON object',
        'VALIDATION_ERROR',
      ),
    );
  }

  const providedKeys = Object.keys(body);

  if (providedKeys.length === 0) {
    return next(
      new BadRequestError(
        'At least one field (name or email) must be provided for update',
        'INVALID_UPDATE_PAYLOAD',
      ),
    );
  }

  // 1. Reject unknown or forbidden fields (prevent mass-assignment)
  const unexpectedKeys = providedKeys.filter((k) => !ALLOWED_PROFILE_UPDATE_FIELDS.has(k));
  if (unexpectedKeys.length > 0) {
    return next(
      new BadRequestError(
        `Unexpected field(s) in update payload: ${unexpectedKeys.join(', ')}`,
        'VALIDATION_ERROR',
      ),
    );
  }

  // 2. Validate 'name' if present
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const rawName = body.name;

    if (typeof rawName !== 'string') {
      return next(
        new BadRequestError('Name must be a string', 'VALIDATION_ERROR'),
      );
    }

    const trimmedName = rawName.trim();
    if (trimmedName.length < 2 || trimmedName.length > 100 || !NAME_REGEX.test(trimmedName)) {
      return next(
        new BadRequestError(
          'Name must be between 2 and 100 characters and contain only letters, spaces, hyphens, or dots',
          'VALIDATION_ERROR',
        ),
      );
    }

    req.body.name = trimmedName;
  }

  // 3. Validate 'email' if present
  if (Object.prototype.hasOwnProperty.call(body, 'email')) {
    const rawEmail = body.email;

    if (typeof rawEmail !== 'string') {
      return next(
        new BadRequestError('Email must be a string', 'VALIDATION_ERROR'),
      );
    }

    const trimmedEmail = rawEmail.trim().toLowerCase();
    if (trimmedEmail.length === 0 || trimmedEmail.length > 255 || !EMAIL_REGEX.test(trimmedEmail)) {
      return next(
        new BadRequestError(
          'Email must be a valid email address',
          'VALIDATION_ERROR',
        ),
      );
    }

    req.body.email = trimmedEmail;
  }

  next();
}

module.exports = {
  validateUpdateProfile,
  ALLOWED_PROFILE_UPDATE_FIELDS,
};
