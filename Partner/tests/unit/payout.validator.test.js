'use strict';

const payoutValidator = require('../../src/validators/payout.validator');
const { ValidationError } = require('../../src/errors');

describe('Unit: PayoutValidator', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = { body: {}, query: {}, params: {}, headers: {} };
    res = {};
    next = jest.fn();
  });

  describe('validateRequestPayout', () => {
    it('accepts valid payout withdrawal request', () => {
      req.body = {
        amount: 500,
        bankAccountId: '123e4567-e89b-12d3-a456-426614174000',
        idempotencyKey: 'idem-key-1',
      };

      payoutValidator.validateRequestPayout(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedBody).toEqual({
        amount: 500.00,
        bankAccountId: '123e4567-e89b-12d3-a456-426614174000',
        idempotencyKey: 'idem-key-1',
      });
    });

    it('rejects amount below minimum threshold (₹100)', () => {
      req.body = { amount: 50 };

      payoutValidator.validateRequestPayout(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'amount' }),
        ]),
      );
    });

    it('rejects server-managed fields with error', () => {
      req.body = { amount: 200, status: 'COMPLETED' };

      payoutValidator.validateRequestPayout(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'status' }),
        ]),
      );
    });
  });

  describe('validatePayoutListQuery', () => {
    it('applies standard defaults for query', () => {
      payoutValidator.validatePayoutListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery).toEqual({
        page: 1,
        limit: 20,
        offset: 0,
      });
    });

    it('validates status filter', () => {
      req.query = { status: 'REQUESTED' };
      payoutValidator.validatePayoutListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery.status).toBe('REQUESTED');
    });

    it('rejects invalid status filter', () => {
      req.query = { status: 'UNKNOWN' };
      payoutValidator.validatePayoutListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('validatePayoutIdParam', () => {
    it('accepts valid UUID', () => {
      req.params = { payoutId: '123e4567-e89b-12d3-a456-426614174000' };
      payoutValidator.validatePayoutIdParam(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('rejects invalid UUID', () => {
      req.params = { payoutId: '123' };
      payoutValidator.validatePayoutIdParam(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });
});
