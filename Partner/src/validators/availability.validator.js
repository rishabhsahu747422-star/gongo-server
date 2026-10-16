'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { detectProtectedFields } = require('../middlewares/massAssignment');

const ALLOWED_REASONS = Object.freeze([
  'Maintenance',
  'Service',
  'Damage',
  'Personal Use',
  'Temporary Unavailability',
  'Other',
]);

const PROTECTED_AVAILABILITY_FIELDS = Object.freeze([
  'id',
  'vehicle_id',
  'vehicleId',
  'created_by',
  'createdBy',
  'isActive',
  'is_active',
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
]);

const ALLOWED_CREATE_BLOCK_FIELDS = Object.freeze([
  'startTime',
  'start_time',
  'endTime',
  'end_time',
  'reason',
]);

const ALLOWED_UPDATE_BLOCK_FIELDS = Object.freeze([
  'startTime',
  'start_time',
  'endTime',
  'end_time',
  'reason',
]);

class AvailabilityValidator {
  /**
   * Validate availability block creation.
   *
   * @param {object} body
   * @returns {object} Validated block payload
   */
  validateCreateBlock(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    if (Object.keys(body).length === 0) {
      throw new ValidationError('Block payload cannot be empty');
    }

    // Mass assignment check
    const baseViolations = detectProtectedFields(body);
    const extraViolations = PROTECTED_AVAILABILITY_FIELDS.filter(
      (f) => Object.prototype.hasOwnProperty.call(body, f),
    );
    const allViolations = Array.from(new Set([...baseViolations, ...extraViolations]));

    if (allViolations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${allViolations.join(', ')}] cannot be provided`,
        allViolations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    // Whitelist check
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_CREATE_BLOCK_FIELDS.includes(k));
    if (unknownFields.length > 0) {
      throw new ValidationError(
        `Unknown field(s) [${unknownFields.join(', ')}] are not permitted for availability block`,
        unknownFields.map((f) => ({ field: f, message: 'Field not permitted' })),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const errors = [];

    const rawStartTime = body.startTime !== undefined ? body.startTime : body.start_time;
    const rawEndTime = body.endTime !== undefined ? body.endTime : body.end_time;
    const rawReason = body.reason;

    let startTime = null;
    if (!rawStartTime) {
      errors.push({ field: 'startTime', message: 'startTime is required' });
    } else {
      const d = new Date(rawStartTime);
      if (Number.isNaN(d.getTime())) {
        errors.push({ field: 'startTime', message: 'startTime must be a valid ISO 8601 date string' });
      } else {
        startTime = d.toISOString();
      }
    }

    let endTime = null;
    if (!rawEndTime) {
      errors.push({ field: 'endTime', message: 'endTime is required' });
    } else {
      const d = new Date(rawEndTime);
      if (Number.isNaN(d.getTime())) {
        errors.push({ field: 'endTime', message: 'endTime must be a valid ISO 8601 date string' });
      } else {
        endTime = d.toISOString();
      }
    }

    if (startTime && endTime) {
      if (new Date(startTime).getTime() >= new Date(endTime).getTime()) {
        errors.push({ field: 'endTime', message: 'endTime must be strictly after startTime' });
      }
    }

    let reason = 'Maintenance';
    if (rawReason !== undefined && rawReason !== null && rawReason !== '') {
      if (typeof rawReason !== 'string' || !rawReason.trim()) {
        errors.push({ field: 'reason', message: 'reason must be a non-empty string' });
      } else {
        const trimmed = rawReason.trim();
        const matched = ALLOWED_REASONS.find(
          (r) => r.toUpperCase() === trimmed.toUpperCase(),
        );
        if (!matched) {
          errors.push({
            field: 'reason',
            message: `reason must be one of: [${ALLOWED_REASONS.join(', ')}]`,
          });
        } else {
          reason = matched;
        }
      }
    }

    if (errors.length > 0) {
      throw new ValidationError('Availability block validation failed', errors, ERROR_CODES.VALIDATION_ERROR);
    }

    return {
      startTime,
      endTime,
      reason,
    };
  }

  /**
   * Validate availability block update.
   *
   * @param {object} body
   * @returns {object} Validated update payload
   */
  validateUpdateBlock(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    if (Object.keys(body).length === 0) {
      throw new ValidationError('Update payload cannot be empty');
    }

    // Mass assignment check
    const baseViolations = detectProtectedFields(body);
    const extraViolations = PROTECTED_AVAILABILITY_FIELDS.filter(
      (f) => Object.prototype.hasOwnProperty.call(body, f),
    );
    const allViolations = Array.from(new Set([...baseViolations, ...extraViolations]));

    if (allViolations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${allViolations.join(', ')}] cannot be provided`,
        allViolations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    // Whitelist check
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_UPDATE_BLOCK_FIELDS.includes(k));
    if (unknownFields.length > 0) {
      throw new ValidationError(
        `Unknown field(s) [${unknownFields.join(', ')}] are not permitted for block update`,
        unknownFields.map((f) => ({ field: f, message: 'Field not permitted' })),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const errors = [];
    const updates = {};

    const rawStartTime = body.startTime !== undefined ? body.startTime : body.start_time;
    const rawEndTime = body.endTime !== undefined ? body.endTime : body.end_time;
    const rawReason = body.reason;

    if (rawStartTime !== undefined) {
      const d = new Date(rawStartTime);
      if (Number.isNaN(d.getTime())) {
        errors.push({ field: 'startTime', message: 'startTime must be a valid ISO 8601 date string' });
      } else {
        updates.startTime = d.toISOString();
      }
    }

    if (rawEndTime !== undefined) {
      const d = new Date(rawEndTime);
      if (Number.isNaN(d.getTime())) {
        errors.push({ field: 'endTime', message: 'endTime must be a valid ISO 8601 date string' });
      } else {
        updates.endTime = d.toISOString();
      }
    }

    if (updates.startTime && updates.endTime) {
      if (new Date(updates.startTime).getTime() >= new Date(updates.endTime).getTime()) {
        errors.push({ field: 'endTime', message: 'endTime must be strictly after startTime' });
      }
    }

    if (rawReason !== undefined) {
      if (typeof rawReason !== 'string' || !rawReason.trim()) {
        errors.push({ field: 'reason', message: 'reason must be a non-empty string' });
      } else {
        const trimmed = rawReason.trim();
        const matched = ALLOWED_REASONS.find(
          (r) => r.toUpperCase() === trimmed.toUpperCase(),
        );
        if (!matched) {
          errors.push({
            field: 'reason',
            message: `reason must be one of: [${ALLOWED_REASONS.join(', ')}]`,
          });
        } else {
          updates.reason = matched;
        }
      }
    }

    if (errors.length > 0) {
      throw new ValidationError('Block update validation failed', errors, ERROR_CODES.VALIDATION_ERROR);
    }

    return updates;
  }

  /**
   * Validate availability query parameters.
   *
   * @param {object} query
   * @returns {object} Validated query options
   */
  validateAvailabilityQuery(query = {}) {
    const errors = [];
    const options = {
      limit: 100,
      offset: 0,
      isActive: true,
    };

    if (query.startDate) {
      const d = new Date(query.startDate);
      if (Number.isNaN(d.getTime())) {
        errors.push({ field: 'startDate', message: 'startDate must be a valid ISO 8601 date string' });
      } else {
        options.startDate = d.toISOString();
      }
    }

    if (query.endDate) {
      const d = new Date(query.endDate);
      if (Number.isNaN(d.getTime())) {
        errors.push({ field: 'endDate', message: 'endDate must be a valid ISO 8601 date string' });
      } else {
        options.endDate = d.toISOString();
      }
    }

    if (options.startDate && options.endDate) {
      if (new Date(options.startDate).getTime() > new Date(options.endDate).getTime()) {
        errors.push({ field: 'endDate', message: 'endDate cannot be before startDate' });
      }
    }

    if (query.isActive !== undefined) {
      if (query.isActive === 'true' || query.isActive === true) {
        options.isActive = true;
      } else if (query.isActive === 'false' || query.isActive === false) {
        options.isActive = false;
      } else if (query.isActive === 'all') {
        options.isActive = null; // fetch all regardless of active state
      } else {
        errors.push({ field: 'isActive', message: 'isActive must be true, false, or all' });
      }
    }

    if (query.limit !== undefined) {
      const lim = parseInt(query.limit, 10);
      if (Number.isNaN(lim) || lim < 1 || lim > 200) {
        errors.push({ field: 'limit', message: 'limit must be between 1 and 200' });
      } else {
        options.limit = lim;
      }
    }

    if (query.page !== undefined) {
      const p = parseInt(query.page, 10);
      if (Number.isNaN(p) || p < 1) {
        errors.push({ field: 'page', message: 'page must be a positive integer' });
      } else {
        options.offset = (p - 1) * options.limit;
      }
    }

    if (errors.length > 0) {
      throw new ValidationError('Invalid query parameters', errors, ERROR_CODES.VALIDATION_ERROR);
    }

    return options;
  }
}

module.exports = new AvailabilityValidator();
