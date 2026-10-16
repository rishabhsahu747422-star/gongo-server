'use strict';

const earningsValidator = require('../../src/validators/earnings.validator');
const { ValidationError } = require('../../src/errors');

describe('Unit: EarningsValidator', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = { query: {}, params: {} };
    res = {};
    next = jest.fn();
  });

  describe('validateEarningsListQuery', () => {
    it('applies default pagination when no query parameters are provided', () => {
      earningsValidator.validateEarningsListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery).toEqual({
        page: 1,
        limit: 20,
        offset: 0,
      });
    });

    it('parses valid page and limit parameters', () => {
      req.query = { page: '3', limit: '50' };
      earningsValidator.validateEarningsListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery.page).toBe(3);
      expect(req.validatedQuery.limit).toBe(50);
      expect(req.validatedQuery.offset).toBe(100);
    });

    it('rejects invalid page values', () => {
      req.query = { page: '0' };
      earningsValidator.validateEarningsListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'page' }),
        ]),
      );
    });

    it('rejects invalid limit values', () => {
      req.query = { limit: '101' };
      earningsValidator.validateEarningsListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'limit' }),
        ]),
      );
    });

    it('accepts valid status filter', () => {
      req.query = { status: 'settled' };
      earningsValidator.validateEarningsListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery.status).toBe('SETTLED');
    });

    it('rejects invalid status filter', () => {
      req.query = { status: 'INVALID_STATUS' };
      earningsValidator.validateEarningsListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'status' }),
        ]),
      );
    });

    it('accepts valid date range and rejects endDate < startDate', () => {
      req.query = {
        startDate: '2026-03-01T00:00:00.000Z',
        endDate: '2026-03-10T00:00:00.000Z',
      };
      earningsValidator.validateEarningsListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery.startDate).toBe('2026-03-01T00:00:00.000Z');
      expect(req.validatedQuery.endDate).toBe('2026-03-10T00:00:00.000Z');

      // Reversed dates
      req.query = {
        startDate: '2026-03-10T00:00:00.000Z',
        endDate: '2026-03-01T00:00:00.000Z',
      };
      next.mockClear();
      earningsValidator.validateEarningsListQuery(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('validateEarningIdParam', () => {
    it('accepts a valid UUID string', () => {
      req.params = { earningId: '123e4567-e89b-12d3-a456-426614174000' };
      earningsValidator.validateEarningIdParam(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('rejects non-UUID identifiers', () => {
      req.params = { earningId: 'not-a-valid-uuid' };
      earningsValidator.validateEarningIdParam(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.details[0].field).toBe('earningId');
    });
  });
});
