'use strict';

const { validate: uuidValidate } = require('uuid');
const { ValidationError } = require('../errors');

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Safely extracts only explicitly allowed fields from an input object.
 * Protects against mass-assignment and prototype pollution vulnerabilities.
 *
 * @param {object} input Raw input object
 * @param {string[]} allowedFields Allowlist of field names
 * @returns {object} Clean object with only allowed properties
 */
function pickAllowed(input, allowedFields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const allowedSet = new Set(allowedFields);
  const result = {};

  Object.keys(input).forEach((key) => {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      return;
    }
    if (allowedSet.has(key) && input[key] !== undefined) {
      result[key] = input[key];
    }
  });

  return result;
}

const UUID_FORMAT_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates whether a value is a valid UUID.
 *
 * @param {*} val
 * @returns {boolean}
 */
function isValidUUID(val) {
  if (typeof val !== 'string' || !val.trim()) {
    return false;
  }
  const trimmed = val.trim();
  return uuidValidate(trimmed) || UUID_FORMAT_REGEX.test(trimmed);
}

/**
 * Validates whether a value belongs to an enum set.
 *
 * @param {*} val
 * @param {Array|Set} allowedValues
 * @returns {boolean}
 */
function isValidEnum(val, allowedValues) {
  const set = allowedValues instanceof Set ? allowedValues : new Set(allowedValues);
  return set.has(val);
}

/**
 * Validates whether a value is a valid ISO 8601 date string.
 *
 * @param {*} val
 * @returns {boolean}
 */
function isValidDate(val) {
  if (typeof val !== 'string' || !val.trim()) {
    return false;
  }
  const timestamp = Date.parse(val);
  return !Number.isNaN(timestamp);
}

/**
 * Validates and sanitizes standard pagination parameters.
 *
 * @param {object} query Request query object
 * @param {object} [options={}]
 * @param {number} [options.defaultPage=1]
 * @param {number} [options.defaultLimit=20]
 * @param {number} [options.maxLimit=100]
 * @returns {{ isValid: boolean, errors?: object, page?: number, limit?: number, offset?: number }}
 */
function validatePagination(query = {}, options = {}) {
  const defaultPage = options.defaultPage || 1;
  const defaultLimit = options.defaultLimit || 20;
  const maxLimit = options.maxLimit || 100;
  const errors = {};

  let page = defaultPage;
  if (query.page !== undefined) {
    const parsedPage = Number(query.page);
    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      errors.page = 'Page must be an integer greater than or equal to 1';
    } else {
      page = parsedPage;
    }
  }

  let limit = defaultLimit;
  if (query.limit !== undefined) {
    const parsedLimit = Number(query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      errors.limit = 'Limit must be an integer greater than or equal to 1';
    } else if (parsedLimit > maxLimit) {
      errors.limit = `Limit cannot exceed ${maxLimit}`;
    } else {
      limit = parsedLimit;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { isValid: false, errors };
  }

  const offset = (page - 1) * limit;
  return {
    isValid: true,
    page,
    limit,
    offset,
  };
}

/**
 * Schema-based request validator middleware factory with strict mass-assignment prevention.
 *
 * @param {object} schema Object describing fields, types, constraints
 * @param {object} [options={}]
 * @param {'body'|'query'|'params'} [options.target='body']
 * @param {boolean} [options.allowUnknown=false] If false, rejects requests containing extra fields
 * @returns {import('express').RequestHandler}
 */
