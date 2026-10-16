'use strict';

const adminAgreementService = require('../services/admin-agreement.service');
const { sendSuccess } = require('../utils/response');

class AdminAgreementController {
  async listAgreements(req, res, next) {
    try {
      const data = await adminAgreementService.listAgreements(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getAgreementById(req, res, next) {
    try {
      const data = await adminAgreementService.getAgreementById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getAgreementByBookingId(req, res, next) {
    try {
      const data = await adminAgreementService.getAgreementByBookingId(req.params.bookingId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminAgreementController();
