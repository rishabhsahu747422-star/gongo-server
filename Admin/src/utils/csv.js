'use strict';

/**
 * Characters that trigger formula execution in spreadsheet software (Excel, Calc, Sheets).
 * Prepending a single quote prevents formula injection attacks.
 */
const FORMULA_INJECTION_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Tests whether a string is a standard numeric literal (e.g. -50, +42, 3.14).
 * Legitimate negative or positive numbers do not need formula escape quotes.
 */
const NUMERIC_LITERAL_REGEX = /^[+-]?\d+(\.\d+)?$/;

/**
 * Sanitizes a single cell value for CSV formatting, applying RFC 4180 quoting
 * and spreadsheet formula injection protection.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeCsvCell(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  let str;
  if (typeof value === 'object') {
    try {
      str = JSON.stringify(value);
    } catch (_) {
      str = '[Object]';
    }
  } else {
    str = String(value);
  }

  // Formula injection defense:
  // If the cell string begins with a formula trigger and is not purely a numeric literal,
  // prepend a single quote so spreadsheet engines interpret it strictly as text.
  if (str.length > 0 && FORMULA_INJECTION_PREFIXES.includes(str[0])) {
    if (!NUMERIC_LITERAL_REGEX.test(str.trim())) {
      str = `'${str}`;
    }
  }

  // RFC 4180 escaping:
  // If the string contains double quotes, commas, or line breaks,
  // escape double quotes as double double-quotes and enclose the entire cell in quotes.
  const needsQuoting = str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r');
  if (needsQuoting) {
    const escaped = str.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  return str;
}

/**
 * Generates an RFC 4180 compliant CSV string from an array of record objects
 * and column specifications.
 *
 * @param {object[]} rows
 * @param {Array<{ key: string, label: string }>} columns
 * @returns {string}
 */
function generateCsv(rows = [], columns = []) {
  if (!Array.isArray(columns) || columns.length === 0) {
    return '';
  }

  const headerRow = columns
    .map((col) => {
      const label = col.label || col.key;
      return sanitizeCsvCell(label);
    })
    .join(',');

  const dataRows = (rows || []).map((row) => columns
    .map((col) => {
      const val = row && typeof row === 'object' ? row[col.key] : '';
      return sanitizeCsvCell(val);
    })
    .join(','));

  return [headerRow, ...dataRows].join('\r\n');
}

module.exports = {
  FORMULA_INJECTION_PREFIXES,
  sanitizeCsvCell,
  generateCsv,
};
