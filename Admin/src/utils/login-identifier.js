'use strict';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INDIAN_MOBILE_PATTERN = /^[6-9]\d{9}$/;

/**
 * Normalizes an email address the same way for storage and lookup (trimmed, lowercase).
 *
 * @param {string} email
 * @returns {string|null}
 */
function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) return null;
  return normalized;
}

/**
 * Normalizes an Indian mobile number to its 10-digit national form, which is how admin
 * phones are stored in users.phone (country code lives in users.country_code).
 * Accepts "8989232398", "08989232398", "+91 89892 32398", "91-8989232398".
 *
 * @param {string} phone
 * @returns {string|null}
 */
function normalizeMobile(phone) {
  if (typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (!/^\+?[\d\s\-()]{10,20}$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return INDIAN_MOBILE_PATTERN.test(digits) ? digits : null;
}

/**
 * Classifies and normalizes a login identifier (email or mobile number).
 *
 * @param {string} identifier
 * @returns {{ type: 'email'|'mobile', value: string }|null}
 */
function normalizeLoginIdentifier(identifier) {
  if (typeof identifier !== 'string') return null;
  const trimmed = identifier.trim();
  if (!trimmed || trimmed.length > 254) return null;

  if (trimmed.includes('@')) {
    const email = normalizeEmail(trimmed);
    return email ? { type: 'email', value: email } : null;
  }
  const mobile = normalizeMobile(trimmed);
  return mobile ? { type: 'mobile', value: mobile } : null;
}

module.exports = {
  normalizeEmail,
  normalizeMobile,
  normalizeLoginIdentifier,
};
