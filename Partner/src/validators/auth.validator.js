'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { validateWorkingHoursPayload } = require('../utils/working-hours');

const PHONE_REGEX = /^[6-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates check-phone request body.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validateCheckPhone(req, res, next) {
  const rawPhone = (req.body && (req.body.phone || req.body.phoneNumber)) || null;

  if (!rawPhone) {
    return next(new ValidationError('Mobile number is required', [{
      field: 'phone',
      message: 'Mobile number is required',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  const cleanPhone = String(rawPhone).replace(/[^0-9]/g, '').slice(-10);
  if (!PHONE_REGEX.test(cleanPhone)) {
    return next(new ValidationError('Please provide a valid 10-digit Indian mobile number', [{
      field: 'phone',
      message: 'Please provide a valid 10-digit Indian mobile number',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  req.body.phone = cleanPhone;
  return next();
}

/**
 * Validates partner registration request body.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validateRegister(req, res, next) {
  const { body } = req;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(
      new ValidationError('Invalid registration payload', null, ERROR_CODES.VALIDATION_ERROR),
    );
  }

  const { name, shopName, city, shopAddress, email, landmark } = body;

  // 1. Validate name
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
    return next(new ValidationError('Partner name must be between 2 and 100 characters', [{
      field: 'name',
      message: 'Partner name must be between 2 and 100 characters',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  // 2. Validate shopName
  if (!shopName || typeof shopName !== 'string' || shopName.trim().length < 2 || shopName.trim().length > 150) {
    return next(new ValidationError('Shop / business name must be between 2 and 150 characters', [{
      field: 'shopName',
      message: 'Shop / business name must be between 2 and 150 characters',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  // 3. Validate city
  if (!city || typeof city !== 'string' || city.trim().length < 2 || city.trim().length > 100) {
    return next(new ValidationError('City must be between 2 and 100 characters', [{
      field: 'city',
      message: 'City must be between 2 and 100 characters',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  // 4. Validate mandatory landmark
  if (!landmark || typeof landmark !== 'string' || landmark.trim().length === 0) {
    return next(new ValidationError('Landmark is required', [{
      field: 'landmark',
      message: 'Landmark is required',
    }], ERROR_CODES.VALIDATION_ERROR));
  }
  if (landmark.trim().length < 2 || landmark.trim().length > 200) {
    return next(new ValidationError('Landmark must be between 2 and 200 characters', [{
      field: 'landmark',
      message: 'Landmark must be between 2 and 200 characters',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  // 5. Validate optional shopAddress
  if (shopAddress !== undefined && shopAddress !== null) {
    if (typeof shopAddress !== 'string' || shopAddress.trim().length > 300) {
      return next(new ValidationError('Shop address cannot exceed 300 characters', [{
        field: 'shopAddress',
        message: 'Shop address cannot exceed 300 characters',
      }], ERROR_CODES.VALIDATION_ERROR));
    }
  }

  // 6. Validate optional area / locality
  const rawArea = body.area !== undefined ? body.area : body.locality;
  if (rawArea !== undefined && rawArea !== null && rawArea !== '') {
    if (typeof rawArea !== 'string' || rawArea.trim().length > 200) {
      return next(new ValidationError('Area cannot exceed 200 characters', [{
        field: 'area',
        message: 'Area cannot exceed 200 characters',
      }], ERROR_CODES.VALIDATION_ERROR));
    }
    const trimmedArea = rawArea.trim() || null;
    req.body.area = trimmedArea;
    req.body.locality = trimmedArea;
  } else if (rawArea === '' || rawArea === null) {
    req.body.area = null;
    req.body.locality = null;
  }

  // 7. Validate optional email
  if (email) {
    if (typeof email !== 'string' || !EMAIL_REGEX.test(email.trim()) || email.trim().length > 255) {
      return next(new ValidationError('Please provide a valid email address', [{
        field: 'email',
        message: 'Please provide a valid email address',
      }], ERROR_CODES.VALIDATION_ERROR));
    }
  }

  // 8. Validate optional GPS coordinates & location metadata
  if (body.latitude !== undefined && body.latitude !== null && body.latitude !== '') {
    const latNum = Number(body.latitude);
    if (Number.isNaN(latNum) || latNum < -90 || latNum > 90) {
      return next(new ValidationError('Latitude must be a valid number between -90 and 90 degrees', [{
        field: 'latitude',
        message: 'Latitude must be a valid number between -90 and 90 degrees',
      }], ERROR_CODES.VALIDATION_ERROR));
    }
    req.body.latitude = latNum;
  } else if (body.latitude === null || body.latitude === '') {
    req.body.latitude = null;
  }

  if (body.longitude !== undefined && body.longitude !== null && body.longitude !== '') {
    const lngNum = Number(body.longitude);
    if (Number.isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
      return next(new ValidationError('Longitude must be a valid number between -180 and 180 degrees', [{
        field: 'longitude',
        message: 'Longitude must be a valid number between -180 and 180 degrees',
      }], ERROR_CODES.VALIDATION_ERROR));
    }
    req.body.longitude = lngNum;
  } else if (body.longitude === null || body.longitude === '') {
    req.body.longitude = null;
  }

  if (body.locationAccuracy !== undefined && body.locationAccuracy !== null && body.locationAccuracy !== '') {
    const accNum = Number(body.locationAccuracy);
    if (Number.isNaN(accNum) || accNum < 0) {
      return next(new ValidationError('Location accuracy must be a non-negative number in meters', [{
        field: 'locationAccuracy',
        message: 'Location accuracy must be a non-negative number in meters',
      }], ERROR_CODES.VALIDATION_ERROR));
    }
    req.body.locationAccuracy = accNum;
  } else if (body.locationAccuracy === null || body.locationAccuracy === '') {
    req.body.locationAccuracy = null;
  }

  if (body.locationSource !== undefined && body.locationSource !== null && body.locationSource !== '') {
    const src = String(body.locationSource).trim().toUpperCase();
    if (!['GPS', 'MANUAL_PIN'].includes(src)) {
      return next(new ValidationError('Location source must be either GPS or MANUAL_PIN', [{
        field: 'locationSource',
        message: 'Location source must be either GPS or MANUAL_PIN',
      }], ERROR_CODES.VALIDATION_ERROR));
    }
    req.body.locationSource = src;
  } else if (body.locationSource === null || body.locationSource === '') {
    req.body.locationSource = null;
  }

  // 9. Validate optional working hours
  const whErrors = [];
  const whSanitized = {};
  validateWorkingHoursPayload(body, whErrors, whSanitized);
  if (whErrors.length > 0) {
    return next(new ValidationError(whErrors[0].message, whErrors, ERROR_CODES.VALIDATION_ERROR));
  }
  Object.assign(req.body, whSanitized);

  // 10. Validate mandatory terms & conditions acceptance
  const termsAccepted = body.termsAccepted === true
    || body.terms_accepted === true
    || body.termsConsent === true
    || body.terms_consent === true;
  if (!termsAccepted) {
    return next(new ValidationError('You must read and agree to the GONGO Terms & Conditions to register', [{
      field: 'termsAccepted',
      message: 'You must read and agree to the GONGO Terms & Conditions to register',
    }], ERROR_CODES.VALIDATION_ERROR));
  }
  req.body.termsAccepted = true;

  return next();
}

/**
 * Validates partner send-otp request body.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validatePartnerSendOtp(req, res, next) {
  const rawPhone = (req.body && (req.body.phone || req.body.phoneNumber)) || null;

  if (!rawPhone || typeof rawPhone !== 'string' || rawPhone.trim() === '') {
    return next(new ValidationError('Mobile number is required', [{
      field: 'phone',
      message: 'Mobile number is required',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  const cleanPhone = String(rawPhone).replace(/[^0-9]/g, '').slice(-10);
  if (!PHONE_REGEX.test(cleanPhone)) {
    return next(new ValidationError('Please provide a valid 10-digit Indian mobile number', [{
      field: 'phone',
      message: 'Please provide a valid 10-digit Indian mobile number',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  req.body.phone = cleanPhone;
  return next();
}

/**
 * Validates partner verify-otp request body.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validatePartnerVerifyOtp(req, res, next) {
  const rawPhone = (req.body && (req.body.phone || req.body.phoneNumber)) || null;
  const rawOtp = req.body && req.body.otp;

  if (!rawPhone || typeof rawPhone !== 'string' || rawPhone.trim() === '') {
    return next(new ValidationError('Mobile number is required', [{
      field: 'phone',
      message: 'Mobile number is required',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  const cleanPhone = String(rawPhone).replace(/[^0-9]/g, '').slice(-10);
  if (!PHONE_REGEX.test(cleanPhone)) {
    return next(new ValidationError('Please provide a valid 10-digit Indian mobile number', [{
      field: 'phone',
      message: 'Please provide a valid 10-digit Indian mobile number',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  const cleanOtp = String(rawOtp || '').trim();
  if (!cleanOtp || !/^\d{6}$/.test(cleanOtp)) {
    return next(new ValidationError('Verification code must be exactly 6 digits', [{
      field: 'otp',
      message: 'Verification code must be exactly 6 digits',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  req.body.phone = cleanPhone;
  req.body.otp = cleanOtp;
  if (req.body.requireExisting !== undefined) {
    req.body.requireExisting = req.body.requireExisting === true || req.body.requireExisting === 'true';
  }
  return next();
}

/**
 * Validates partner dev-login request body.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validatePartnerDevLogin(req, res, next) {
  const { phone, devCode } = req.body || {};

  if (phone !== undefined && (typeof phone !== 'string' || phone.trim() === '')) {
    return next(new ValidationError('Phone must be a valid string', [{
      field: 'phone',
      message: 'Phone must be a valid string',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  if (devCode !== undefined && (typeof devCode !== 'string' || devCode.trim() === '')) {
    return next(new ValidationError('devCode must be a valid string', [{
      field: 'devCode',
      message: 'devCode must be a valid string',
    }], ERROR_CODES.VALIDATION_ERROR));
  }

  return next();
}

module.exports = {
  validateCheckPhone,
  validateRegister,
  validatePartnerSendOtp,
  validatePartnerVerifyOtp,
  validatePartnerDevLogin,
};
