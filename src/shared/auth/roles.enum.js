'use strict';

/**
 * GONGO Centralized Role Catalog.
 *
 * Single source of truth for canonical application roles.
 * Supports legacy lowercase role strings via normalizeRole().
 */
const ROLES = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  PARTNER: 'PARTNER',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
  SUPPORT_EXECUTIVE: 'SUPPORT_EXECUTIVE',
});

const ROLE_VALUES = new Set(Object.values(ROLES));

/**
 * Normalizes any role input (case-insensitive, trimmed) to canonical uppercase enum.
 *
 * @param {string} role
 * @returns {string|null} Canonical role or null if invalid
 */
function normalizeRole(role) {
  if (!role || typeof role !== 'string') return null;
  const upper = role.trim().toUpperCase();
  return ROLE_VALUES.has(upper) ? upper : null;
}

/**
 * Validates whether a given string is a valid canonical role.
 *
 * @param {string} role
 * @returns {boolean}
 */
function isRoleValid(role) {
  if (!role || typeof role !== 'string') return false;
  return ROLE_VALUES.has(role.trim().toUpperCase());
}

module.exports = {
  ROLES,
  ROLE_VALUES,
  normalizeRole,
  isRoleValid,
};
