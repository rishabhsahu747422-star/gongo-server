'use strict';

const {
  ROLES,
  normalizeRole,
  isRoleValid,
  PERMISSIONS,
  isPermissionValid,
  roleHasPermission,
  getPermissionsForRole,
} = require('../../src/shared/auth');

describe('Unified Centralized Roles and Permissions Catalog', () => {
  describe('Roles Enum & Normalization', () => {
    it('should define all canonical roles', () => {
      expect(ROLES.CUSTOMER).toBe('CUSTOMER');
      expect(ROLES.PARTNER).toBe('PARTNER');
      expect(ROLES.ADMIN).toBe('ADMIN');
      expect(ROLES.SUPER_ADMIN).toBe('SUPER_ADMIN');
      expect(ROLES.SUPPORT_EXECUTIVE).toBe('SUPPORT_EXECUTIVE');
    });

    it('should validate canonical roles correctly', () => {
      expect(isRoleValid('CUSTOMER')).toBe(true);
      expect(isRoleValid('customer')).toBe(true);
      expect(isRoleValid('partner')).toBe(true);
      expect(isRoleValid('admin')).toBe(true);
      expect(isRoleValid('INVALID_ROLE')).toBe(false);
      expect(isRoleValid('')).toBe(false);
      expect(isRoleValid(null)).toBe(false);
    });

    it('should normalize legacy lowercase roles to canonical uppercase', () => {
      expect(normalizeRole('customer')).toBe('CUSTOMER');
      expect(normalizeRole('PARTNER')).toBe('PARTNER');
      expect(normalizeRole('  admin  ')).toBe('ADMIN');
      expect(normalizeRole('super_admin')).toBe('SUPER_ADMIN');
      expect(normalizeRole('unknown')).toBeNull();
      expect(normalizeRole(null)).toBeNull();
    });
  });

  describe('Permissions Catalog', () => {
    it('should contain expected domain permissions', () => {
      expect(PERMISSIONS.CUSTOMER_PROFILE_READ).toBe('customer:profile:read');
      expect(PERMISSIONS.PARTNER_PROFILE_READ).toBe('partner:profile:read');
      expect(PERMISSIONS.VEHICLE_READ).toBe('vehicle:read');
      expect(PERMISSIONS.VEHICLE_CREATE).toBe('vehicle:create');
      expect(PERMISSIONS.BOOKING_CREATE).toBe('booking:create');
      expect(PERMISSIONS.ADMIN_DASHBOARD_READ).toBe('admin:dashboard:read');
    });

    it('should validate permission strings', () => {
      expect(isPermissionValid(PERMISSIONS.VEHICLE_READ)).toBe(true);
      expect(isPermissionValid(PERMISSIONS.BOOKING_CREATE)).toBe(true);
      expect(isPermissionValid('non_existent:permission')).toBe(false);
      expect(isPermissionValid(null)).toBe(false);
    });
  });

  describe('Role-Permission Mapping', () => {
    it('should grant Customer appropriate permissions and reject administrative privileges', () => {
      expect(roleHasPermission(ROLES.CUSTOMER, PERMISSIONS.CUSTOMER_PROFILE_READ)).toBe(true);
      expect(roleHasPermission(ROLES.CUSTOMER, PERMISSIONS.BOOKING_CREATE)).toBe(true);
      expect(roleHasPermission(ROLES.CUSTOMER, PERMISSIONS.VEHICLE_READ)).toBe(true);

      // Security boundary: Customer cannot perform Partner or Admin actions
      expect(roleHasPermission(ROLES.CUSTOMER, PERMISSIONS.VEHICLE_CREATE)).toBe(false);
      expect(roleHasPermission(ROLES.CUSTOMER, PERMISSIONS.ADMIN_DASHBOARD_READ)).toBe(false);
      expect(roleHasPermission(ROLES.CUSTOMER, PERMISSIONS.PARTNER_KYC_VERIFY)).toBe(false);
    });

    it('should grant Partner vehicle management and reject Admin operations', () => {
      expect(roleHasPermission(ROLES.PARTNER, PERMISSIONS.PARTNER_PROFILE_READ)).toBe(true);
      expect(roleHasPermission(ROLES.PARTNER, PERMISSIONS.VEHICLE_CREATE)).toBe(true);
      expect(roleHasPermission(ROLES.PARTNER, PERMISSIONS.VEHICLE_UPDATE)).toBe(true);
      expect(roleHasPermission(ROLES.PARTNER, PERMISSIONS.PARTNER_EARNINGS_READ)).toBe(true);

      // Security boundary: Partner cannot approve KYC or view admin dashboard
      expect(roleHasPermission(ROLES.PARTNER, PERMISSIONS.ADMIN_DASHBOARD_READ)).toBe(false);
      expect(roleHasPermission(ROLES.PARTNER, PERMISSIONS.PARTNER_KYC_VERIFY)).toBe(false);
      expect(roleHasPermission(ROLES.PARTNER, PERMISSIONS.ADMIN_USERS_MANAGE)).toBe(false);
    });

    it('should grant Admin verification and management permissions', () => {
      expect(roleHasPermission(ROLES.ADMIN, PERMISSIONS.ADMIN_DASHBOARD_READ)).toBe(true);
      expect(roleHasPermission(ROLES.ADMIN, PERMISSIONS.PARTNER_KYC_VERIFY)).toBe(true);
      expect(roleHasPermission(ROLES.ADMIN, PERMISSIONS.VEHICLE_VERIFY)).toBe(true);
      expect(roleHasPermission(ROLES.ADMIN, PERMISSIONS.PAYMENT_REFUND)).toBe(true);
    });

    it('should grant Super Admin system-wide bypass', () => {
      expect(roleHasPermission(ROLES.SUPER_ADMIN, PERMISSIONS.ADMIN_USERS_MANAGE)).toBe(true);
      expect(roleHasPermission(ROLES.SUPER_ADMIN, PERMISSIONS.VEHICLE_CREATE)).toBe(true);
      expect(roleHasPermission(ROLES.SUPER_ADMIN, PERMISSIONS.BOOKING_CREATE)).toBe(true);
    });

    it('should return all permissions array for given role', () => {
      const customerPerms = getPermissionsForRole(ROLES.CUSTOMER);
      expect(Array.isArray(customerPerms)).toBe(true);
      expect(customerPerms).toContain(PERMISSIONS.CUSTOMER_PROFILE_READ);

      const superPerms = getPermissionsForRole(ROLES.SUPER_ADMIN);
      expect(superPerms.length).toBe(Object.keys(PERMISSIONS).length);
    });
  });
});
