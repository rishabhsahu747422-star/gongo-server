'use strict';

const { validateUpdateProfile } = require('../../../src/validators/customer.validator');

describe('Customer Validator Unit Tests', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = { body: {} };
    res = {};
    next = jest.fn();
  });

  describe('validateUpdateProfile', () => {
    it('should pass with valid name and email', () => {
      req.body = {
        name: 'Rishabh Sharma',
        email: 'Rishabh.Sharma@Example.COM',
      };

      validateUpdateProfile(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.body.name).toBe('Rishabh Sharma');
      expect(req.body.email).toBe('rishabh.sharma@example.com');
    });

    it('should pass with only name', () => {
      req.body = { name: 'Alice Smith' };

      validateUpdateProfile(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.body.name).toBe('Alice Smith');
    });

    it('should pass with only email', () => {
      req.body = { email: 'user@domain.in' };

      validateUpdateProfile(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.body.email).toBe('user@domain.in');
    });

    it('should reject empty body with INVALID_UPDATE_PAYLOAD', () => {
      req.body = {};

      validateUpdateProfile(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          code: 'INVALID_UPDATE_PAYLOAD',
        }),
      );
    });

    it('should reject non-object body', () => {
      req.body = null;

      validateUpdateProfile(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        }),
      );
    });

    it('should reject unexpected/disallowed fields like role, phone, authId, isActive', () => {
      const forbiddenFields = [
        { role: 'admin' },
        { phone: '9876543210' },
        { authId: 'hacked_id' },
        { isActive: false },
        { userId: '00000000-0000-0000-0000-000000000001' },
        { customerId: '00000000-0000-0000-0000-000000000001' },
        { createdAt: '2026-01-01' },
        { status: 'VERIFIED' },
      ];

      forbiddenFields.forEach((payload) => {
        const testNext = jest.fn();
        validateUpdateProfile({ body: { name: 'Valid Name', ...payload } }, res, testNext);
        expect(testNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
            code: 'VALIDATION_ERROR',
          }),
        );
      });
    });

    it('should reject invalid name formats', () => {
      const invalidNames = [
        'A', // Too short (< 2)
        'a'.repeat(101), // Too long (> 100)
        'User123', // Digits not allowed
        '<script>alert(1)</script>', // XSS
        12345, // Non-string
      ];

      invalidNames.forEach((name) => {
        const testNext = jest.fn();
        validateUpdateProfile({ body: { name } }, res, testNext);
        expect(testNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
            code: 'VALIDATION_ERROR',
          }),
        );
      });
    });

    it('should reject invalid email formats', () => {
      const invalidEmails = [
        'plainaddress',
        '@missingusername.com',
        'username@.com',
        'username@com',
        'username space@domain.com',
        12345, // Non-string
      ];

      invalidEmails.forEach((email) => {
        const testNext = jest.fn();
        validateUpdateProfile({ body: { email } }, res, testNext);
        expect(testNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
            code: 'VALIDATION_ERROR',
          }),
        );
      });
    });
  });
});
