'use strict';

/**
 * Canonical Admin Permission Catalog.
 *
 * Single source of truth for all granular permission strings.
 * Controllers, routes, services, and middleware MUST import from here.
 * Never scatter raw permission strings throughout the codebase.
 *
 * Naming convention: domain.action (lowercase, dot-separated)
 *
 * Derived from: docs/GONGO_ADMIN_BACKEND_API_ARCHITECTURE.md
 * Sections 5 (Auth & Authorization), 10-30 (Domain APIs), 28 (Admin Users & Roles)
 */

const PERMISSIONS = Object.freeze({
  // ── Super Admin (full access bypass) ──────────────────────────────────────
  SUPER_ADMIN: 'SUPER_ADMIN',

  // ── Dashboard (Section 10) ────────────────────────────────────────────────
  DASHBOARD_READ: 'dashboard.read',

  // ── Customer Management (Section 11) ──────────────────────────────────────
  CUSTOMERS_READ: 'customers.read',
  CUSTOMERS_UPDATE: 'customers.update',
  CUSTOMERS_SUSPEND: 'customers.suspend',

  // ── Partner Management (Section 12) ───────────────────────────────────────
  PARTNERS_READ: 'partners.read',
  PARTNERS_UPDATE: 'partners.update',
  PARTNERS_VERIFY: 'partners.verify',

  // ── Shop Management (Section 13) ──────────────────────────────────────────
  SHOPS_READ: 'shops.read',
  SHOPS_UPDATE: 'shops.update',

  // ── Vehicle Management (Section 14) ───────────────────────────────────────
  VEHICLES_READ: 'vehicles.read',
  VEHICLES_UPDATE: 'vehicles.update',
  VEHICLES_VERIFY: 'vehicles.verify',

  // ── KYC / Verification (Section 15) ───────────────────────────────────────
  KYC_READ: 'kyc.read',
  KYC_VERIFY: 'kyc.verify',
  KYC_REJECT: 'kyc.reject',

  // ── Booking Management (Section 16) ───────────────────────────────────────
  BOOKINGS_READ: 'bookings.read',
  BOOKINGS_UPDATE: 'bookings.update',
  BOOKINGS_CANCEL: 'bookings.cancel',

  // ── Payment Management (Section 17) ───────────────────────────────────────
  PAYMENTS_READ: 'payments.read',
  PAYMENTS_REFUND: 'payments.refund',

  // ── Refund Management (Section 18) ────────────────────────────────────────
  REFUNDS_READ: 'refunds.read',
  REFUNDS_APPROVE: 'refunds.approve',

  // ── Commission Management (Section 19) ────────────────────────────────────
  COMMISSIONS_READ: 'commissions.read',
  COMMISSIONS_UPDATE: 'commissions.update',

  // ── Payout Management (Section 20) ────────────────────────────────────────
  PAYOUTS_READ: 'payouts.read',
  PAYOUTS_APPROVE: 'payouts.approve',

  // ── Wallet / Financial Operations (Section 21) ────────────────────────────
  WALLETS_READ: 'wallets.read',

  // ── Damage Management (Phase 14) ──────────────────────────────────────────
  DAMAGES_READ: 'damages.read',
  DAMAGES_UPDATE: 'damages.update',

  // ── Support (Section 24) ──────────────────────────────────────────────────
  SUPPORT_READ: 'support.read',
  SUPPORT_UPDATE: 'support.update',

  // ── Disputes (Section 25) ─────────────────────────────────────────────────
  DISPUTES_READ: 'disputes.read',
  DISPUTES_RESOLVE: 'disputes.resolve',

  // ── Reviews (Section 26) ──────────────────────────────────────────────────
  REVIEWS_READ: 'reviews.read',
  REVIEWS_UPDATE: 'reviews.update',

  // ── Notifications (Section 27) ────────────────────────────────────────────
  NOTIFICATIONS_READ: 'notifications.read',
  NOTIFICATIONS_MANAGE: 'notifications.manage',
  NOTIFICATIONS_SEND: 'notifications.send',

  // ── Admin Users & Roles Management (Section 28) ───────────────────────────
  ADMIN_USERS_READ: 'admin.users.read',
  ADMIN_USERS_CREATE: 'admin.users.create',
  ADMIN_USERS_UPDATE: 'admin.users.update',
  ADMIN_USERS_DELETE: 'admin.users.delete',
  ADMIN_PERMISSIONS_MANAGE: 'admin.permissions.manage',

  // ── Audit Logs & Security (Section 29) ────────────────────────────────────
  AUDIT_READ: 'audit.read',
  AUDIT_SECURITY_READ: 'audit.security.read',

  // ── Storage & Document Operations (Phase 18) ──────────────────────────────
  STORAGE_READ: 'storage.read',
  STORAGE_DOCUMENTS_READ: 'storage.document.read',
  STORAGE_DOCUMENTS_ACCESS: 'storage.document.access',

  // ── Platform Settings (Section 30) ────────────────────────────────────────
  SETTINGS_READ: 'settings.read',
  SETTINGS_UPDATE: 'settings.update',

  // ── Franchise Applications ────────────────────────────────────────────────
  FRANCHISE_READ: 'franchise.read',
  FRANCHISE_UPDATE: 'franchise.update',

  // ── Platform Fee Settings ──────────────────────────────────────────────────
  PLATFORM_FEE_READ: 'platformfee.read',
  PLATFORM_FEE_UPDATE: 'platformfee.update',

  // ── Reports / Analytics ───────────────────────────────────────────────────
  REPORTS_READ: 'reports.read',
  REPORTS_EXPORT: 'reports.export',
  ANALYTICS_READ: 'analytics.read',
});

