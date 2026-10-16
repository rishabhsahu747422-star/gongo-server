'use strict';

const adminAgreementRepository = require('../repositories/admin-agreement.repository');
const { ValidationError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class AdminAgreementService {
  async listAgreements(query = {}) {
    return adminAgreementRepository.listAgreements(query);
  }

  async getAgreementById(id) {
    if (!id) throw new ValidationError('Agreement ID is required');
    const agreement = await adminAgreementRepository.findAgreementById(id);
    if (!agreement) throw new NotFoundError('Rental agreement not found', ERROR_CODES.NOT_FOUND);
    return { agreement };
  }

  async getAgreementByBookingId(bookingId) {
    if (!bookingId) throw new ValidationError('Booking ID is required');
    const agreement = await adminAgreementRepository.findAgreementByBookingId(bookingId);
    if (!agreement) throw new NotFoundError('Rental agreement not found for this booking', ERROR_CODES.NOT_FOUND);
    return { agreement };
  }
}

module.exports = new AdminAgreementService();
