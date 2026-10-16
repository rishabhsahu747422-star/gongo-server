'use strict';

const bankAccountValidator = require('../../src/validators/bank-account.validator');
const { ValidationError } = require('../../src/errors');

describe('Unit: BankAccountValidator', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = { body: {}, params: {} };
    res = {};
    next = jest.fn();
  });

  describe('validateCreateBankAccount', () => {
    it('accepts valid bank account payload', () => {
      req.body = {
        accountHolderName: 'Rahul Sharma',
        accountNumber: '123456789012',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
        isPrimary: true,
      };

      bankAccountValidator.validateCreateBankAccount(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedBody).toEqual({
        accountHolderName: 'Rahul Sharma',
        accountNumber: '123456789012',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
        isPrimary: true,
      });
    });

    it('rejects protected server fields with validation error', () => {
      req.body = {
        accountHolderName: 'Rahul Sharma',
        accountNumber: '123456789012',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
        verification_status: 'VERIFIED',
      };

      bankAccountValidator.validateCreateBankAccount(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'verification_status' }),
        ]),
      );
    });

    it('rejects invalid IFSC format', () => {
      req.body = {
        accountHolderName: 'Rahul Sharma',
        accountNumber: '123456789012',
        ifscCode: 'INVALID_IFSC',
        bankName: 'HDFC Bank',
      };

      bankAccountValidator.validateCreateBankAccount(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'ifscCode' }),
        ]),
      );
    });

    it('rejects account number with letters or invalid length', () => {
      req.body = {
        accountHolderName: 'Rahul Sharma',
        accountNumber: '12345ABC',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
      };

      bankAccountValidator.validateCreateBankAccount(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = next.mock.calls[0][0];
      expect(err.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'accountNumber' }),
        ]),
      );
    });
  });

  describe('validateBankAccountIdParam', () => {
    it('accepts a valid UUID string', () => {
      req.params = { bankAccountId: '123e4567-e89b-12d3-a456-426614174000' };
      bankAccountValidator.validateBankAccountIdParam(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('rejects non-UUID identifiers', () => {
      req.params = { bankAccountId: 'invalid-uuid' };
      bankAccountValidator.validateBankAccountIdParam(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });
});
