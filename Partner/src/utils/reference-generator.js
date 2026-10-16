'use strict';

const crypto = require('crypto');

/**
 * Unambiguous character set for GOnGO Public Reference IDs:
 * Digits 2-9 (8 digits, strictly excluding 0 and 1)
 * Letters A-Z strictly excluding ambiguous letters O, I, L (23 letters)
 * Total: 31 characters
 */
const CHARSET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Standard entity prefixes
 */
const PREFIXES = Object.freeze({
  BOOKING: 'BK',
  CUSTOMER: 'CUS',
  PARTNER: 'PTR',
  VEHICLE: 'VEH',
  ORDER: 'ORD',
  REFUND: 'REF',
  SUPPORT: 'TKT',
});

/**
 * Generates an independent, cryptographically secure short reference string.
 * Format: <PREFIX>-<RANDOM_CODE> (e.g., BK-7F3K92, CUS-4K82P9, ORD-8M42Q6)
 *
 * @param {string} prefix - Entity prefix (e.g. 'BK', 'CUS', 'PTR', 'VEH', 'ORD', 'REF')
 * @param {number} [length=6] - Number of random alphanumeric characters (default: 6)
 * @returns {string} Public reference ID
 */
function generateReferenceCode(prefix, length = 6) {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('A valid string prefix is required for public reference generation');
  }

  const cleanPrefix = prefix.trim().toUpperCase();
  const codeLength = Math.max(5, Math.min(10, parseInt(length, 10) || 6));

  let randomCode = '';
  for (let i = 0; i < codeLength; i++) {
    const randomIndex = crypto.randomInt(0, CHARSET.length);
    randomCode += CHARSET[randomIndex];
  }

  return `${cleanPrefix}-${randomCode}`;
}

/**
 * Validates whether a given string is a valid public reference ID.
 *
 * @param {string} reference
 * @param {string} [expectedPrefix]
 * @returns {boolean}
 */
function isValidReference(reference, expectedPrefix = null) {
  if (!reference || typeof reference !== 'string') return false;
  const clean = reference.trim().toUpperCase();

  const pattern = /^[A-Z]{2,4}-[2-9A-HJ-NP-Z]{5,10}$/;
  if (!pattern.test(clean)) return false;

  if (expectedPrefix) {
    const prefix = expectedPrefix.trim().toUpperCase();
    return clean.startsWith(`${prefix}-`);
  }

  return true;
}

/**
 * Generates a guaranteed-unique reference by querying the database for collisions.
 *
 * @param {object|Function} dbExecutor - Client, pool, or query function with .query(sql, params)
 * @param {string} tableName - PostgreSQL table name
 * @param {string} columnName - Reference column name (e.g. 'booking_reference')
 * @param {string} prefix - Entity prefix (e.g. 'BK')
 * @param {number} [length=6] - Random code length
 * @param {number} [maxRetries=10] - Maximum collision retry attempts
 * @returns {Promise<string>} Unique public reference
 */
async function generateUniqueEntityReference(
  dbExecutor,
  tableName,
  columnName,
  prefix,
  length = 6,
  maxRetries = 10,
) {
  const queryFn = typeof dbExecutor.query === 'function'
    ? (text, params) => dbExecutor.query(text, params)
    : (text, params) => dbExecutor(text, params);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const candidate = generateReferenceCode(prefix, length);
    const sql = `SELECT 1 FROM "${tableName}" WHERE "${columnName}" = $1 LIMIT 1;`;
    const res = await queryFn(sql, [candidate]);

    if (res.rows && res.rows.length === 0) {
      return candidate;
    }
  }

  throw new Error(
    `Failed to generate unique public reference for ${tableName}.${columnName} with prefix ${prefix} after ${maxRetries} attempts`,
  );
}

module.exports = {
  CHARSET,
  PREFIXES,
  generateReferenceCode,
  isValidReference,
  generateUniqueEntityReference,
};
