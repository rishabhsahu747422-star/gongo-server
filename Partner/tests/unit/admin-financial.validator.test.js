'use strict';

const adminFinancialValidator = require('../../src/validators/admin-financial.validator');
const { ValidationError } = require('../../src/errors');

describe('Unit: AdminFinancialValidator', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = { query: {}, params: {}, body: {} };
    res = {};
    next = jest.fn();
  });

  describe('validateFinancialListQuery', () => {
    it('applies default pagination', () => {
      adminFinancialValidator.validateFinancialListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery).toEqual({
        page: 1,
        limit: 20,
        offset: 0,
      });
    });

    it('accepts valid partnerId and status', () => {
      req.query = {
        partnerId: '123e4567-e89b-12d3-a456-426614174000',
        status: 'SETTLED',
      };
      adminFinancialValidator.validateFinancialListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery.partnerId).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(req.validatedQuery.status).toBe('SETTLED');
    });

    it('rejects invalid partnerId UUID', () => {
      req.query = { partnerId: 'not-a-uuid' };
      adminFinancialValidator.validateFinancialListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('validateFailPayout', () => {
    it('accepts valid failureReason', () => {
      req.body = { failureReason: 'Bank IFSC mismatch' };
      adminFinancialValidator.validateFailPayout(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedBody).toEqual({ failureReason: 'Bank IFSC mismatch' });
    });

    it('rejects missing or too short failureReason', () => {
      req.body = { failureReason: 'no' };
      adminFinancialValidator.validateFailPayout(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });
});
