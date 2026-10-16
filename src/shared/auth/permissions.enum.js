'use strict';

/**
 * GONGO Centralized Permission Catalog.
 *
 * Single source of truth for all domain capabilities across Customer, Partner, and Admin.
 * Naming convention: domain:resource:action or domain.action
 */
const PERMISSIONS = Object.freeze({
  // ── Customer Domain ───────────────────────────────────────────────────────
  CUSTOMER_PROFILE_READ: 'customer:profile:read',
  CUSTOMER_PROFILE_UPDATE: 'customer:profile:update',
  CUSTOMER_ADDRESS_READ: 'customer:address:read',
  CUSTOMER_ADDRESS_MANAGE: 'customer:address:manage',
  CUSTOMER_DOCUMENT_UPLOAD: 'customer:document:upload',

  // ── Partner Domain ────────────────────────────────────────────────────────
  PARTNER_PROFILE_READ: 'partner:profile:read',
  PARTNER_PROFILE_UPDATE: 'partner:profile:update',
  PARTNER_KYC_SUBMIT: 'partner:kyc:submit',
  PARTNER_KYC_VERIFY: 'partner:kyc:verify',
  PARTNER_BANK_MANAGE: 'partner:bank:manage',
  PARTNER_EARNINGS_READ: 'partner:earnings:read',
  PARTNER_PAYOUT_REQUEST: 'partner:payout:request',
  PARTNER_PAYOUT_APPROVE: 'partner:payout:approve',

  // ── Vehicle Domain ────────────────────────────────────────────────────────
  VEHICLE_READ: 'vehicle:read',
  VEHICLE_CREATE: 'vehicle:create',
  VEHICLE_UPDATE: 'vehicle:update',
  VEHICLE_DELETE: 'vehicle:delete',
  VEHICLE_VERIFY: 'vehicle:verify',

  // ── Booking Domain ────────────────────────────────────────────────────────
  BOOKING_READ: 'booking:read',
  BOOKING_CREATE: 'booking:create',
  BOOKING_UPDATE: 'booking:update',
  BOOKING_CANCEL: 'booking:cancel',

  // ── Payment & Financial Domain ────────────────────────────────────────────
  PAYMENT_CREATE: 'payment:create',
  PAYMENT_VERIFY: 'payment:verify',
  PAYMENT_READ: 'payment:read',
  PAYMENT_REFUND: 'payment:refund',
  COMMISSION_MANAGE: 'commission:manage',
  PLATFORM_FEE_MANAGE: 'platform_fee:manage',

  // ── Admin Governance Domain ───────────────────────────────────────────────
  ADMIN_DASHBOARD_READ: 'admin:dashboard:read',
  ADMIN_USERS_MANAGE: 'admin:users:manage',
  ADMIN_AUDIT_READ: 'admin:audit:read',
  ADMIN_SETTINGS_MANAGE: 'admin:settings:manage',
  ADMIN_DISPUTES_RESOLVE: 'admin:disputes:resolve',
  ADMIN_SUPPORT_MANAGE: 'admin:support:manage',
  ADMIN_NOTIFICATIONS_SEND: 'admin:notifications:send',
});

const PERMISSION_VALUES = new Set(Object.values(PERMISSIONS));

/**
 * Validates whether a given string is a valid permission string.
 *
 * @param {string} perm
 * @returns {boolean}
 */
function isPermissionValid(perm) {
  if (!perm || typeof perm !== 'string') return false;
  return PERMISSION_VALUES.has(perm.trim());
}

module.exports = {
  PERMISSIONS,
  PERMISSION_VALUES,
  isPermissionValid,
};
