'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { detectProtectedFields } = require('../middlewares/massAssignment');
const { validateWorkingHoursPayload } = require('../utils/working-hours');

const ALLOWED_PROFILE_FIELDS = Object.freeze([
  'name',
  'email',
  'profileImage',
  'profileImageUrl',
  'businessName',
  'businessAddress',
  'shopName',
  'shopAddress',
  'city',
  'area',
  'locality',
  'landmark',
  'latitude',
  'longitude',
  'operatingInfo',
  'openingTime',
  'closingTime',
  'isOpen24Hours',
  'workingHours',
  'locationAccuracy',
  'locationSource',
]);

const ALLOWED_SHOP_FIELDS = Object.freeze([
  'businessName',
  'businessAddress',
  'shopName',
  'shopAddress',
  'city',
  'area',
  'locality',
  'landmark',
  'latitude',
  'longitude',
  'operatingInfo',
  'openingTime',
  'closingTime',
  'isOpen24Hours',
  'workingHours',
  'locationAccuracy',
  'locationSource',
]);

const ALLOWED_KYC_DOC_TYPES = Object.freeze([
  'AADHAAR',
  'PAN',
  'GST',
  'SHOP_ESTABLISHMENT',
]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;

class PartnerValidator {
  /**
   * Validate PATCH /partner/profile payload.
   *
   * @param {object} body
   * @returns {object} Validated updates
   */
  validateProfileUpdate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    // Phone immutability check
    if (Object.prototype.hasOwnProperty.call(body, 'phone') || Object.prototype.hasOwnProperty.call(body, 'phoneNumber')) {
      throw new ValidationError(
        'Registered mobile number cannot be changed via profile update. Phone is tied to authentication identity.',
        [{ field: 'phone', message: 'Phone number is immutable' }],
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    // Mass assignment check
    const violations = detectProtectedFields(body);
    if (violations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${violations.join(', ')}] cannot be modified`,
        violations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    const errors = [];
    const sanitized = {};

    // Reject unknown/unsupported keys
    Object.keys(body).forEach((key) => {
      if (!ALLOWED_PROFILE_FIELDS.includes(key)) {
        errors.push({ field: key, message: `Field '${key}' is not allowed for profile update` });
      }
    });

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 150) {
        errors.push({ field: 'name', message: 'Partner name must be between 2 and 150 characters' });
      } else {
        sanitized.name = body.name.trim();
      }
    }

    if (body.email !== undefined && body.email !== null) {
      if (typeof body.email !== 'string' || !EMAIL_REGEX.test(body.email.trim())) {
        errors.push({ field: 'email', message: 'Invalid email address format' });
      } else {
        sanitized.email = body.email.trim().toLowerCase();
      }
    }

    const img = body.profileImage || body.profileImageUrl;
    if (img !== undefined && img !== null) {
      if (typeof img !== 'string' || img.trim().length > 500) {
        errors.push({ field: 'profileImage', message: 'Profile image must be a valid string URL up to 500 characters' });
      } else {
        sanitized.profileImageUrl = img.trim();
      }
    }

    // Business & location details
    // (supporting both canonical and frontend shopName/shopAddress aliases)
    const bName = body.businessName !== undefined ? body.businessName : body.shopName;
    if (bName !== undefined) {
      if (typeof bName !== 'string' || bName.trim().length < 2 || bName.trim().length > 200) {
        errors.push({ field: 'businessName', message: 'Business / Hub name must be between 2 and 200 characters' });
      } else {
        sanitized.businessName = bName.trim();
        sanitized.shopName = bName.trim();
      }
    }

    const bAddr = body.businessAddress !== undefined ? body.businessAddress : body.shopAddress;
    if (bAddr !== undefined) {
      if (typeof bAddr !== 'string' || bAddr.trim().length < 5 || bAddr.trim().length > 1000) {
        errors.push({ field: 'businessAddress', message: 'Business address must be between 5 and 1000 characters' });
      } else {
        sanitized.businessAddress = bAddr.trim();
        sanitized.shopAddress = bAddr.trim();
      }
    }

    if (body.city !== undefined) {
      if (typeof body.city !== 'string' || body.city.trim().length < 2 || body.city.trim().length > 100) {
        errors.push({ field: 'city', message: 'City must be between 2 and 100 characters' });
      } else {
        sanitized.city = body.city.trim();
      }
    }

    if (body.area !== undefined || body.locality !== undefined) {
      const rawArea = body.area !== undefined ? body.area : body.locality;
      if (rawArea === null || rawArea === '') {
        sanitized.area = null;
        sanitized.locality = null;
      } else if (typeof rawArea !== 'string' || rawArea.trim().length > 200) {
        errors.push({ field: 'area', message: 'Area must be a string up to 200 characters' });
      } else {
        const trimmedArea = rawArea.trim() || null;
        sanitized.area = trimmedArea;
        sanitized.locality = trimmedArea;
      }
    }

    if (body.landmark !== undefined) {
      if (body.landmark === null || body.landmark === '') {
        sanitized.landmark = null;
      } else if (typeof body.landmark !== 'string' || body.landmark.trim().length < 2 || body.landmark.trim().length > 200) {
        errors.push({ field: 'landmark', message: 'Landmark must be between 2 and 200 characters' });
      } else {
        sanitized.landmark = body.landmark.trim();
      }
    }

    if (body.operatingInfo !== undefined && body.operatingInfo !== null) {
      if (typeof body.operatingInfo !== 'string' || body.operatingInfo.trim().length > 200) {
        errors.push({ field: 'operatingInfo', message: 'Operating info must be a string up to 200 characters' });
      } else {
        sanitized.operatingInfo = body.operatingInfo.trim();
      }
    }

    validateWorkingHoursPayload(body, errors, sanitized);

    if (body.latitude !== undefined && body.latitude !== null) {
      const latNum = Number(body.latitude);
      if (Number.isNaN(latNum) || latNum < -90 || latNum > 90) {
        errors.push({ field: 'latitude', message: 'Latitude must be a valid number between -90 and 90 degrees' });
      } else {
        sanitized.latitude = latNum;
      }
    } else if (body.latitude === null) {
      sanitized.latitude = null;
    }

    if (body.longitude !== undefined && body.longitude !== null) {
      const lngNum = Number(body.longitude);
      if (Number.isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
        errors.push({ field: 'longitude', message: 'Longitude must be a valid number between -180 and 180 degrees' });
      } else {
        sanitized.longitude = lngNum;
      }
    } else if (body.longitude === null) {
      sanitized.longitude = null;
    }

    if (body.locationAccuracy !== undefined && body.locationAccuracy !== null) {
      const accNum = Number(body.locationAccuracy);
      if (Number.isNaN(accNum) || accNum < 0) {
        errors.push({ field: 'locationAccuracy', message: 'Location accuracy must be a non-negative number in meters' });
      } else {
        sanitized.locationAccuracy = accNum;
      }
    } else if (body.locationAccuracy === null) {
      sanitized.locationAccuracy = null;
    }

    if (body.locationSource !== undefined && body.locationSource !== null) {
      const src = String(body.locationSource).trim().toUpperCase();
      if (!['GPS', 'MANUAL_PIN'].includes(src)) {
        errors.push({ field: 'locationSource', message: 'Location source must be either GPS or MANUAL_PIN' });
      } else {
        sanitized.locationSource = src;
      }
    } else if (body.locationSource === null) {
      sanitized.locationSource = null;
    }

    if (errors.length > 0) {
      throw new ValidationError(errors[0].message, errors);
    }

    if (Object.keys(sanitized).length === 0) {
      throw new ValidationError('At least one editable profile field must be provided');
    }

    return sanitized;
  }

  /**
   * Validate PATCH /partner/shop payload.
   *
   * @param {object} body
   * @returns {object} Validated shop updates
   */
  validateShopUpdate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    const violations = detectProtectedFields(body);
    if (violations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${violations.join(', ')}] cannot be modified`,
        violations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    const errors = [];
    const sanitized = {};

    Object.keys(body).forEach((key) => {
      if (!ALLOWED_SHOP_FIELDS.includes(key)) {
        errors.push({ field: key, message: `Field '${key}' is not allowed for shop update` });
      }
    });

    const sName = body.shopName !== undefined ? body.shopName : body.businessName;
    if (sName !== undefined) {
      if (typeof sName !== 'string' || sName.trim().length < 2 || sName.trim().length > 200) {
        errors.push({ field: 'shopName', message: 'Shop name must be between 2 and 200 characters' });
      } else {
        sanitized.shopName = sName.trim();
      }
    }

    const sAddr = body.shopAddress !== undefined ? body.shopAddress : body.businessAddress;
    if (sAddr !== undefined) {
      if (typeof sAddr !== 'string' || sAddr.trim().length < 5 || sAddr.trim().length > 1000) {
        errors.push({ field: 'shopAddress', message: 'Shop address must be between 5 and 1000 characters' });
      } else {
        sanitized.shopAddress = sAddr.trim();
      }
    }

    if (body.city !== undefined) {
      if (typeof body.city !== 'string' || body.city.trim().length < 2 || body.city.trim().length > 100) {
        errors.push({ field: 'city', message: 'City must be between 2 and 100 characters' });
      } else {
        sanitized.city = body.city.trim();
      }
    }

    if (body.area !== undefined || body.locality !== undefined) {
      const rawArea = body.area !== undefined ? body.area : body.locality;
      if (rawArea === null || rawArea === '') {
        sanitized.area = null;
        sanitized.locality = null;
      } else if (typeof rawArea !== 'string' || rawArea.trim().length > 200) {
        errors.push({ field: 'area', message: 'Area must be a string up to 200 characters' });
      } else {
        const trimmedArea = rawArea.trim() || null;
        sanitized.area = trimmedArea;
        sanitized.locality = trimmedArea;
      }
    }

    if (body.landmark !== undefined) {
      if (body.landmark === null || body.landmark === '') {
        sanitized.landmark = null;
      } else if (typeof body.landmark !== 'string' || body.landmark.trim().length < 2 || body.landmark.trim().length > 200) {
        errors.push({ field: 'landmark', message: 'Landmark must be between 2 and 200 characters' });
      } else {
        sanitized.landmark = body.landmark.trim();
      }
    }

    if (body.operatingInfo !== undefined && body.operatingInfo !== null) {
      if (typeof body.operatingInfo !== 'string' || body.operatingInfo.trim().length > 200) {
        errors.push({ field: 'operatingInfo', message: 'Operating info must be a string up to 200 characters' });
      } else {
        sanitized.operatingInfo = body.operatingInfo.trim();
      }
    }

    validateWorkingHoursPayload(body, errors, sanitized);

    // GPS Latitude validation (-90 <= lat <= 90)
    if (body.latitude !== undefined && body.latitude !== null) {
      const latNum = Number(body.latitude);
      if (Number.isNaN(latNum) || latNum < -90 || latNum > 90) {
        errors.push({ field: 'latitude', message: 'Latitude must be a valid number between -90 and 90 degrees' });
      } else {
        sanitized.latitude = latNum;
      }
    } else if (body.latitude === null) {
      sanitized.latitude = null;
    }

    // GPS Longitude validation (-180 <= lng <= 180)
    if (body.longitude !== undefined && body.longitude !== null) {
      const lngNum = Number(body.longitude);
      if (Number.isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
        errors.push({ field: 'longitude', message: 'Longitude must be a valid number between -180 and 180 degrees' });
      } else {
        sanitized.longitude = lngNum;
      }
    } else if (body.longitude === null) {
      sanitized.longitude = null;
    }

    if (body.locationAccuracy !== undefined && body.locationAccuracy !== null) {
      const accNum = Number(body.locationAccuracy);
      if (Number.isNaN(accNum) || accNum < 0) {
        errors.push({ field: 'locationAccuracy', message: 'Location accuracy must be a non-negative number in meters' });
      } else {
        sanitized.locationAccuracy = accNum;
      }
    } else if (body.locationAccuracy === null) {
      sanitized.locationAccuracy = null;
    }

    if (body.locationSource !== undefined && body.locationSource !== null) {
      const src = String(body.locationSource).trim().toUpperCase();
      if (!['GPS', 'MANUAL_PIN'].includes(src)) {
        errors.push({ field: 'locationSource', message: 'Location source must be either GPS or MANUAL_PIN' });
      } else {
        sanitized.locationSource = src;
      }
    } else if (body.locationSource === null) {
      sanitized.locationSource = null;
    }

    if (errors.length > 0) {
      throw new ValidationError(errors[0].message, errors);
    }

    if (Object.keys(sanitized).length === 0) {
      throw new ValidationError('At least one editable shop field must be provided');
    }

    return sanitized;
  }

  /**
   * Validate POST /partner/kyc/documents payload.
   *
   * @param {object} body
   * @returns {object} Validated KYC document submission data
   */
  validateKycDocument(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    // Detect attempts to set verification status or storage internals
    const violations = detectProtectedFields(body);
    if (violations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${violations.join(', ')}] cannot be modified`,
        violations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    const errors = [];

    let normalizedType = null;
    if (!body.documentType) {
      errors.push({ field: 'documentType', message: 'documentType is required' });
    } else {
      let normType = String(body.documentType).trim().toUpperCase();
      if (normType === 'GSTIN') {
        normType = 'GST';
      }
      if (!ALLOWED_KYC_DOC_TYPES.includes(normType)) {
        errors.push({
          field: 'documentType',
          message: `documentType must be one of: [${ALLOWED_KYC_DOC_TYPES.join(', ')}]`,
        });
      } else {
        normalizedType = normType;
      }
    }

    const sanitized = {
      documentType: normalizedType,
    };

    if (body.documentNumber !== undefined && body.documentNumber !== null) {
      const docNum = String(body.documentNumber).trim();
      if (docNum.length === 0 || docNum.length > 100) {
        errors.push({ field: 'documentNumber', message: 'documentNumber must be between 1 and 100 characters' });
      } else {
        // Document-type specific format checks
        if (sanitized.documentType === 'AADHAAR') {
          const digitsOnly = docNum.replace(/[^0-9]/g, '');
          if (digitsOnly.length !== 12) {
            errors.push({ field: 'documentNumber', message: 'Aadhaar card number must contain exactly 12 digits' });
          }
        } else if (sanitized.documentType === 'PAN') {
          if (!PAN_REGEX.test(docNum)) {
            errors.push({ field: 'documentNumber', message: 'PAN number must follow standard format (e.g. ABCDE1234F)' });
          }
        }
        sanitized.documentNumber = docNum;
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(errors[0].message, errors);
    }

    return sanitized;
  }
}

module.exports = new PartnerValidator();
