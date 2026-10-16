'use strict';

const bankAccountService = require('../services/bank-account.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

class BankAccountController {
  /**
   * POST /api/v1/partner/bank-account
   * Add a new partner bank account.
   */
  async addBankAccount(req, res, next) {
    try {
      const { partnerId } = req.user;
      const account = await bankAccountService.addBankAccount(partnerId, req.validatedBody);
      return sendSuccess(res, account, HTTP_STATUS.CREATED);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/bank-account
   * List all bank accounts for the authenticated partner.
   */
  async getBankAccounts(req, res, next) {
    try {
      const { partnerId } = req.user;
      const accounts = await bankAccountService.getBankAccounts(partnerId);
      return sendSuccess(res, accounts, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/bank-account/:bankAccountId
   * Get single bank account for the authenticated partner.
   */
  async getBankAccountById(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { bankAccountId } = req.params;
      const account = await bankAccountService.getBankAccountById(partnerId, bankAccountId);
      return sendSuccess(res, account, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * DELETE /api/v1/partner/bank-account/:bankAccountId
   * Delete a partner bank account.
   */
  async deleteBankAccount(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { bankAccountId } = req.params;
      const result = await bankAccountService.deleteBankAccount(partnerId, bankAccountId);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new BankAccountController();