function validateSchema(schema, options = {}) {
  const target = options.target || 'body';
  const allowUnknown = options.allowUnknown || false;
  const allowedKeys = Object.keys(schema);

  return (req, res, next) => {
    const input = req[target] || {};

    if (typeof input !== 'object' || Array.isArray(input)) {
      return next(new ValidationError(`Request ${target} must be a valid JSON object`));
    }

    const errors = {};
    const inputKeys = Object.keys(input);

    // Reject prototype pollution keys
    const hasForbiddenKey = inputKeys.some((k) => FORBIDDEN_OBJECT_KEYS.has(k));
    if (hasForbiddenKey) {
      return next(new ValidationError('Dangerous payload structure detected'));
    }

    // Strict schema enforcement: reject unexpected keys
    if (!allowUnknown) {
      const unknownKeys = inputKeys.filter((k) => !allowedKeys.includes(k));
      if (unknownKeys.length > 0) {
        return next(
          new ValidationError(
            `Unexpected fields in request ${target}: ${unknownKeys.join(', ')}`,
            { unknownFields: unknownKeys },
          ),
        );
      }
    }

    const sanitized = {};

    allowedKeys.forEach((field) => {
      const rules = schema[field];
      const val = input[field];

      if (val === undefined || val === null || val === '') {
        if (rules.required) {
          errors[field] = `${field} is required`;
        }
        return;
      }

      // Type validations
      if (rules.type === 'uuid') {
        if (!isValidUUID(val)) {
          errors[field] = `${field} must be a valid UUID`;
          return;
        }
      } else if (rules.type === 'enum') {
        if (!isValidEnum(val, rules.values || [])) {
          errors[field] = `${field} must be one of: ${(rules.values || []).join(', ')}`;
          return;
        }
      } else if (rules.type === 'date') {
        if (!isValidDate(val)) {
          errors[field] = `${field} must be a valid ISO 8601 date`;
          return;
        }
      } else if (rules.type === 'string') {
        if (typeof val !== 'string') {
          errors[field] = `${field} must be a string`;
          return;
        }
        if (rules.maxLength && val.length > rules.maxLength) {
          errors[field] = `${field} cannot exceed ${rules.maxLength} characters`;
          return;
        }
        if (rules.minLength && val.length < rules.minLength) {
          errors[field] = `${field} must be at least ${rules.minLength} characters`;
          return;
        }
        if (rules.pattern && !rules.pattern.test(val)) {
          errors[field] = rules.patternMessage || `${field} is invalid`;
          return;
        }
      } else if (rules.type === 'number' || rules.type === 'integer') {
        const num = Number(val);
        if (Number.isNaN(num) || (rules.type === 'integer' && !Number.isInteger(num))) {
          errors[field] = `${field} must be a valid ${rules.type}`;
          return;
        }
        if (rules.min !== undefined && num < rules.min) {
          errors[field] = `${field} must be at least ${rules.min}`;
          return;
        }
        if (rules.max !== undefined && num > rules.max) {
          errors[field] = `${field} cannot exceed ${rules.max}`;
          return;
        }
      } else if (rules.type === 'boolean') {
        if (typeof val !== 'boolean') {
          errors[field] = `${field} must be a boolean`;
          return;
        }
      }

      // Custom validator function
      if (typeof rules.validator === 'function') {
        const customRes = rules.validator(val);
        if (customRes !== true) {
          errors[field] = typeof customRes === 'string' ? customRes : `${field} is invalid`;
          return;
        }
      }

      sanitized[field] = val;
    });

    if (Object.keys(errors).length > 0) {
      return next(new ValidationError('Request validation failed', errors));
    }

    // Attach mass-assignment protected clean data
    req[target] = sanitized;
    req.cleanData = { ...(req.cleanData || {}), ...sanitized };

    return next();
  };
}

/**
 * Validates request object using a custom validation function.
 *
 * @param {Function} validateFn Validation function returning { isValid, errors, sanitized? }
 * @param {'body'|'query'|'params'} [target='body']
 * @returns {import('express').RequestHandler}
 */
function validate(validateFn, target = 'body') {
  return (req, res, next) => {
    const result = validateFn(req[target] || {});
    if (!result.isValid) {
      return next(new ValidationError('Request validation failed', result.errors));
    }
    if (result.sanitized && typeof result.sanitized === 'object') {
      req[target] = result.sanitized;
    }
    return next();
  };
}

module.exports = {
  validate,
  validateSchema,
  pickAllowed,
  isValidUUID,
  isValidEnum,
  isValidDate,
  validatePagination,
};
