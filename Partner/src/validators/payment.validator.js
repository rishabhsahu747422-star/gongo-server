'use strict';

const { BadRequestError } = require('../errors');
const { PAYMENT_ERROR_CODES } = require('../constants/payment');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Payment request and webhook validator.
 */
class PaymentValidator {
  /**
   * Validates bookingId parameter format.
   *
   * @param {string} bookingId
   * @returns {string}
   */
  validateBookingId(bookingId) {
    if (!bookingId || typeof bookingId !== 'string' || !UUID_REGEX.test(bookingId)) {
      throw new BadRequestError('Invalid booking identifier format', PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND);
    }
    return bookingId;
  }

  /**
   * Express middleware validating Cashfree webhook headers.
   */
  validateWebhookHeaders(req, res, next) {
    const timestamp = req.headers['x-webhook-timestamp'] || req.headers['x-timestamp'];
    const signature = req.headers['x-webhook-signature'] || req.headers['x-signature'];

    if (!timestamp || !signature) {
      return next(
        new BadRequestError(
          'Missing Cashfree webhook authentication headers',
          PAYMENT_ERROR_CODES.INVALID_WEBHOOK_SIGNATURE,
        ),
      );
    }

    return next();
  }
}

module.exports = new PaymentValidator();