/**
 * Set of all valid permission values for validation.
 * Used by input validators to reject unknown/malicious permission strings.
 */
const VALID_PERMISSIONS = new Set(Object.values(PERMISSIONS));

/**
 * Permission groups that map the legacy architecture constants to granular permissions.
 * These represent broad access sets that can be assigned collectively.
 */
const PERMISSION_GROUPS = Object.freeze({
  SUPER_ADMIN: Object.values(PERMISSIONS),
  OPERATIONS_ADMIN: [
    PERMISSIONS.DASHBOARD_READ,
    PERMISSIONS.CUSTOMERS_READ,
    PERMISSIONS.CUSTOMERS_UPDATE,
    PERMISSIONS.PARTNERS_READ,
    PERMISSIONS.PARTNERS_UPDATE,
    PERMISSIONS.SHOPS_READ,
    PERMISSIONS.SHOPS_UPDATE,
    PERMISSIONS.VEHICLES_READ,
    PERMISSIONS.VEHICLES_UPDATE,
    PERMISSIONS.FRANCHISE_READ,
    PERMISSIONS.FRANCHISE_UPDATE,
    PERMISSIONS.BOOKINGS_READ,
    PERMISSIONS.BOOKINGS_UPDATE,
    PERMISSIONS.BOOKINGS_CANCEL,
    PERMISSIONS.DAMAGES_READ,
    PERMISSIONS.DAMAGES_UPDATE,
    PERMISSIONS.NOTIFICATIONS_READ,
    PERMISSIONS.NOTIFICATIONS_MANAGE,
    PERMISSIONS.NOTIFICATIONS_SEND,
    PERMISSIONS.STORAGE_READ,
    PERMISSIONS.STORAGE_DOCUMENTS_READ,
    PERMISSIONS.STORAGE_DOCUMENTS_ACCESS,
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.REPORTS_EXPORT,
  ],
  FINANCE_ADMIN: [
    PERMISSIONS.DASHBOARD_READ,
    PERMISSIONS.PAYMENTS_READ,
    PERMISSIONS.PAYMENTS_REFUND,
    PERMISSIONS.REFUNDS_READ,
    PERMISSIONS.REFUNDS_APPROVE,
    PERMISSIONS.COMMISSIONS_READ,
    PERMISSIONS.COMMISSIONS_UPDATE,
    PERMISSIONS.PAYOUTS_READ,
    PERMISSIONS.PAYOUTS_APPROVE,
    PERMISSIONS.WALLETS_READ,
    PERMISSIONS.PLATFORM_FEE_READ,
    PERMISSIONS.PLATFORM_FEE_UPDATE,
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.REPORTS_EXPORT,
  ],
  SUPPORT_ADMIN: [
    PERMISSIONS.DASHBOARD_READ,
    PERMISSIONS.CUSTOMERS_READ,
    PERMISSIONS.PARTNERS_READ,
    PERMISSIONS.BOOKINGS_READ,
    PERMISSIONS.SUPPORT_READ,
    PERMISSIONS.SUPPORT_UPDATE,
    PERMISSIONS.DISPUTES_READ,
    PERMISSIONS.DISPUTES_RESOLVE,
    PERMISSIONS.DAMAGES_READ,
    PERMISSIONS.DAMAGES_UPDATE,
    PERMISSIONS.REVIEWS_READ,
    PERMISSIONS.REVIEWS_UPDATE,
  ],
  VERIFICATION_ADMIN: [
    PERMISSIONS.DASHBOARD_READ,
    PERMISSIONS.PARTNERS_READ,
    PERMISSIONS.PARTNERS_VERIFY,
    PERMISSIONS.VEHICLES_READ,
    PERMISSIONS.VEHICLES_VERIFY,
    PERMISSIONS.KYC_READ,
    PERMISSIONS.KYC_VERIFY,
    PERMISSIONS.KYC_REJECT,
    PERMISSIONS.STORAGE_READ,
    PERMISSIONS.STORAGE_DOCUMENTS_READ,
    PERMISSIONS.STORAGE_DOCUMENTS_ACCESS,
  ],
});

module.exports = {
  PERMISSIONS,
  VALID_PERMISSIONS,
  PERMISSION_GROUPS,
};
