'use strict';

const {
  validateResourceId,
  assertAuthenticated,
  assertAdminRole,
  assertPermission,
  safeResourceLookup,
  requireResourceAccess,
} = require('../../src/security/access-control');
const {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require('../../src/errors');

describe('Unit: BOLA / IDOR Foundation & Access Control', () => {
  describe('1. validateResourceId', () => {
    it('accepts valid UUID identifiers', () => {
      const validUUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      expect(validateResourceId(validUUID)).toBe(validUUID);
    });

    it('accepts valid integer identifiers when allowInteger is enabled', () => {
      expect(validateResourceId('12345')).toBe('12345');
    });

    it('rejects path traversal attempts', () => {
      expect(() => validateResourceId('../../etc/passwd')).toThrow(ValidationError);
      expect(() => validateResourceId('..\\secret')).toThrow(ValidationError);
    });

    it('rejects null bytes and slash characters', () => {
      expect(() => validateResourceId('admin\0root')).toThrow(ValidationError);
      expect(() => validateResourceId('folder/item')).toThrow(ValidationError);
    });

    it('enforces UUID strictly when requireUUID is true', () => {
      expect(() => validateResourceId('12345', 'id', { requireUUID: true })).toThrow(ValidationError);
    });

    it('rejects empty or null IDs', () => {
      expect(() => validateResourceId('', 'id')).toThrow(ValidationError);
      expect(() => validateResourceId(null, 'id')).toThrow(ValidationError);
    });
  });

  describe('2. assertAuthenticated & assertAdminRole', () => {
    it('asserts valid active user passes', () => {
      const req = { user: { id: 'usr-1', is_active: true, role: 'ADMIN' } };
      expect(assertAuthenticated(req)).toEqual(req.user);
    });

    it('throws UnauthorizedError if req.user is missing', () => {
      expect(() => assertAuthenticated({})).toThrow(UnauthorizedError);
    });

    it('throws ForbiddenError if account is deactivated', () => {
      const req = { user: { id: 'usr-1', is_active: false } };
      expect(() => assertAuthenticated(req)).toThrow(ForbiddenError);
    });

    it('assertAdminRole allows ADMIN and rejects non-admin roles', () => {
      expect(() => assertAdminRole({ role: 'ADMIN' })).not.toThrow();
      expect(() => assertAdminRole({ role: 'CUSTOMER' })).toThrow(ForbiddenError);
      expect(() => assertAdminRole({ role: 'PARTNER' })).toThrow(ForbiddenError);
    });
  });

  describe('3. assertPermission', () => {
    it('allows user with matching permission', () => {
      const user = { permissions: ['VEHICLE_ADMIN', 'KYC_ADMIN'] };
      expect(() => assertPermission(user, 'VEHICLE_ADMIN')).not.toThrow();
    });

    it('allows SUPER_ADMIN to pass any permission requirement', () => {
      const superAdmin = { permissions: ['SUPER_ADMIN'] };
      expect(() => assertPermission(superAdmin, 'SETTINGS_ADMIN')).not.toThrow();
    });

    it('throws ForbiddenError when user lacks required permission', () => {
      const user = { permissions: ['SUPPORT_AGENT'] };
      expect(() => assertPermission(user, 'FINANCIAL_ADMIN')).toThrow(ForbiddenError);
    });
  });

  describe('4. safeResourceLookup (BOLA / IDOR Protection)', () => {
    const mockDb = {
      'booking-100': { id: 'booking-100', partnerId: 'partner-1' },
      'booking-200': { id: 'booking-200', partnerId: 'partner-2' },
    };
    const lookupFn = async (id) => mockDb[id] || null;

    it('returns resource when it exists and authorization passes', async () => {
      const actor = { id: 'admin-1', role: 'ADMIN' };
      const resource = await safeResourceLookup(lookupFn, 'booking-100', {
        actor,
        resourceName: 'Booking',
      });
      expect(resource).toEqual(mockDb['booking-100']);
    });

    it('throws 404 NotFoundError when resource does not exist', async () => {
      await expect(
        safeResourceLookup(lookupFn, 'booking-non-existent', { resourceName: 'Booking' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('prevents IDOR existence probing by returning 404 when unauthorized (hideUnauthorized=true)', async () => {
      const actor = { id: 'partner-agent-1' };
      const authorizeFn = (act, res) => res.partnerId === 'partner-999'; // not authorized

      await expect(
        safeResourceLookup(lookupFn, 'booking-100', {
          actor,
          resourceName: 'Booking',
          authorizeFn,
          hideUnauthorized: true,
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('returns 403 ForbiddenError if hideUnauthorized is explicitly disabled', async () => {
      const actor = { id: 'partner-agent-1' };
      const authorizeFn = () => false;

      await expect(
        safeResourceLookup(lookupFn, 'booking-100', {
          actor,
          resourceName: 'Booking',
          authorizeFn,
          hideUnauthorized: false,
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('5. requireResourceAccess Middleware', () => {
    it('resolves resource, validates ID, and attaches to req.resource', async () => {
      const lookupFn = jest.fn().mockResolvedValue({ id: 'res-123', name: 'Item' });
      const middleware = requireResourceAccess(lookupFn, { paramName: 'bookingId', resourceName: 'Booking' });

      const req = { params: { bookingId: 'res-123' }, user: { id: 'adm-1' } };
      const res = {};
      const next = jest.fn();

      await middleware(req, res, next);

      expect(lookupFn).toHaveBeenCalledWith('res-123');
      expect(req.resource).toEqual({ id: 'res-123', name: 'Item' });
      expect(next).toHaveBeenCalledWith();
    });

    it('passes error to next when ID is malformed', async () => {
      const lookupFn = jest.fn();
      const middleware = requireResourceAccess(lookupFn);

      const req = { params: { id: '../etc/passwd' } };
      const res = {};
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(lookupFn).not.toHaveBeenCalled();
    });
  });
});
