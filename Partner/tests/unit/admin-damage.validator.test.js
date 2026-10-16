'use strict';

const adminDamageValidator = require('../../src/validators/admin-damage.validator');
const { ValidationError } = require('../../src/errors');

describe('Unit: AdminDamageValidator', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = { body: {}, query: {}, params: {} };
    res = {};
    next = jest.fn();
  });

  describe('validateDamageListQuery', () => {
    it('applies default pagination for query', () => {
      adminDamageValidator.validateDamageListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery).toEqual({
        page: 1,
        limit: 20,
        offset: 0,
      });
    });

    it('accepts valid status filter', () => {
      req.query = { status: 'under_review' };
      adminDamageValidator.validateDamageListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery.status).toBe('UNDER_REVIEW');
    });

    it('rejects invalid status filter', () => {
      req.query = { status: 'INVALID_STATUS' };
      adminDamageValidator.validateDamageListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('accepts valid bookingId and vehicleId filters', () => {
      req.query = {
        bookingId: '123e4567-e89b-12d3-a456-426614174000',
        vehicleId: '223e4567-e89b-12d3-a456-426614174000',
      };
      adminDamageValidator.validateDamageListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery.bookingId).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(req.validatedQuery.vehicleId).toBe('223e4567-e89b-12d3-a456-426614174000');
    });
  });

  describe('validateDamageIdParam', () => {
    it('accepts valid UUID', () => {
      req.params = { damageId: '123e4567-e89b-12d3-a456-426614174000' };
      adminDamageValidator.validateDamageIdParam(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('rejects invalid UUID', () => {
      req.params = { damageId: 'invalid' };
      adminDamageValidator.validateDamageIdParam(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('validateApproveDamage', () => {
    it('accepts valid approvedAmount', () => {
      req.body = { approvedAmount: 1500.50 };
      adminDamageValidator.validateApproveDamage(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedBody).toEqual({ approvedAmount: 1500.50 });
    });

    it('rejects missing or zero/negative approvedAmount', () => {
      req.body = { approvedAmount: 0 };
      adminDamageValidator.validateApproveDamage(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('validateRejectDamage', () => {
    it('accepts valid optional reason', () => {
      req.body = { reason: 'Damage is wear-and-tear' };
      adminDamageValidator.validateRejectDamage(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedBody).toEqual({ reason: 'Damage is wear-and-tear' });
    });

    it('rejects reason that is too short', () => {
      req.body = { reason: 'no' };
      adminDamageValidator.validateRejectDamage(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });
});
