'use strict';

const { assertOwnership, verifyOwnership } = require('../../src/shared/auth');

describe('Unified Resource Ownership (BOLA / IDOR Defense) Suite', () => {
  describe('assertOwnership', () => {
    it('should pass when trusted ID strictly matches resource owner ID', () => {
      expect(() => {
        assertOwnership('customer-123', 'customer-123');
      }).not.toThrow();
    });

    it('should throw 403 Forbidden when IDs do not match', () => {
      expect(() => {
        assertOwnership('customer-123', 'customer-other');
      }).toThrow();

      try {
        assertOwnership('customer-123', 'customer-other');
      } catch (err) {
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('FORBIDDEN');
      }
    });

    it('should throw 404 Not Found when hideForbiddenAsNotFound option is enabled', () => {
      try {
        assertOwnership('customer-123', 'customer-other', { hideForbiddenAsNotFound: true });
      } catch (err) {
        expect(err.statusCode).toBe(404);
        expect(err.code).toBe('NOT_FOUND');
      }
    });

    it('should throw 401 Unauthorized if trusted ID is missing', () => {
      expect(() => {
        assertOwnership(null, 'resource-123');
      }).toThrow();
    });
  });

  describe('verifyOwnership Middleware Factory', () => {
    let req;
    let res;
    let next;

    beforeEach(() => {
      req = {
        user: { id: 'usr-owner', partnerId: 'prt-owner', role: 'PARTNER' },
        params: { id: 'vehicle-1' },
      };
      res = {};
      next = jest.fn();
    });

    it('should allow partner accessing their own vehicle', async () => {
      const mockLookup = jest.fn().mockResolvedValue({
        id: 'vehicle-1',
        partnerId: 'prt-owner',
        make: 'Honda',
      });

      const middleware = verifyOwnership(mockLookup, { type: 'partner' });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.resource).toBeDefined();
      expect(req.resource.id).toBe('vehicle-1');
    });

    it('should deny partner attempting to access another partner vehicle', async () => {
      const mockLookup = jest.fn().mockResolvedValue({
        id: 'vehicle-1',
        partnerId: 'prt-other',
        make: 'Yamaha',
      });

      const middleware = verifyOwnership(mockLookup, { type: 'partner' });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(403);
    });

    it('should allow customer accessing their own booking', async () => {
      req.user = { id: 'cust-owner', role: 'CUSTOMER' };
      const mockLookup = jest.fn().mockResolvedValue({
        id: 'bk-100',
        customerId: 'cust-owner',
        status: 'CONFIRMED',
      });

      const middleware = verifyOwnership(mockLookup);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.resource.id).toBe('bk-100');
    });

    it('should deny customer attempting to access another customer booking', async () => {
      req.user = { id: 'cust-attacker', role: 'CUSTOMER' };
      const mockLookup = jest.fn().mockResolvedValue({
        id: 'bk-100',
        customerId: 'cust-victim',
        status: 'CONFIRMED',
      });

      const middleware = verifyOwnership(mockLookup);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(403);
    });

    it('should return 404 when target entity does not exist in DB', async () => {
      const mockLookup = jest.fn().mockResolvedValue(null);

      const middleware = verifyOwnership(mockLookup);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('NOT_FOUND');
    });
  });
});
