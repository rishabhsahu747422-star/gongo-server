'use strict';

const {
  pickAllowed,
  isValidUUID,
  isValidEnum,
  isValidDate,
  validatePagination,
  validateSchema,
} = require('../../src/validators');
const { ValidationError } = require('../../src/errors');

describe('Unit: Input Validation & Mass-Assignment Hardening', () => {
  describe('1. pickAllowed (Mass-Assignment Protection)', () => {
    it('extracts only allowed fields from input object', () => {
      const input = {
        name: 'Super Admin',
        role: 'SUPER_ADMIN',
        unauthorizedField: 'hack',
        isAdmin: true,
      };
      const allowed = ['name', 'role'];

      const result = pickAllowed(input, allowed);
      expect(result).toEqual({ name: 'Super Admin', role: 'SUPER_ADMIN' });
      expect(result.unauthorizedField).toBeUndefined();
      expect(result.isAdmin).toBeUndefined();
    });

    it('rejects prototype pollution keys', () => {
      const input = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "test", "name": "Safe"}');
      const result = pickAllowed(input, ['__proto__', 'constructor', 'name']);

      expect(result).toEqual({ name: 'Safe' });
      expect(Object.prototype.polluted).toBeUndefined();
    });

    it('handles non-object input gracefully', () => {
      expect(pickAllowed(null, ['a'])).toEqual({});
      expect(pickAllowed('string', ['a'])).toEqual({});
      expect(pickAllowed([1, 2], ['a'])).toEqual({});
    });
  });

  describe('2. Field Validations', () => {
    it('validates UUID correctly', () => {
      expect(isValidUUID('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(true);
      expect(isValidUUID('invalid-uuid-string')).toBe(false);
      expect(isValidUUID(12345)).toBe(false);
      expect(isValidUUID('')).toBe(false);
    });

    it('validates enums correctly', () => {
      const allowed = ['PENDING', 'APPROVED', 'REJECTED'];
      expect(isValidEnum('APPROVED', allowed)).toBe(true);
      expect(isValidEnum('HACKED', allowed)).toBe(false);
    });

    it('validates dates correctly', () => {
      expect(isValidDate('2026-09-25T12:00:00.000Z')).toBe(true);
      expect(isValidDate('2026-09-25')).toBe(true);
      expect(isValidDate('invalid-date')).toBe(false);
      expect(isValidDate(null)).toBe(false);
    });

    it('validates and sanitizes pagination', () => {
      const valid = validatePagination({ page: '2', limit: '25' });
      expect(valid.isValid).toBe(true);
      expect(valid.page).toBe(2);
      expect(valid.limit).toBe(25);
      expect(valid.offset).toBe(25);

      const invalid = validatePagination({ page: '-1', limit: '200' });
      expect(invalid.isValid).toBe(false);
      expect(invalid.errors.page).toBeDefined();
      expect(invalid.errors.limit).toBeDefined();
    });
  });

  describe('3. validateSchema Middleware', () => {
    const testSchema = {
      name: { type: 'string', required: true, minLength: 2, maxLength: 50 },
      category: { type: 'enum', values: ['booking', 'pricing', 'system'], required: true },
      maxAmount: { type: 'number', min: 10, max: 1000 },
      actionDate: { type: 'date' },
    };

    it('passes valid payload and sanitizes request body', () => {
      const middleware = validateSchema(testSchema, { allowUnknown: false });
      const req = {
        body: {
          name: 'Commission Rule',
          category: 'pricing',
          maxAmount: 500,
          actionDate: '2026-09-25T12:00:00.000Z',
        },
      };
      const res = {};
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.body.name).toBe('Commission Rule');
      expect(req.cleanData).toBeDefined();
    });

    it('rejects unexpected fields when allowUnknown is false', () => {
      const middleware = validateSchema(testSchema, { allowUnknown: false });
      const req = {
        body: {
          name: 'Rule',
          category: 'pricing',
          injectedField: 'malicious',
        },
      };
      const res = {};
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.message).toContain('Unexpected fields in request body: injectedField');
    });

    it('rejects payload with prototype pollution attempt', () => {
      const middleware = validateSchema(testSchema);
      const req = {
        body: JSON.parse('{"__proto__": {"admin": true}}'),
      };
      const res = {};
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.message).toBe('Dangerous payload structure detected');
    });

    it('validates field constraints and required fields', () => {
      const middleware = validateSchema(testSchema);
      const req = {
        body: {
          name: 'A', // too short
          category: 'invalid_category', // invalid enum
          maxAmount: 5, // below min
        },
      };
      const res = {};
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.details.name).toBeDefined();
      expect(err.details.category).toBeDefined();
      expect(err.details.maxAmount).toBeDefined();
    });
  });
});
