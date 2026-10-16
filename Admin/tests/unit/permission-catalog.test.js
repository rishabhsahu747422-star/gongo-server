'use strict';

const { PERMISSIONS, VALID_PERMISSIONS, PERMISSION_GROUPS } = require('../../src/constants/permissions');

describe('Unit: Permission Catalog & Constants', () => {
  describe('1. PERMISSIONS constant', () => {
    it('is a frozen object', () => {
      expect(Object.isFrozen(PERMISSIONS)).toBe(true);
    });

    it('contains SUPER_ADMIN as the full-access bypass', () => {
      expect(PERMISSIONS.SUPER_ADMIN).toBe('SUPER_ADMIN');
    });

    it('follows domain.action naming convention for granular permissions', () => {
      const granular = Object.values(PERMISSIONS).filter((p) => p !== 'SUPER_ADMIN');
      granular.forEach((perm) => {
        expect(perm).toMatch(/^[a-z][a-z0-9]*\.[a-z][a-z0-9.]*$/);
      });
    });

    it('contains all required domain permissions from architecture', () => {
      const expectedDomains = [
        'dashboard', 'customers', 'partners', 'shops', 'vehicles',
        'kyc', 'bookings', 'payments', 'refunds', 'commissions',
        'payouts', 'wallets', 'support', 'disputes', 'reviews',
        'notifications', 'admin', 'audit', 'settings', 'reports', 'analytics',
      ];

      const permValues = Object.values(PERMISSIONS);
      expectedDomains.forEach((domain) => {
        const hasDomain = permValues.some((p) => p.startsWith(`${domain}.`) || p.startsWith(domain));
        expect(hasDomain).toBe(true);
      });
    });

    it('has no duplicate permission values', () => {
      const values = Object.values(PERMISSIONS);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });

    it('has no empty or whitespace-only permission values', () => {
      Object.values(PERMISSIONS).forEach((perm) => {
        expect(typeof perm).toBe('string');
        expect(perm.trim().length).toBeGreaterThan(0);
      });
    });
  });

  describe('2. VALID_PERMISSIONS set', () => {
    it('is a Set containing all PERMISSIONS values', () => {
      expect(VALID_PERMISSIONS).toBeInstanceOf(Set);
      Object.values(PERMISSIONS).forEach((perm) => {
        expect(VALID_PERMISSIONS.has(perm)).toBe(true);
      });
    });

    it('does not contain unknown permissions', () => {
      expect(VALID_PERMISSIONS.has('NONEXISTENT_ADMIN')).toBe(false);
      expect(VALID_PERMISSIONS.has('hack.inject')).toBe(false);
      expect(VALID_PERMISSIONS.has('')).toBe(false);
    });
  });

  describe('3. PERMISSION_GROUPS', () => {
    it('is a frozen object', () => {
      expect(Object.isFrozen(PERMISSION_GROUPS)).toBe(true);
    });

    it('SUPER_ADMIN group contains all permissions', () => {
      const allPerms = Object.values(PERMISSIONS);
      expect(PERMISSION_GROUPS.SUPER_ADMIN).toEqual(expect.arrayContaining(allPerms));
    });

    it('OPERATIONS_ADMIN group contains expected domain permissions', () => {
      expect(PERMISSION_GROUPS.OPERATIONS_ADMIN).toContain(PERMISSIONS.DASHBOARD_READ);
      expect(PERMISSION_GROUPS.OPERATIONS_ADMIN).toContain(PERMISSIONS.CUSTOMERS_READ);
      expect(PERMISSION_GROUPS.OPERATIONS_ADMIN).toContain(PERMISSIONS.BOOKINGS_READ);
    });

    it('FINANCE_ADMIN group contains expected financial permissions', () => {
      expect(PERMISSION_GROUPS.FINANCE_ADMIN).toContain(PERMISSIONS.PAYMENTS_READ);
      expect(PERMISSION_GROUPS.FINANCE_ADMIN).toContain(PERMISSIONS.PAYOUTS_APPROVE);
      expect(PERMISSION_GROUPS.FINANCE_ADMIN).toContain(PERMISSIONS.WALLETS_READ);
    });

    it('SUPPORT_ADMIN group contains expected support permissions', () => {
      expect(PERMISSION_GROUPS.SUPPORT_ADMIN).toContain(PERMISSIONS.SUPPORT_READ);
      expect(PERMISSION_GROUPS.SUPPORT_ADMIN).toContain(PERMISSIONS.DISPUTES_RESOLVE);
    });

    it('VERIFICATION_ADMIN group contains expected verification permissions', () => {
      expect(PERMISSION_GROUPS.VERIFICATION_ADMIN).toContain(PERMISSIONS.KYC_VERIFY);
      expect(PERMISSION_GROUPS.VERIFICATION_ADMIN).toContain(PERMISSIONS.PARTNERS_VERIFY);
      expect(PERMISSION_GROUPS.VERIFICATION_ADMIN).toContain(PERMISSIONS.VEHICLES_VERIFY);
    });

    it('all group permissions reference valid PERMISSIONS values', () => {
      Object.values(PERMISSION_GROUPS).forEach((groupPerms) => {
        groupPerms.forEach((perm) => {
          expect(VALID_PERMISSIONS.has(perm)).toBe(true);
        });
      });
    });
  });
});
