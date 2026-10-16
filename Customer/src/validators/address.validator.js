'use strict';

const { BadRequestError } = require('../errors');

/**
 * Strict allowlist of fields a customer may supply when creating an address.
 * Used to reject unexpected/forbidden fields early (anti-mass-assignment).
 */
const ALLOWED_CREATE_FIELDS = new Set([
  'label',
  'fullAddress',
  'addressLine1',
  'addressLine2',
  'landmark',
  'city',
  'state',
  'postalCode',
  'countryCode',
  'latitude',
  'longitude',
  'isDefault',
]);

/**
 * Fields the client is never allowed to supply (ownership, identity, timestamps).
 * Enforced separately for clear error messages.
 */
const FORBIDDEN_FIELDS = new Set([
  'id',
  'userId',
  'user_id',
  'customerId',
  'customer_id',
  'role',
  'status',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
]);

/** Valid address label values */
const VALID_LABELS = new Set(['HOME', 'WORK', 'OTHER']);

/**
 * Validates coordinate values: must be a finite number within the allowed range.
 *
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @returns {boolean}
 */
function isValidCoordinate(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

/**
 * Middleware: validate POST /api/v1/customers/me/addresses request body.
 *
 * Required fields: label, fullAddress
 * Optional fields: addressLine1, addressLine2, landmark, city, state,
 *                  postalCode, countryCode, latitude, longitude, isDefault
 *
 * Coordinate validation: if one of latitude/longitude is provided,
 * both must be provided and valid (pair constraint).
 */
function validateCreateAddress(req, res, next) {
  const { body } = req;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(new BadRequestError('Request body must be a valid JSON object', 'VALIDATION_ERROR'));
  }

  const providedKeys = Object.keys(body);

  // Reject forbidden fields first
  const forbidden = providedKeys.filter((k) => FORBIDDEN_FIELDS.has(k));
  if (forbidden.length > 0) {
    return next(new BadRequestError(
      `Field(s) not allowed in request: ${forbidden.join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  // Reject unexpected fields
  const unexpected = providedKeys.filter((k) => !ALLOWED_CREATE_FIELDS.has(k));
  if (unexpected.length > 0) {
    return next(new BadRequestError(
      `Unexpected field(s) in request: ${unexpected.join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  // label — required, must be HOME | WORK | OTHER
  const { label } = body;
  if (!label || typeof label !== 'string') {
    return next(new BadRequestError('label is required and must be a string', 'VALIDATION_ERROR'));
  }
  const normLabel = label.trim().toUpperCase();
  if (!VALID_LABELS.has(normLabel)) {
    return next(new BadRequestError(
      `label must be one of: ${[...VALID_LABELS].join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }
  req.body.label = normLabel;

  // fullAddress — required, 5–500 chars
  const { fullAddress } = body;
  if (!fullAddress || typeof fullAddress !== 'string') {
    return next(new BadRequestError(
      'fullAddress is required and must be a string',
      'VALIDATION_ERROR',
    ));
  }
  const normFull = fullAddress.trim();
  if (normFull.length < 5 || normFull.length > 500) {
    return next(new BadRequestError(
      'fullAddress must be between 5 and 500 characters',
      'VALIDATION_ERROR',
    ));
  }
  req.body.fullAddress = normFull;

  // Validate optional string fields
  const stringFields = [
    { key: 'addressLine1', max: 255 },
    { key: 'addressLine2', max: 255 },
    { key: 'landmark', max: 100 },
    { key: 'city', max: 100 },
    { key: 'state', max: 100 },
    { key: 'postalCode', max: 20 },
    { key: 'countryCode', max: 5 },
  ];

  const stringFieldError = stringFields.reduce((err, { key, max }) => {
    if (err) return err;
    if (!Object.prototype.hasOwnProperty.call(body, key)) return null;
    const val = body[key];
    if (typeof val !== 'string') return new BadRequestError(`${key} must be a string`, 'VALIDATION_ERROR');
    const trimmed = val.trim();
    if (trimmed.length === 0 || trimmed.length > max) {
      return new BadRequestError(`${key} must be between 1 and ${max} characters`, 'VALIDATION_ERROR');
    }
    req.body[key] = trimmed;
    return null;
  }, null);

  if (stringFieldError) return next(stringFieldError);

  // Coordinate pair validation
  const hasLat = Object.prototype.hasOwnProperty.call(body, 'latitude');
  const hasLon = Object.prototype.hasOwnProperty.call(body, 'longitude');

  if (hasLat !== hasLon) {
    return next(new BadRequestError(
      'latitude and longitude must both be provided together or both omitted',
      'VALIDATION_ERROR',
    ));
  }

  if (hasLat) {
    if (!isValidCoordinate(body.latitude, -90, 90)) {
      return next(new BadRequestError(
        'latitude must be a number between -90 and 90',
        'VALIDATION_ERROR',
      ));
    }
    if (!isValidCoordinate(body.longitude, -180, 180)) {
      return next(new BadRequestError(
        'longitude must be a number between -180 and 180',
        'VALIDATION_ERROR',
      ));
    }
    req.body.latitude = Number(body.latitude);
    req.body.longitude = Number(body.longitude);
  }

  // isDefault — optional boolean
  if (Object.prototype.hasOwnProperty.call(body, 'isDefault')) {
    if (typeof body.isDefault !== 'boolean') {
      return next(new BadRequestError('isDefault must be a boolean', 'VALIDATION_ERROR'));
    }
  }

  next();
}

/**
 * Middleware: validate PATCH /api/v1/customers/me/addresses/:id request body.
 *
 * Same rules as create except:
 * - At least one field must be present (cannot send empty patch)
 * - No required fields — any subset of allowed fields is valid
 * - isDefault is NOT allowed here (use the dedicated /default endpoint)
 */
const ALLOWED_UPDATE_FIELDS = new Set([
  'label',
  'fullAddress',
  'addressLine1',
  'addressLine2',
  'landmark',
  'city',
  'state',
  'postalCode',
  'countryCode',
  'latitude',
  'longitude',
]);

function validateUpdateAddress(req, res, next) {
  const { body } = req;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(new BadRequestError('Request body must be a valid JSON object', 'VALIDATION_ERROR'));
  }

  const providedKeys = Object.keys(body);

  if (providedKeys.length === 0) {
    return next(new BadRequestError(
      'At least one field must be provided for update',
      'INVALID_UPDATE_PAYLOAD',
    ));
  }

  // Reject forbidden fields
  const forbidden = providedKeys.filter((k) => FORBIDDEN_FIELDS.has(k));
  if (forbidden.length > 0) {
    return next(new BadRequestError(
      `Field(s) not allowed in request: ${forbidden.join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  // Reject unexpected fields (isDefault also not allowed in update)
  const unexpected = providedKeys.filter((k) => !ALLOWED_UPDATE_FIELDS.has(k));
  if (unexpected.length > 0) {
    return next(new BadRequestError(
      `Unexpected field(s) in request: ${unexpected.join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  // label
  if (Object.prototype.hasOwnProperty.call(body, 'label')) {
    const { label } = body;
    if (typeof label !== 'string') {
      return next(new BadRequestError('label must be a string', 'VALIDATION_ERROR'));
    }
    const normLabel = label.trim().toUpperCase();
    if (!VALID_LABELS.has(normLabel)) {
      return next(new BadRequestError(
        `label must be one of: ${[...VALID_LABELS].join(', ')}`,
        'VALIDATION_ERROR',
      ));
    }
    req.body.label = normLabel;
  }

  // fullAddress
  if (Object.prototype.hasOwnProperty.call(body, 'fullAddress')) {
    const { fullAddress } = body;
    if (typeof fullAddress !== 'string') {
      return next(new BadRequestError('fullAddress must be a string', 'VALIDATION_ERROR'));
    }
    const normFull = fullAddress.trim();
    if (normFull.length < 5 || normFull.length > 500) {
      return next(new BadRequestError(
        'fullAddress must be between 5 and 500 characters',
        'VALIDATION_ERROR',
      ));
    }
    req.body.fullAddress = normFull;
  }

  // Optional string fields
  const stringFields = [
    { key: 'addressLine1', max: 255 },
    { key: 'addressLine2', max: 255 },
    { key: 'landmark', max: 100 },
    { key: 'city', max: 100 },
    { key: 'state', max: 100 },
    { key: 'postalCode', max: 20 },
    { key: 'countryCode', max: 5 },
  ];

  const updateStringFieldError = stringFields.reduce((err, { key, max }) => {
    if (err) return err;
    if (!Object.prototype.hasOwnProperty.call(body, key)) return null;
    const val = body[key];
    if (typeof val !== 'string') return new BadRequestError(`${key} must be a string`, 'VALIDATION_ERROR');
    const trimmed = val.trim();
    if (trimmed.length === 0 || trimmed.length > max) {
      return new BadRequestError(`${key} must be between 1 and ${max} characters`, 'VALIDATION_ERROR');
    }
    req.body[key] = trimmed;
    return null;
  }, null);

  if (updateStringFieldError) return next(updateStringFieldError);

  // Coordinate pair validation
  const hasLat = Object.prototype.hasOwnProperty.call(body, 'latitude');
  const hasLon = Object.prototype.hasOwnProperty.call(body, 'longitude');

  if (hasLat !== hasLon) {
    return next(new BadRequestError(
      'latitude and longitude must both be provided together or both omitted',
      'VALIDATION_ERROR',
    ));
  }

  if (hasLat) {
    if (!isValidCoordinate(body.latitude, -90, 90)) {
      return next(new BadRequestError(
        'latitude must be a number between -90 and 90',
        'VALIDATION_ERROR',
      ));
    }
    if (!isValidCoordinate(body.longitude, -180, 180)) {
      return next(new BadRequestError(
        'longitude must be a number between -180 and 180',
        'VALIDATION_ERROR',
      ));
    }
    req.body.latitude = Number(body.latitude);
    req.body.longitude = Number(body.longitude);
  }

  next();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Middleware: validates :id parameter for address routes.
 */
function validateAddressId(req, res, next) {
  const { id } = req.params;
  if (!id || !UUID_REGEX.test(id)) {
    return next(new BadRequestError('Invalid address ID format (must be UUID)', 'VALIDATION_ERROR'));
  }
  return next();
}

module.exports = {
  validateCreateAddress,
  validateUpdateAddress,
  validateAddressId,
  VALID_LABELS,
  ALLOWED_CREATE_FIELDS,
  ALLOWED_UPDATE_FIELDS,
};
