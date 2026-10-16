'use strict';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates whether a string is a valid UUID format.
 * @param {string} value
 * @returns {boolean}
 */
function isValidUuid(value) {
  if (typeof value !== 'string') return false;
  return UUID_REGEX.test(value);
}

/**
 * Validates non-empty string.
 * @param {*} value
 * @param {number} [min=1]
 * @param {number} [max=255]
 * @returns {boolean}
 */
function isNonEmptyString(value, min = 1, max = 255) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max;
}

/**
 * Validates value is one of allowed enum values.
 * @param {*} value
 * @param {Array<string>} allowedValues
 * @returns {boolean}
 */
function isValidEnum(value, allowedValues) {
  return allowedValues.includes(value);
}

module.exports = {
  isValidUuid,
  isNonEmptyString,
  isValidEnum,
};
