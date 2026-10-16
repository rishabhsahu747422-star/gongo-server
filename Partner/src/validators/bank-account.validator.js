'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { isValidUuid } = require('./index');

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NUMBER_REGEX = /^\d{9,18}$/;

class BankAccountValidator {
  /**
   * Validates creation of a partner bank account.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateCreateBankAccount(req, res, next) {
    try {
      const body = req.body || {};
      const errors = [];

      // Protected fields rejection
      const protectedFields = [
        'id', 'partner_id', 'partnerId',
        'account_number_masked', 'accountNumberMasked',
        'account_number_encrypted', 'accountNumberEncrypted',
        'verification_status', 'verificationStatus',
        'created_at', 'createdAt', 'updated_at', 'updatedAt',
      ];
      protectedFields.forEach((field) => {
        if (body[field] !== undefined) {
          errors.push({
            field,
            message: `Field '${field}' is server-managed and cannot be supplied`,
          });
        }
      });

      // accountHolderName
      if (!body.accountHolderName || typeof body.accountHolderName !== 'string') {
        errors.push({
          field: 'accountHolderName',
          message: 'accountHolderName is required and must be a string',
        });
      } else if (
        body.accountHolderName.trim().length < 2
        || body.accountHolderName.trim().length > 150
      ) {
        errors.push({
          field: 'accountHolderName',
          message: 'accountHolderName must be between 2 and 150 characters',
        });
      }

      // accountNumber
      if (!body.accountNumber || typeof body.accountNumber !== 'string') {
        errors.push({
          field: 'accountNumber',
          message: 'accountNumber is required and must be a numeric string between 9 and 18 digits',
        });
      } else if (!ACCOUNT_NUMBER_REGEX.test(body.accountNumber.trim())) {
        errors.push({
          field: 'accountNumber',
          message: 'accountNumber must contain only digits and be between 9 and 18 digits long',
        });
      }

      // ifscCode
      if (!body.ifscCode || typeof body.ifscCode !== 'string') {
        errors.push({
          field: 'ifscCode',
          message: 'ifscCode is required and must be an 11-character alphanumeric code',
        });
      } else {
        const normIfsc = body.ifscCode.trim().toUpperCase();
        if (!IFSC_REGEX.test(normIfsc)) {
          errors.push({
            field: 'ifscCode',
            message: 'ifscCode format is invalid (expected 4 letters, 0, then 6 alphanumeric characters)',
          });
        }
      }

      // bankName
      if (!body.bankName || typeof body.bankName !== 'string') {
        errors.push({
          field: 'bankName',
          message: 'bankName is required and must be a string',
        });
      } else if (body.bankName.trim().length < 2 || body.bankName.trim().length > 150) {
        errors.push({
          field: 'bankName',
          message: 'bankName must be between 2 and 150 characters',
        });
      }

      // isPrimary
      if (body.isPrimary !== undefined && typeof body.isPrimary !== 'boolean') {
        errors.push({
          field: 'isPrimary',
          message: 'isPrimary must be a boolean',
        });
      }

      if (errors.length > 0) {
        throw new ValidationError('Validation failed for bank account creation', errors);
      }

      req.validatedBody = {
        accountHolderName: body.accountHolderName.trim(),
        accountNumber: body.accountNumber.trim(),
        ifscCode: body.ifscCode.trim().toUpperCase(),
        bankName: body.bankName.trim(),
        isPrimary: body.isPrimary !== undefined ? body.isPrimary : true,
      };

      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Validates :bankAccountId UUID path parameter.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  validateBankAccountIdParam(req, res, next) {
    try {
      const { bankAccountId } = req.params;
      if (!isValidUuid(bankAccountId)) {
        throw new ValidationError('Invalid bank account ID format. Must be a valid UUID.', [
          { field: 'bankAccountId', message: 'bankAccountId must be a valid UUID' },
        ], ERROR_CODES.INVALID_UUID);
      }
      next();
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new BankAccountValidator();
