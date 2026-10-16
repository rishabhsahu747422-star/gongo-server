'use strict';

const {
  validateIdentifier,
  safeOrderBy,
  safePagination,
  appendFilter,
  escapeLikeString,
} = require('../../src/db/sql-helpers');

describe('Unit: SQL Injection Safety Helpers', () => {
  describe('1. validateIdentifier', () => {
    it('accepts safe alphanumeric and underscore identifiers', () => {
      expect(validateIdentifier('users')).toBe('users');
      expect(validateIdentifier('created_at')).toBe('created_at');
      expect(validateIdentifier('actor_id_1')).toBe('actor_id_1');
    });

    it('rejects identifiers with SQL injection payloads or special characters', () => {
      expect(() => validateIdentifier('users; DROP TABLE users;--')).toThrow(/Invalid database identifier/);
      expect(() => validateIdentifier('table name')).toThrow(/Invalid database identifier/);
      expect(() => validateIdentifier('column"')).toThrow(/Invalid database identifier/);
      expect(() => validateIdentifier('')).toThrow(/Database identifier must be a non-empty string/);
    });
  });

  describe('2. safeOrderBy', () => {
    const allowed = ['id', 'created_at', 'status', 'amount'];

    it('generates safe ORDER BY clause for allowed columns and directions', () => {
      expect(safeOrderBy(allowed, 'created_at', 'ASC')).toBe('ORDER BY "created_at" ASC');
      expect(safeOrderBy(allowed, 'status', 'DESC')).toBe('ORDER BY "status" DESC');
      expect(safeOrderBy(allowed, 'amount', 'asc')).toBe('ORDER BY "amount" ASC');
    });

    it('falls back to default column and direction when requested column is not in allowlist', () => {
      expect(safeOrderBy(allowed, 'injected_column; DROP TABLE users;--', 'ASC', 'created_at', 'DESC')).toBe(
        'ORDER BY "created_at" ASC',
      );
      expect(safeOrderBy(allowed, null, null, 'id', 'DESC')).toBe('ORDER BY "id" DESC');
    });

    it('defaults direction to DESC when requested direction is invalid', () => {
      expect(safeOrderBy(allowed, 'status', 'INVALID_DIRECTION', 'created_at', 'DESC')).toBe(
        'ORDER BY "status" DESC',
      );
    });
  });

  describe('3. safePagination', () => {
    it('bounds limit and offset correctly', () => {
      expect(safePagination(15, 30)).toEqual({ limit: 15, offset: 30 });
      // Exceeds maxLimit
      expect(safePagination(500, 0, { maxLimit: 100 })).toEqual({ limit: 100, offset: 0 });
      // Non-integer or negative
      expect(safePagination('abc', -10, { defaultLimit: 20 })).toEqual({ limit: 20, offset: 0 });
    });
  });

  describe('4. appendFilter', () => {
    it('safely appends parameterized filter condition', () => {
      const conditions = [];
      const values = [];

      appendFilter(conditions, values, 'status', '=', 'CONFIRMED');
      appendFilter(conditions, values, 'amount', '>=', 500);

      expect(conditions).toEqual(['"status" = $1', '"amount" >= $2']);
      expect(values).toEqual(['CONFIRMED', 500]);
    });

    it('ignores null or undefined values', () => {
      const conditions = [];
      const values = [];

      appendFilter(conditions, values, 'status', '=', null);
      appendFilter(conditions, values, 'amount', '=', undefined);

      expect(conditions).toHaveLength(0);
      expect(values).toHaveLength(0);
    });

    it('rejects unsupported SQL operators', () => {
      const conditions = [];
      const values = [];

      expect(() => {
        appendFilter(conditions, values, 'status', 'UNSUPPORTED_OP', 'test');
      }).toThrow(/Unsupported SQL operator/);
    });
  });

  describe('5. escapeLikeString', () => {
    it('escapes %, _, and \\ in search terms', () => {
      expect(escapeLikeString('100% discount')).toBe('100\\% discount');
      expect(escapeLikeString('user_name')).toBe('user\\_name');
      expect(escapeLikeString('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('returns empty string for non-string input', () => {
      expect(escapeLikeString(null)).toBe('');
      expect(escapeLikeString(undefined)).toBe('');
      expect(escapeLikeString(123)).toBe('');
    });
  });
});
