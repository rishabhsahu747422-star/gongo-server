'use strict';

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const adminPermissionRepository = require('../../src/repositories/admin-permission.repository');
const userRepository = require('../../src/repositories/user.repository');
const adminPermissionService = require('../../src/services/admin-permission.service');
const { PERMISSIONS } = require('../../src/constants/permissions');
const {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require('../../src/errors');

// Mock repositories
jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId');
jest.spyOn(adminPermissionRepository, 'assignPermission');
jest.spyOn(adminPermissionRepository, 'revokePermission');
jest.spyOn(userRepository, 'findById');

const MOCK_ADMIN_ACTOR = {
  id: 'actor-admin-uuid',
  role: 'ADMIN',
  is_active: true,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const MOCK_ADMIN_MANAGER = {
  id: 'manager-admin-uuid',
  role: 'ADMIN',
  is_active: true,
  permissions: [PERMISSIONS.ADMIN_PERMISSIONS_MANAGE, PERMISSIONS.CUSTOMERS_READ],
};

const MOCK_TARGET_ADMIN = {
  id: 'target-admin-uuid',
  role: 'ADMIN',
  is_active: true,
  auth_id: 'firebase-target-uid',
};

const MOCK_CUSTOMER = {
  id: 'customer-uuid',
  role: 'CUSTOMER',
  is_active: true,
};

const MOCK_PARTNER = {
  id: 'partner-uuid',
  role: 'PARTNER',
  is_active: true,
};

describe('Unit: Admin Permission Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. hasPermission', () => {
    it('returns true when user has the specific permission', async () => {
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue([
        'customers.read', 'customers.update',
      ]);

      const result = await adminPermissionService.hasPermission('user-1', 'customers.read');
      expect(result).toBe(true);
    });

    it('returns false when user lacks the permission', async () => {
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue(['customers.read']);

      const result = await adminPermissionService.hasPermission('user-1', 'admin.permissions.manage');
      expect(result).toBe(false);
    });

    it('returns true for SUPER_ADMIN regardless of specific permission', async () => {
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue(['SUPER_ADMIN']);

      const result = await adminPermissionService.hasPermission('user-1', 'admin.permissions.manage');
      expect(result).toBe(true);
    });
  });

  describe('2. hasAnyPermission', () => {
    it('returns true when user has any of the listed permissions', async () => {
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue(['payments.refund']);

      const result = await adminPermissionService.hasAnyPermission('user-1', ['payments.read', 'payments.refund']);
      expect(result).toBe(true);
    });

    it('returns false when user has none of the listed permissions', async () => {
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue(['customers.read']);

      const result = await adminPermissionService.hasAnyPermission('user-1', ['payments.read', 'payments.refund']);
      expect(result).toBe(false);
    });

    it('SUPER_ADMIN passes any-of check', async () => {
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue(['SUPER_ADMIN']);

      const result = await adminPermissionService.hasAnyPermission('user-1', ['payments.read']);
      expect(result).toBe(true);
    });
  });

  describe('3. hasAllPermissions', () => {
    it('returns true when user has all listed permissions', async () => {
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue([
        'customers.read', 'customers.update',
      ]);

      const result = await adminPermissionService.hasAllPermissions('user-1', [
        'customers.read', 'customers.update',
      ]);
      expect(result).toBe(true);
    });

    it('returns false when user is missing one permission', async () => {
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue(['customers.read']);

      const result = await adminPermissionService.hasAllPermissions('user-1', [
        'customers.read', 'customers.update',
      ]);
      expect(result).toBe(false);
    });

    it('SUPER_ADMIN passes all-of check', async () => {
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue(['SUPER_ADMIN']);

      const result = await adminPermissionService.hasAllPermissions('user-1', [
        'customers.read', 'admin.permissions.manage',
      ]);
      expect(result).toBe(true);
    });
  });

  describe('4. grantPermission', () => {
    it('grants permission when actor has SUPER_ADMIN and target is valid ADMIN', async () => {
      userRepository.findById.mockResolvedValue(MOCK_TARGET_ADMIN);
      adminPermissionRepository.assignPermission.mockResolvedValue({ id: 'perm-1' });

      const result = await adminPermissionService.grantPermission({
        targetUserId: MOCK_TARGET_ADMIN.id,
        permission: PERMISSIONS.CUSTOMERS_READ,
        actor: MOCK_ADMIN_ACTOR,
      });

      expect(result.granted).toBe(true);
      expect(result.permission).toBe(PERMISSIONS.CUSTOMERS_READ);
      expect(adminPermissionRepository.assignPermission).toHaveBeenCalledWith(
        MOCK_TARGET_ADMIN.id,
        PERMISSIONS.CUSTOMERS_READ,
        MOCK_ADMIN_ACTOR.id,
      );
    });

    it('grants permission when actor has admin.permissions.manage', async () => {
      userRepository.findById.mockResolvedValue(MOCK_TARGET_ADMIN);
      adminPermissionRepository.assignPermission.mockResolvedValue({ id: 'perm-2' });

      const result = await adminPermissionService.grantPermission({
        targetUserId: MOCK_TARGET_ADMIN.id,
        permission: PERMISSIONS.PARTNERS_READ,
        actor: MOCK_ADMIN_MANAGER,
      });

      expect(result.granted).toBe(true);
    });

    it('handles idempotent grant (ON CONFLICT DO NOTHING)', async () => {
      userRepository.findById.mockResolvedValue(MOCK_TARGET_ADMIN);
      adminPermissionRepository.assignPermission.mockResolvedValue(null); // already exists

      const result = await adminPermissionService.grantPermission({
        targetUserId: MOCK_TARGET_ADMIN.id,
        permission: PERMISSIONS.CUSTOMERS_READ,
        actor: MOCK_ADMIN_ACTOR,
      });

      expect(result.granted).toBe(false);
    });

    it('rejects unauthenticated actors', async () => {
      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor: null,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects non-ADMIN actors', async () => {
      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor: { ...MOCK_ADMIN_ACTOR, role: 'CUSTOMER' },
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects actors without management permission', async () => {
      const actor = {
        id: 'limited-admin',
        role: 'ADMIN',
        is_active: true,
        permissions: ['customers.read'],
      };

      // Fallback DB query also returns no management permission
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue(['customers.read']);

      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects unknown permission strings', async () => {
      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: 'hack.inject.sql',
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects Customer ID as target (returns 404)', async () => {
      userRepository.findById.mockResolvedValue(MOCK_CUSTOMER);

      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_CUSTOMER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('rejects Partner ID as target (returns 404)', async () => {
      userRepository.findById.mockResolvedValue(MOCK_PARTNER);

      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_PARTNER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('rejects nonexistent target user (returns 404)', async () => {
      userRepository.findById.mockResolvedValue(null);

      await expect(
        adminPermissionService.grantPermission({
          targetUserId: 'nonexistent-uuid',
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('rejects deactivated target admin', async () => {
      userRepository.findById.mockResolvedValue({ ...MOCK_TARGET_ADMIN, is_active: false });

      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('prevents self-escalation (granting a permission the actor does not have)', async () => {
      const selfActor = {
        ...MOCK_ADMIN_MANAGER,
        id: 'self-admin-uuid',
      };
      userRepository.findById.mockResolvedValue({
        ...MOCK_TARGET_ADMIN,
        id: 'self-admin-uuid',
      });

      await expect(
        adminPermissionService.grantPermission({
          targetUserId: 'self-admin-uuid',
          permission: PERMISSIONS.PAYMENTS_REFUND, // actor doesn't have this
          actor: selfActor,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('allows self-grant of already-possessed permission', async () => {
      const selfActor = {
        ...MOCK_ADMIN_MANAGER,
        id: 'self-admin-uuid',
      };
      userRepository.findById.mockResolvedValue({
        ...MOCK_TARGET_ADMIN,
        id: 'self-admin-uuid',
      });
      adminPermissionRepository.assignPermission.mockResolvedValue(null); // idempotent

      // Actor has customers.read, so self-granting it is allowed (idempotent)
      const result = await adminPermissionService.grantPermission({
        targetUserId: 'self-admin-uuid',
        permission: PERMISSIONS.CUSTOMERS_READ,
        actor: selfActor,
      });

      expect(result.granted).toBe(false); // already had it
    });

    it('rejects empty or null permission', async () => {
      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: '',
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: null,
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects deactivated actor', async () => {
      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor: { ...MOCK_ADMIN_ACTOR, is_active: false },
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('5. revokePermission', () => {
    it('revokes permission when actor has SUPER_ADMIN', async () => {
      userRepository.findById.mockResolvedValue(MOCK_TARGET_ADMIN);
      adminPermissionRepository.revokePermission.mockResolvedValue(true);

      const result = await adminPermissionService.revokePermission({
        targetUserId: MOCK_TARGET_ADMIN.id,
        permission: PERMISSIONS.CUSTOMERS_READ,
        actor: MOCK_ADMIN_ACTOR,
      });

      expect(result.revoked).toBe(true);
    });

    it('handles revocation of missing permission gracefully', async () => {
      userRepository.findById.mockResolvedValue(MOCK_TARGET_ADMIN);
      adminPermissionRepository.revokePermission.mockResolvedValue(false);

      const result = await adminPermissionService.revokePermission({
        targetUserId: MOCK_TARGET_ADMIN.id,
        permission: PERMISSIONS.CUSTOMERS_READ,
        actor: MOCK_ADMIN_ACTOR,
      });

      expect(result.revoked).toBe(false);
    });

    it('prevents self-lockout: cannot revoke own admin.permissions.manage', async () => {
      const selfActor = {
        ...MOCK_ADMIN_MANAGER,
        id: 'self-uuid',
      };
      userRepository.findById.mockResolvedValue({
        ...MOCK_TARGET_ADMIN,
        id: 'self-uuid',
      });

      await expect(
        adminPermissionService.revokePermission({
          targetUserId: 'self-uuid',
          permission: PERMISSIONS.ADMIN_PERMISSIONS_MANAGE,
          actor: selfActor,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('prevents self-lockout: cannot revoke own SUPER_ADMIN', async () => {
      const selfActor = {
        ...MOCK_ADMIN_ACTOR,
        id: 'self-uuid',
      };
      userRepository.findById.mockResolvedValue({
        ...MOCK_TARGET_ADMIN,
        id: 'self-uuid',
      });

      await expect(
        adminPermissionService.revokePermission({
          targetUserId: 'self-uuid',
          permission: PERMISSIONS.SUPER_ADMIN,
          actor: selfActor,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects unauthorized actor', async () => {
      const actor = {
        id: 'limited-admin',
        role: 'ADMIN',
        is_active: true,
        permissions: ['customers.read'],
      };

      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue(['customers.read']);

      await expect(
        adminPermissionService.revokePermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects Customer ID as target', async () => {
      userRepository.findById.mockResolvedValue(MOCK_CUSTOMER);

      await expect(
        adminPermissionService.revokePermission({
          targetUserId: MOCK_CUSTOMER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('6. getPermissions', () => {
    it('returns permissions for valid admin target', async () => {
      userRepository.findById.mockResolvedValue(MOCK_TARGET_ADMIN);
      adminPermissionRepository.findPermissionsByUserId.mockResolvedValue([
        'customers.read', 'dashboard.read',
      ]);

      const result = await adminPermissionService.getPermissions(
        MOCK_TARGET_ADMIN.id,
        MOCK_ADMIN_ACTOR,
      );
      expect(result).toEqual(['customers.read', 'dashboard.read']);
    });

    it('rejects unauthenticated caller', async () => {
      await expect(
        adminPermissionService.getPermissions(MOCK_TARGET_ADMIN.id, null),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('7. listAvailablePermissions', () => {
    it('returns all permissions from the catalog', () => {
      const result = adminPermissionService.listAvailablePermissions();
      expect(result.length).toBeGreaterThan(0);
      result.forEach((entry) => {
        expect(entry).toHaveProperty('key');
        expect(entry).toHaveProperty('permission');
      });
    });
  });

  describe('8. Input validation', () => {
    it('rejects oversized permission strings', async () => {
      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: 'a'.repeat(51),
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects non-string permission', async () => {
      await expect(
        adminPermissionService.grantPermission({
          targetUserId: MOCK_TARGET_ADMIN.id,
          permission: 12345,
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects missing target user ID', async () => {
      await expect(
        adminPermissionService.grantPermission({
          targetUserId: null,
          permission: PERMISSIONS.CUSTOMERS_READ,
          actor: MOCK_ADMIN_ACTOR,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
