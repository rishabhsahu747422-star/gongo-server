'use strict';

/**
 * Money utility providing exact 2-decimal rounded monetary operations,
 * avoiding JavaScript IEEE 754 floating-point precision issues.
 *
 * Compatible with PostgreSQL NUMERIC(12,2).
 */

/**
 * Rounds a number to exactly 2 decimal places.
 *
 * @param {number|string} amount
 * @returns {number}
 */
function roundMoney(amount) {
  const num = Number(amount || 0);
  if (Number.isNaN(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

/**
 * Clamps monetary amount to non-negative 2-decimal number.
 *
 * @param {number|string} amount
 * @returns {number}
 */
function clampMoney(amount) {
  return Math.max(0, roundMoney(amount));
}

/**
 * Formats a money value to a fixed 2-decimal string.
 *
 * @param {number|string} amount
 * @returns {string}
 */
function formatMoney(amount) {
  return clampMoney(amount).toFixed(2);
}

module.exports = {
  roundMoney,
  clampMoney,
  formatMoney,
};
