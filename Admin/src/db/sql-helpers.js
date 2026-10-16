'use strict';

/**
 * Validates a PostgreSQL identifier (table name, column name).
 * Rejects any character that is not alphanumeric or underscore.
 *
 * @param {string} identifier
 * @returns {string} Sanitized identifier
 */
function validateIdentifier(identifier) {
  if (typeof identifier !== 'string' || !identifier) {
    throw new Error('Database identifier must be a non-empty string');
  }

  const trimmed = identifier.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid database identifier '${identifier}'. Only alphanumeric characters and underscores are allowed.`);
  }

  return trimmed;
}

/**
 * Safely builds an ORDER BY SQL clause against an explicit column allowlist.
 * Guarantees zero SQL injection in dynamic sorting.
 *
 * @param {string[]} allowedColumns List of allowed column names
 * @param {string} [requestedColumn] Column requested by client
 * @param {'ASC'|'DESC'|string} [requestedDirection='DESC'] Sort direction
 * @param {string} [defaultColumn='created_at'] Default column if requested column is invalid
 * @param {'ASC'|'DESC'} [defaultDirection='DESC'] Default direction
 * @returns {string} Safe SQL clause, e.g. `ORDER BY "created_at" DESC`
 */
function safeOrderBy(
  allowedColumns,
  requestedColumn,
  requestedDirection = 'DESC',
  defaultColumn = 'created_at',
  defaultDirection = 'DESC',
) {
  const allowedSet = new Set(allowedColumns);

  let column = defaultColumn;
  if (requestedColumn && allowedSet.has(requestedColumn)) {
    column = requestedColumn;
  }

  // Ensure default column is also a valid identifier
  validateIdentifier(column);

  let direction = defaultDirection.toUpperCase();
  if (requestedDirection) {
    const dirUpper = String(requestedDirection).trim().toUpperCase();
    if (dirUpper === 'ASC' || dirUpper === 'DESC') {
      direction = dirUpper;
    }
  }

  return `ORDER BY "${column}" ${direction}`;
}

/**
 * Validates and bounds pagination limits and offsets.
 *
 * @param {*} limit Requested limit
 * @param {*} offset Requested offset
 * @param {object} [options={}]
 * @param {number} [options.defaultLimit=20]
 * @param {number} [options.maxLimit=100]
 * @returns {{ limit: number, offset: number }}
 */
function safePagination(limit, offset, options = {}) {
  const defaultLimit = options.defaultLimit || 20;
  const maxLimit = options.maxLimit || 100;

  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);

  const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, maxLimit)
    : defaultLimit;

  const safeOffset = Number.isInteger(parsedOffset) && parsedOffset >= 0
    ? parsedOffset
    : 0;

  return { limit: safeLimit, offset: safeOffset };
}

/**
 * Safely appends a parameterized WHERE condition to arrays.
 *
 * @param {string[]} conditionsArray Array of WHERE conditions
 * @param {any[]} valuesArray Array of parameterized query values
 * @param {string} column Column name (validated)
 * @param {string} operator SQL comparison operator
 *   ('=', '!=', '>', '<', '>=', '<=', 'LIKE', 'ILIKE')
 * @param {*} value Filter value
 */
function appendFilter(conditionsArray, valuesArray, column, operator, value) {
  if (value === undefined || value === null) {
    return;
  }

  const validCol = validateIdentifier(column);
  const allowedOps = new Set(['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'ILIKE']);
  if (!allowedOps.has(operator)) {
    throw new Error(`Unsupported SQL operator '${operator}'`);
  }

  valuesArray.push(value);
  const paramIndex = valuesArray.length;
  conditionsArray.push(`"${validCol}" ${operator} $${paramIndex}`);
}

/**
 * Safely escapes characters in user search input for SQL LIKE/ILIKE patterns.
 * Prevents wildcard injection via % or _ characters.
 *
 * @param {string} str
 * @returns {string} Escaped string
 */
function escapeLikeString(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[%_\\]/g, '\\$&');
}

module.exports = {
  validateIdentifier,
  safeOrderBy,
  safePagination,
  appendFilter,
  escapeLikeString,
};
