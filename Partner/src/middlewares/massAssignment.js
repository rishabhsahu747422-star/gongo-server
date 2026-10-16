'use strict';

const { PROTECTED_SERVER_FIELDS } = require('../constants/fields');
const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

/**
 * Finds any protected server-owned fields present in the input object.
 * Recursively scans nested objects if present.
 *
 * @param {object} obj Object to inspect
 * @param {string[]} [protectedFields=PROTECTED_SERVER_FIELDS] List of protected fields
 * @returns {string[]} Detected violation field names
 */
function detectProtectedFields(obj, protectedFields = PROTECTED_SERVER_FIELDS) {
  if (!obj || typeof obj !== 'object') {
    return [];
  }

  const detected = [];
  const normalizedProtected = new Set(protectedFields.map((f) => f.toLowerCase()));

  Object.keys(obj).forEach((key) => {
    const lowerKey = key.toLowerCase();
    if (normalizedProtected.has(lowerKey)) {
      detected.push(key);
    } else if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      const nested = detectProtectedFields(obj[key], protectedFields);
      nested.forEach((nKey) => detected.push(`${key}.${nKey}`));
    }
  });

  return detected;
}

/**
 * Middleware that strictly REJECTS requests containing server-owned fields.
 *
 * @param {string[]} [customProtectedFields] Optional custom field overrides
 * @returns {import('express').RequestHandler}
 */
function rejectMassAssignment(customProtectedFields = PROTECTED_SERVER_FIELDS) {
  return (req, res, next) => {
    if (!req.body || typeof req.body !== 'object') {
      return next();
    }

    const violations = detectProtectedFields(req.body, customProtectedFields);

    if (violations.length > 0) {
      return next(
        new ValidationError(
          `Mass assignment detected: Field(s) [${violations.join(', ')}] are server-controlled and cannot be set by client requests`,
          violations.map((field) => ({ field, message: 'Server-controlled field cannot be modified by client' })),
          ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
        ),
      );
    }

    next();
  };
}

/**
 * Strips protected server-owned fields in place from an object.
 *
 * @param {object} obj
 * @param {string[]} [protectedFields=PROTECTED_SERVER_FIELDS]
 * @returns {object} Clean copy
 */
function stripProtectedFields(obj, protectedFields = PROTECTED_SERVER_FIELDS) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const normalizedProtected = new Set(protectedFields.map((f) => f.toLowerCase()));
  const clean = {};

  Object.keys(obj).forEach((key) => {
    if (!normalizedProtected.has(key.toLowerCase())) {
      if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
        clean[key] = stripProtectedFields(obj[key], protectedFields);
      } else {
        clean[key] = obj[key];
      }
    }
  });

  return clean;
}

/**
 * DTO whitelist filter: retains ONLY allowed fields.
 *
 * @param {object} data
 * @param {string[]} allowedFields
 * @returns {object}
 */
function filterDto(data, allowedFields) {
  if (!data || typeof data !== 'object') {
    return {};
  }
  const result = {};
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      result[field] = data[field];
    }
  });
  return result;
}

module.exports = {
  detectProtectedFields,
  rejectMassAssignment,
  stripProtectedFields,
  filterDto,
};
