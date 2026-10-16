'use strict';

const {
  requireAuthenticatedUser,
  requireRole,
  requirePermission,
  requireAnyPermission,
  ROLES,
  PERMISSIONS,
} = require('../../src/shared/auth');

describe('Unified Authorization Middleware Suite', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = { user: null };
    res = {};
    next = jest.fn();
  });

  describe('requireAuthenticatedUser', () => {
    it('should reject unauthenticated requests with 401 Unauthorized', () => {
      requireAuthenticatedUser(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(401);
      expect(err.code).toBe('AUTH_REQUIRED');
    });

    it('should pass authenticated requests with valid user context', () => {
      req.user = { id: 'usr-123', role: 'CUSTOMER' };
      requireAuthenticatedUser(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('requireRole', () => {
    it('should reject unauthenticated request before checking role', () => {
      const middleware = requireRole(ROLES.CUSTOMER);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(401);
    });

    it('should reject requests with missing or empty role', () => {
      req.user = { id: 'usr-123', role: null };
      const middleware = requireRole(ROLES.CUSTOMER);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(403);
    });

    it('should allow Customer accessing Customer routes', () => {
      req.user = { id: 'usr-123', role: 'CUSTOMER' };
      const middleware = requireRole(ROLES.CUSTOMER);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('should allow lowercase legacy role (e.g. "customer")', () => {
      req.user = { id: 'usr-123', role: 'customer' };
      const middleware = requireRole(ROLES.CUSTOMER);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('should deny Customer attempting to access Admin routes', () => {
      req.user = { id: 'usr-123', role: 'CUSTOMER' };
      const middleware = requireRole(ROLES.ADMIN);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('FORBIDDEN');
    });

    it('should deny Partner attempting to access Admin routes', () => {
      req.user = { id: 'prt-456', partnerId: 'prt-456', role: 'PARTNER' };
      const middleware = requireRole(ROLES.ADMIN);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(403);
    });

    it('should allow Admin accessing authorized Admin routes', () => {
      req.user = { id: 'adm-001', role: 'ADMIN' };
      const middleware = requireRole(ROLES.ADMIN);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('should allow Super Admin on any role requirement', () => {
      req.user = { id: 'sup-001', role: 'SUPER_ADMIN' };
      const middleware = requireRole(ROLES.PARTNER);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('should reject unknown role string', () => {
      req.user = { id: 'usr-999', role: 'UNKNOWN_ROLE' };
      const middleware = requireRole(ROLES.CUSTOMER);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(403);
    });
  });

  describe('requirePermission', () => {
    it('should allow request when user role has permission in catalog', () => {
      req.user = { id: 'usr-123', role: 'CUSTOMER' };
      const middleware = requirePermission(PERMISSIONS.BOOKING_CREATE);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('should deny request when user role lacks permission', () => {
      req.user = { id: 'usr-123', role: 'CUSTOMER' };
      const middleware = requirePermission(PERMISSIONS.VEHICLE_VERIFY);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('should allow request when user holds explicit permission grant in array', () => {
      req.user = {
        id: 'adm-special',
        role: 'SUPPORT_EXECUTIVE',
        permissions: [PERMISSIONS.VEHICLE_VERIFY],
      };
      const middleware = requirePermission(PERMISSIONS.VEHICLE_VERIFY);
      middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('requireAnyPermission', () => {
    it('should allow request when user holds at least one of the permissions', () => {
      req.user = { id: 'usr-123', role: 'CUSTOMER' };
      const middleware = requireAnyPermission(
        PERMISSIONS.VEHICLE_VERIFY, // does not have
        PERMISSIONS.BOOKING_CREATE, // has
      );
      middleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('should deny request when user holds none of the permissions', () => {
      req.user = { id: 'usr-123', role: 'CUSTOMER' };
      const middleware = requireAnyPermission(
        PERMISSIONS.VEHICLE_VERIFY,
        PERMISSIONS.ADMIN_DASHBOARD_READ,
      );
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(403);
    });
  });
});
