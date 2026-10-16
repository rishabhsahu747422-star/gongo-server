'use strict';

const walletValidator = require('../../src/validators/wallet.validator');
const { ValidationError } = require('../../src/errors');

describe('Unit: WalletValidator', () => {
  describe('validateTransactionListQuery', () => {
    function executeValidator(query) {
      const req = { query };
      const res = {};
      const next = jest.fn();

      walletValidator.validateTransactionListQuery(req, res, next);

      return { req, next };
    }

    it('applies default pagination when no query parameters are provided', () => {
      const { req, next } = executeValidator({});

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery).toEqual({
        page: 1,
        limit: 20,
        offset: 0,
      });
    });

    it('parses valid page and limit parameters', () => {
      const { req, next } = executeValidator({ page: '3', limit: '50' });

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery).toEqual({
        page: 3,
        limit: 50,
        offset: 100,
      });
    });

    it('rejects invalid page values', () => {
      const { next: next0 } = executeValidator({ page: '0' });
      expect(next0).toHaveBeenCalledWith(expect.any(ValidationError));

      const { next: nextNeg } = executeValidator({ page: '-5' });
      expect(nextNeg).toHaveBeenCalledWith(expect.any(ValidationError));

      const { next: nextStr } = executeValidator({ page: 'abc' });
      expect(nextStr).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('rejects invalid limit values', () => {
      const { next: nextZero } = executeValidator({ limit: '0' });
      expect(nextZero).toHaveBeenCalledWith(expect.any(ValidationError));

      const { next: nextMax } = executeValidator({ limit: '101' });
      expect(nextMax).toHaveBeenCalledWith(expect.any(ValidationError));

      const { next: nextFloat } = executeValidator({ limit: '20.5' });
      expect(nextFloat).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('accepts valid direction filter (case-insensitive)', () => {
      const { req: req1, next: next1 } = executeValidator({ direction: 'credit' });
      expect(next1).toHaveBeenCalledWith();
      expect(req1.validatedQuery.direction).toBe('CREDIT');

      const { req: req2, next: next2 } = executeValidator({ direction: 'DEBIT' });
      expect(next2).toHaveBeenCalledWith();
      expect(req2.validatedQuery.direction).toBe('DEBIT');
    });

    it('rejects invalid direction filter', () => {
      const { next } = executeValidator({ direction: 'REFUND' });
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('accepts valid type filter', () => {
      const { req, next } = executeValidator({ type: 'settlement_payment' });
      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery.type).toBe('SETTLEMENT_PAYMENT');
    });

    it('accepts valid date range and rejects endDate < startDate', () => {
      const validDates = {
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-30T23:59:59.000Z',
      };
      const { req, next } = executeValidator(validDates);
      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery.startDate).toBe('2026-09-01T00:00:00.000Z');
      expect(req.validatedQuery.endDate).toBe('2026-09-30T23:59:59.000Z');

      const invalidDates = {
        startDate: '2026-09-30T00:00:00.000Z',
        endDate: '2026-09-01T00:00:00.000Z',
      };
      const { next: nextInvalid } = executeValidator(invalidDates);
      expect(nextInvalid).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('rejects malformed date strings', () => {
      const { next } = executeValidator({ startDate: 'not-a-date' });
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('validateTransactionIdParam', () => {
    function executeParamValidator(transactionId) {
      const req = { params: { transactionId } };
      const res = {};
      const next = jest.fn();

      walletValidator.validateTransactionIdParam(req, res, next);

      return { req, next };
    }

    it('accepts a valid UUID string', () => {
      const validUuid = '11111111-1111-4111-a111-111111111111';
      const { next } = executeParamValidator(validUuid);

      expect(next).toHaveBeenCalledWith();
    });

    it('rejects non-UUID identifiers', () => {
      const { next: nextNum } = executeParamValidator('12345');
      expect(nextNum).toHaveBeenCalledWith(expect.any(ValidationError));

      const { next: nextInvalid } = executeParamValidator('not-a-uuid');
      expect(nextInvalid).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });
});
