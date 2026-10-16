'use strict';

const paymentValidator = require('../../src/validators/payment.validator');
const { BadRequestError } = require('../../src/errors');

describe('Unit: PaymentValidator', () => {
  describe('validateBookingId', () => {
    it('accepts valid UUID string', () => {
      const validUuid = '11111111-2222-4333-8444-555555555555';
      expect(paymentValidator.validateBookingId(validUuid)).toBe(validUuid);
    });

    it('rejects invalid UUID or malformed identifier', () => {
      expect(() => paymentValidator.validateBookingId('not-a-uuid')).toThrow(BadRequestError);
      expect(() => paymentValidator.validateBookingId(null)).toThrow(BadRequestError);
      expect(() => paymentValidator.validateBookingId(123)).toThrow(BadRequestError);
    });
  });

  describe('validateWebhookHeaders', () => {
    it('calls next() without error when timestamp and signature are present', () => {
      const req = {
        headers: {
          'x-webhook-timestamp': '1700000000',
          'x-webhook-signature': 'valid_sig_base64==',
        },
      };
      const next = jest.fn();

      paymentValidator.validateWebhookHeaders(req, {}, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('passes BadRequestError to next() when timestamp header is missing', () => {
      const req = {
        headers: {
          'x-webhook-signature': 'valid_sig_base64==',
        },
      };
      const next = jest.fn();

      paymentValidator.validateWebhookHeaders(req, {}, next);
      expect(next).toHaveBeenCalledWith(expect.any(BadRequestError));
    });

    it('passes BadRequestError to next() when signature header is missing', () => {
      const req = {
        headers: {
          'x-webhook-timestamp': '1700000000',
        },
      };
      const next = jest.fn();

      paymentValidator.validateWebhookHeaders(req, {}, next);
      expect(next).toHaveBeenCalledWith(expect.any(BadRequestError));
    });
  });
});
