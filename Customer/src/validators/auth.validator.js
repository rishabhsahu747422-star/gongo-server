'use strict';

const { BadRequestError } = require('../errors');

/**
 * Validates request payload for POST /auth/send-otp
 */
function validateSendOtp(req, res, next) {
  const { phone, countryCode } = req.body || {};

  if (!phone || typeof phone !== 'string' || phone.trim() === '') {
    return next(new BadRequestError('Phone number is required', 'VALIDATION_ERROR'));
  }

  if (countryCode && (typeof countryCode !== 'string' || countryCode.trim() === '')) {
    return next(new BadRequestError('Country code must be a valid string', 'VALIDATION_ERROR'));
  }

  next();
}

/**
 * Validates request payload for POST /auth/verify-otp
 */
function validateVerifyOtp(req, res, next) {
  const { verificationId, otp } = req.body || {};

  if (!verificationId || typeof verificationId !== 'string' || verificationId.trim() === '') {
    return next(new BadRequestError('Verification ID is required', 'VALIDATION_ERROR'));
  }

  // Verification ID should be a UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(verificationId.trim())) {
    return next(new BadRequestError('Invalid verification ID format', 'VALIDATION_ERROR'));
  }

  if (!otp || typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
    return next(new BadRequestError('OTP must be a 6-digit numeric code', 'VALIDATION_ERROR'));
  }

  next();
}

/**
 * Validates request payload for POST /auth/refresh
 */
function validateRefresh(req, res, next) {
  const { token, refreshToken } = req.body || {};
  const candidate = token || refreshToken;

  if (!candidate || typeof candidate !== 'string' || candidate.trim() === '') {
    return next(new BadRequestError('Token is required for session refresh', 'VALIDATION_ERROR'));
  }

  next();
}

/**
 * Validates request payload for POST /auth/customer/send-otp
 */
function validateCustomerSendOtp(req, res, next) {
  const { phone } = req.body || {};

  if (!phone || typeof phone !== 'string' || phone.trim() === '') {
    return next(new BadRequestError('Phone number is required', 'VALIDATION_ERROR'));
  }

  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
    return next(new BadRequestError('Please enter a valid 10-digit Indian mobile number', 'INVALID_PHONE'));
  }

  next();
}

/**
 * Validates request payload for POST /auth/customer/verify-otp
 */
function validateCustomerVerifyOtp(req, res, next) {
  const { phone, otp } = req.body || {};

  if (!phone || typeof phone !== 'string' || phone.trim() === '') {
    return next(new BadRequestError('Phone number is required', 'VALIDATION_ERROR'));
  }

  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
    return next(new BadRequestError('Please enter a valid 10-digit Indian mobile number', 'INVALID_PHONE'));
  }

  if (!otp || typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
    const err = new BadRequestError('Invalid OTP', 'INVALID_OTP');
    err.data = { attemptsRemaining: 2 };
    return next(err);
  }

  next();
}

module.exports = {
  validateSendOtp,
  validateVerifyOtp,
  validateRefresh,
  validateCustomerSendOtp,
  validateCustomerVerifyOtp,
};
