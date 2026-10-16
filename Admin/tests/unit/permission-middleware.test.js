'use strict';

const { requirePermission, requireAllPermissions } = require('../../src/middlewares/permission');
const { ForbiddenError } = require('../../src/errors');

describe('Unit: Permission Middleware', () => {
  const createReq = (permissions = [], role = 'ADMIN') => ({
    user: {
      id: 'user-1',
      role,
      permissions,
      is_active: true,
    },
    originalUrl: '/api/v1/admin/test',
    method: 'GET',
  });
  const res = {};

  describe('1. requirePermission (any-of)', () => {
    it('allows access when user has the required permission', () => {
      const middleware = requirePermission('customers.read');
      const req = createReq(['customers.read', 'customers.update']);
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('allows access when user has ANY of the required permissions', () => {
      const middleware = requirePermission(['payments.read', 'payments.refund']);
      const req = createReq(['payments.refund']);
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('denies access with ForbiddenError when user lacks required permission', () => {
      const middleware = requirePermission('admin.permissions.manage');
      const req = createReq(['customers.read']);
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
      const err = next.mock.calls[0][0];
      expect(err.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('allows SUPER_ADMIN to bypass any permission check', () => {
      const middleware = requirePermission('admin.permissions.manage');
      const req = createReq(['SUPER_ADMIN']);
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('denies access when req.user is missing', () => {
      const middleware = requirePermission('customers.read');
      const next = jest.fn();

      middleware({}, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('denies access when user has empty permissions array', () => {
      const middleware = requirePermission('customers.read');
      const req = createReq([]);
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('does not trust forged x-permission headers', () => {
      const middleware = requirePermission('admin.permissions.manage');
      const req = createReq([]);
      req.headers = { 'x-permission': 'admin.permissions.manage' };
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('does not trust body-injected permissions', () => {
      const middleware = requirePermission('admin.permissions.manage');
      const req = createReq([]);
      req.body = { permissions: ['admin.permissions.manage'] };
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });
  });

  describe('2. requireAllPermissions (all-of)', () => {
    it('allows access when user has ALL required permissions', () => {
      const middleware = requireAllPermissions(['customers.read', 'customers.update']);
      const req = createReq(['customers.read', 'customers.update', 'dashboard.read']);
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('denies access when user has only SOME of the required permissions', () => {
      const middleware = requireAllPermissions(['customers.read', 'customers.update']);
      const req = createReq(['customers.read']);
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('allows SUPER_ADMIN to bypass all-of permission checks', () => {
      const middleware = requireAllPermissions(['customers.read', 'admin.permissions.manage']);
      const req = createReq(['SUPER_ADMIN']);
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('denies when req.user is missing', () => {
      const middleware = requireAllPermissions(['customers.read']);
      const next = jest.fn();

      middleware({}, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });
  });
});
