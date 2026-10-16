'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { isValidUuid } = require('./index');

const ALLOWED_STATUSES = Object.freeze([
  'UPCOMING',
  'CONFIRMED',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
  'ALL',
]);

const ALLOWED_TABS = Object.freeze(['UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED']);

class BookingValidator {
  /**
   * Validates query parameters for listing bookings.
   *
   * @param {object} [query={}]
   * @returns {object} Sanitized query options
   */
  validateBookingListQuery(query = {}) {
    const errors = [];
    const options = {
      page: 1,
      limit: 20,
      offset: 0,
    };

    // 1. status
    if (query.status !== undefined && query.status !== null && query.status !== '') {
      if (typeof query.status !== 'string') {
        errors.push({ field: 'status', message: 'status must be a string' });
      } else {
        const normStatus = query.status.trim().toUpperCase();
        if (!ALLOWED_STATUSES.includes(normStatus)) {
          errors.push({
            field: 'status',
            message: `status must be one of: [${ALLOWED_STATUSES.join(', ')}]`,
          });
        } else {
          options.status = normStatus;
        }
      }
    }

    // 2. tab
    if (query.tab !== undefined && query.tab !== null && query.tab !== '') {
      if (typeof query.tab !== 'string') {
        errors.push({ field: 'tab', message: 'tab must be a string' });
      } else {
        const normTab = query.tab.trim().toUpperCase();
        if (!ALLOWED_TABS.includes(normTab)) {
          errors.push({
            field: 'tab',
            message: 'tab must be one of: [Upcoming, Active, Completed, Cancelled]',
          });
        } else {
          options.tab = query.tab.trim();
        }
      }
    }

    // 3. vehicleId
    if (query.vehicleId !== undefined && query.vehicleId !== null && query.vehicleId !== '') {
      if (!isValidUuid(query.vehicleId)) {
        errors.push({ field: 'vehicleId', message: 'vehicleId must be a valid UUID' });
      } else {
        options.vehicleId = query.vehicleId.trim();
      }
    }

    // 4. startDate
    if (query.startDate) {
      const d = new Date(query.startDate);
      if (Number.isNaN(d.getTime())) {
        errors.push({ field: 'startDate', message: 'startDate must be a valid ISO 8601 date string' });
      } else {
        options.startDate = d.toISOString();
      }
    }

    // 5. endDate
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

    // 6. search
    if (query.search !== undefined && query.search !== null && query.search !== '') {
      if (typeof query.search !== 'string') {
        errors.push({ field: 'search', message: 'search must be a string' });
      } else if (query.search.trim().length > 100) {
        errors.push({ field: 'search', message: 'search cannot exceed 100 characters' });
      } else {
        options.search = query.search.trim();
      }
    }

    // 7. limit
    if (query.limit !== undefined) {
      const lim = parseInt(query.limit, 10);
      if (Number.isNaN(lim) || lim < 1 || lim > 100) {
        errors.push({ field: 'limit', message: 'limit must be between 1 and 100' });
      } else {
        options.limit = lim;
      }
    }

    // 8. page
    if (query.page !== undefined) {
      const p = parseInt(query.page, 10);
      if (Number.isNaN(p) || p < 1) {
        errors.push({ field: 'page', message: 'page must be a positive integer' });
      } else {
        options.page = p;
      }
    }

    options.offset = (options.page - 1) * options.limit;

    if (errors.length > 0) {
      throw new ValidationError('Invalid booking query parameters', errors, ERROR_CODES.VALIDATION_ERROR);
    }

    return options;
  }

  /**
   * Validates a booking UUID.
   *
   * @param {string} id
   * @returns {string}
   */
  validateBookingId(id) {
    if (!id || !isValidUuid(id)) {
      throw new ValidationError(
        'Invalid booking identifier format (must be a valid UUID)',
        [{ field: 'bookingId', message: 'Invalid UUID' }],
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
    return id.trim();
  }

  /**
   * Validates pickup verification payload.
   *
   * @param {object} payload
   * @returns {object} Sanitized pickup data
   */
  validatePickupVerify(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ValidationError(
        'Request payload must be a JSON object',
        [{ field: 'payload', message: 'Payload must be an object' }],
        ERROR_CODES.MALFORMED_PAYLOAD,
      );
    }

    const errors = [];
    const PROTECTED_FIELDS = [
      'status',
      'bookingStatus',
      'booking_status',
      'isVerified',
      'is_verified',
      'verifiedAt',
      'verified_at',
      'verifiedBy',
      'verified_by',
      'otpHash',
      'otp_hash',
      'partnerId',
      'partner_id',
    ];

    for (let i = 0; i < PROTECTED_FIELDS.length; i += 1) {
      const field = PROTECTED_FIELDS[i];
      if (payload[field] !== undefined) {
        throw new ValidationError(
          `Protected server field detected: ${field}`,
          [{ field, message: 'Server-controlled fields cannot be modified' }],
          ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
        );
      }
    }

    const ALLOWED_KEYS = new Set([
      'otp',
      'odometerStart',
      'odometer_start',
      'fuelLevelStart',
      'fuel_level_start',
      'notes',
      'photos',
      'depositCollected',
      'deposit_collected',
    ]);

    const keys = Object.keys(payload);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (!ALLOWED_KEYS.has(k)) {
        errors.push({ field: k, message: `Unknown field: ${k}` });
      }
    }

    // 1. otp (required, 4-6 numeric digits)
    const rawOtp = payload.otp;
    let sanitizedOtp;
    if (rawOtp === undefined || rawOtp === null || String(rawOtp).trim() === '') {
      errors.push({ field: 'otp', message: 'OTP is required' });
    } else if (typeof rawOtp !== 'string' && typeof rawOtp !== 'number') {
      errors.push({ field: 'otp', message: 'OTP must be a string or number' });
    } else {
      const cleanOtp = String(rawOtp).trim();
      if (!/^\d{4,6}$/.test(cleanOtp)) {
        errors.push({ field: 'otp', message: 'OTP must be 4 to 6 numeric digits' });
      } else {
        sanitizedOtp = cleanOtp;
      }
    }

    // 2. odometerStart (optional numeric >= 0)
    const rawOdo = payload.odometerStart !== undefined
      ? payload.odometerStart
      : payload.odometer_start;
    let sanitizedOdometer;
    if (rawOdo !== undefined && rawOdo !== null && rawOdo !== '') {
      const odo = Number(rawOdo);
      if (Number.isNaN(odo) || odo < 0) {
        errors.push({ field: 'odometerStart', message: 'odometerStart must be a non-negative number' });
      } else {
        sanitizedOdometer = odo;
      }
    }

    // 3. fuelLevelStart (optional string <= 20 chars)
    const rawFuel = payload.fuelLevelStart !== undefined
      ? payload.fuelLevelStart
      : payload.fuel_level_start;
    let sanitizedFuel;
    if (rawFuel !== undefined && rawFuel !== null && rawFuel !== '') {
      if (typeof rawFuel !== 'string' || rawFuel.trim().length > 20) {
        errors.push({ field: 'fuelLevelStart', message: 'fuelLevelStart must be a string up to 20 characters' });
      } else {
        sanitizedFuel = rawFuel.trim();
      }
    }

    // 4. notes (optional string <= 500 chars)
    let sanitizedNotes;
    if (payload.notes !== undefined && payload.notes !== null && payload.notes !== '') {
      if (typeof payload.notes !== 'string' || payload.notes.trim().length > 500) {
        errors.push({ field: 'notes', message: 'notes must be a string up to 500 characters' });
      } else {
        sanitizedNotes = payload.notes.trim();
      }
    }

    // 5. photos (optional array of strings)
    let sanitizedPhotos;
    if (payload.photos !== undefined && payload.photos !== null) {
      if (!Array.isArray(payload.photos)) {
        errors.push({ field: 'photos', message: 'photos must be an array of storage keys' });
      } else {
        sanitizedPhotos = payload.photos
          .filter((p) => typeof p === 'string' && p.trim())
          .map((p) => p.trim());
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(
        'Invalid pickup verification parameters',
        errors,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const rawDepositCollected = payload.depositCollected !== undefined
      ? payload.depositCollected
      : payload.deposit_collected;
    const sanitizedDepositCollected = rawDepositCollected !== undefined
      ? Boolean(rawDepositCollected)
      : undefined;

    return {
      otp: sanitizedOtp,
      odometerStart: sanitizedOdometer,
      fuelLevelStart: sanitizedFuel,
      notes: sanitizedNotes,
      photos: sanitizedPhotos,
      ...(sanitizedDepositCollected !== undefined ? { depositCollected: sanitizedDepositCollected } : {}),
    };
  }

  /**
   * Validates return verification payload.
   *
   * @param {object} payload
   * @returns {object} Sanitized return data
   */
  validateReturnPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ValidationError(
        'Request payload must be a JSON object',
        [{ field: 'payload', message: 'Payload must be an object' }],
        ERROR_CODES.MALFORMED_PAYLOAD,
      );
    }

    const errors = [];
    const PROTECTED_FIELDS = [
      'status',
      'bookingStatus',
      'booking_status',
      'rentalStatus',
      'rental_status',
      'actualReturnAt',
      'actual_return_at',
      'returnedAt',
      'returned_at',
      'lateMinutes',
      'late_minutes',
      'lateFee',
      'late_fee',
      'extraKmFee',
      'extra_km_fee',
      'partnerId',
      'partner_id',
      'verifiedBy',
      'verified_by',
      'returnStatus',
      'return_status',
      'totalDistance',
      'total_distance',
    ];

    for (let i = 0; i < PROTECTED_FIELDS.length; i += 1) {
      const field = PROTECTED_FIELDS[i];
      if (payload[field] !== undefined) {
        throw new ValidationError(
          `Protected server field detected: ${field}`,
          [{ field, message: 'Server-controlled fields cannot be modified' }],
          ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
        );
      }
    }

    const ALLOWED_KEYS = new Set([
      'odometerEnd',
      'odometer_end',
      'fuelLevelEnd',
      'fuel_level_end',
      'extraKm',
      'extra_km',
      'notes',
      'photos',
      'damageReport',
      'damage',
      'depositReturned',
      'deposit_returned',
      'overtimeCollected',
      'overtime_collected',
      'confirmOvertimeCollection',
      'confirmedOvertimeAmount',
    ]);

    const keys = Object.keys(payload);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (!ALLOWED_KEYS.has(k)) {
        errors.push({ field: k, message: `Unknown field: ${k}` });
      }
    }

    // 1. odometerEnd (optional numeric >= 0)
    const rawOdo = payload.odometerEnd !== undefined
      ? payload.odometerEnd
      : payload.odometer_end;
    let sanitizedOdometerEnd;
    if (rawOdo !== undefined && rawOdo !== null && rawOdo !== '') {
      const odo = Number(rawOdo);
      if (Number.isNaN(odo) || odo < 0) {
        errors.push({ field: 'odometerEnd', message: 'odometerEnd must be a non-negative number' });
      } else {
        sanitizedOdometerEnd = odo;
      }
    }

    // 2. fuelLevelEnd (optional string <= 20 chars)
    const rawFuel = payload.fuelLevelEnd !== undefined
      ? payload.fuelLevelEnd
      : payload.fuel_level_end;
    let sanitizedFuelEnd;
    if (rawFuel !== undefined && rawFuel !== null && rawFuel !== '') {
      if (typeof rawFuel !== 'string' || rawFuel.trim().length > 20) {
        errors.push({ field: 'fuelLevelEnd', message: 'fuelLevelEnd must be a string up to 20 characters' });
      } else {
        sanitizedFuelEnd = rawFuel.trim();
      }
    }

    // 3. extraKm (optional numeric >= 0)
    const rawExtraKm = payload.extraKm !== undefined
      ? payload.extraKm
      : payload.extra_km;
    let sanitizedExtraKm = 0;
    if (rawExtraKm !== undefined && rawExtraKm !== null && rawExtraKm !== '') {
      const ekm = Number(rawExtraKm);
      if (Number.isNaN(ekm) || ekm < 0) {
        errors.push({ field: 'extraKm', message: 'extraKm must be a non-negative number' });
      } else {
        sanitizedExtraKm = ekm;
      }
    }

    // 4. notes (optional string <= 500 chars)
    let sanitizedNotes;
    if (payload.notes !== undefined && payload.notes !== null && payload.notes !== '') {
      if (typeof payload.notes !== 'string' || payload.notes.trim().length > 500) {
        errors.push({ field: 'notes', message: 'notes must be a string up to 500 characters' });
      } else {
        sanitizedNotes = payload.notes.trim();
      }
    }

    // 5. photos (optional array of strings)
    let sanitizedPhotos;
    if (payload.photos !== undefined && payload.photos !== null) {
      if (!Array.isArray(payload.photos)) {
        errors.push({ field: 'photos', message: 'photos must be an array of storage keys' });
      } else {
        sanitizedPhotos = payload.photos
          .filter((p) => typeof p === 'string' && p.trim())
          .map((p) => p.trim());
      }
    }

    // 6. damageReport / damage (optional object)
    const rawDamage = payload.damageReport || payload.damage;
    let sanitizedDamageReport;
    if (rawDamage !== undefined && rawDamage !== null) {
      if (typeof rawDamage !== 'object' || Array.isArray(rawDamage)) {
        errors.push({ field: 'damageReport', message: 'damageReport must be an object' });
      } else {
        const dmgKeys = Object.keys(rawDamage);
        const ALLOWED_DMG_KEYS = new Set([
          'damageType',
          'damage_type',
          'description',
          'estimatedAmount',
          'estimated_amount',
          'photos',
        ]);
        for (let i = 0; i < dmgKeys.length; i += 1) {
          const dk = dmgKeys[i];
          if (!ALLOWED_DMG_KEYS.has(dk)) {
            errors.push({ field: `damageReport.${dk}`, message: `Unknown damage field: ${dk}` });
          }
        }

        const ALLOWED_TYPES = ['ACCIDENT', 'SCRATCH', 'DENT', 'MECHANICAL', 'INTERIOR', 'OTHER'];
        const rawType = (rawDamage.damageType || rawDamage.damage_type || 'ACCIDENT').toUpperCase();
        if (!ALLOWED_TYPES.includes(rawType)) {
          errors.push({
            field: 'damageReport.damageType',
            message: `damageType must be one of: [${ALLOWED_TYPES.join(', ')}]`,
          });
        }

        if (!rawDamage.description || typeof rawDamage.description !== 'string' || rawDamage.description.trim().length < 3) {
          errors.push({
            field: 'damageReport.description',
            message: 'Damage description is required and must be at least 3 characters',
          });
        } else if (rawDamage.description.trim().length > 1000) {
          errors.push({
            field: 'damageReport.description',
            message: 'Damage description cannot exceed 1000 characters',
          });
        }

        const rawEst = rawDamage.estimatedAmount !== undefined
          ? rawDamage.estimatedAmount
          : rawDamage.estimated_amount;
        let sanitizedEst = 0.00;
        if (rawEst !== undefined && rawEst !== null && rawEst !== '') {
          const est = Number(rawEst);
          if (Number.isNaN(est) || est < 0) {
            errors.push({
              field: 'damageReport.estimatedAmount',
              message: 'estimatedAmount must be a non-negative number',
            });
          } else {
            sanitizedEst = est;
          }
        }

        let sanitizedDmgPhotos;
        if (rawDamage.photos !== undefined && rawDamage.photos !== null) {
          if (!Array.isArray(rawDamage.photos)) {
            errors.push({
              field: 'damageReport.photos',
              message: 'photos must be an array of storage keys',
            });
          } else {
            sanitizedDmgPhotos = rawDamage.photos
              .filter((p) => typeof p === 'string' && p.trim())
              .map((p) => p.trim());
          }
        }

        sanitizedDamageReport = {
          damageType: rawType,
          description: (rawDamage.description || '').trim(),
          estimatedAmount: sanitizedEst,
          photos: sanitizedDmgPhotos || [],
        };
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(
        'Invalid return payload parameters',
        errors,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const rawDepositReturned = payload.depositReturned !== undefined
      ? payload.depositReturned
      : payload.deposit_returned;
    const sanitizedDepositReturned = rawDepositReturned !== undefined
      ? Boolean(rawDepositReturned)
      : undefined;

    const rawOvertimeCollected = payload.overtimeCollected !== undefined
      ? payload.overtimeCollected
      : (payload.overtime_collected !== undefined
        ? payload.overtime_collected
        : payload.confirmOvertimeCollection);
    const sanitizedOvertimeCollected = rawOvertimeCollected !== undefined
      ? Boolean(rawOvertimeCollected)
      : undefined;

    return {
      odometerEnd: sanitizedOdometerEnd,
      fuelLevelEnd: sanitizedFuelEnd,
      extraKm: sanitizedExtraKm,
      notes: sanitizedNotes,
      photos: sanitizedPhotos,
      damageReport: sanitizedDamageReport,
      ...(sanitizedDepositReturned !== undefined ? { depositReturned: sanitizedDepositReturned } : {}),
      ...(sanitizedOvertimeCollected !== undefined ? { overtimeCollected: sanitizedOvertimeCollected } : {}),
    };
  }

  /**
   * Validates standalone damage report payload.
   *
   * @param {object} payload
   * @returns {object} Sanitized damage data
   */
  validateDamageReportPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ValidationError(
        'Request payload must be a JSON object',
        [{ field: 'payload', message: 'Payload must be an object' }],
        ERROR_CODES.MALFORMED_PAYLOAD,
      );
    }

    const errors = [];
    const PROTECTED_FIELDS = [
      'status',
      'approvedAmount',
      'approved_amount',
      'reportedBy',
      'reported_by',
      'bookingId',
      'booking_id',
      'vehicleId',
      'vehicle_id',
      'createdAt',
      'updatedAt',
    ];

    for (let i = 0; i < PROTECTED_FIELDS.length; i += 1) {
      const field = PROTECTED_FIELDS[i];
      if (payload[field] !== undefined) {
        throw new ValidationError(
          `Protected server field detected: ${field}`,
          [{ field, message: 'Server-controlled fields cannot be modified' }],
          ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
        );
      }
    }

    const ALLOWED_KEYS = new Set([
      'damageType',
      'damage_type',
      'description',
      'estimatedAmount',
      'estimated_amount',
      'photos',
    ]);

    const keys = Object.keys(payload);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (!ALLOWED_KEYS.has(k)) {
        errors.push({ field: k, message: `Unknown field: ${k}` });
      }
    }

    const ALLOWED_TYPES = ['ACCIDENT', 'SCRATCH', 'DENT', 'MECHANICAL', 'INTERIOR', 'OTHER'];
    const rawType = (payload.damageType || payload.damage_type || 'ACCIDENT').toUpperCase();
    if (!ALLOWED_TYPES.includes(rawType)) {
      errors.push({
        field: 'damageType',
        message: `damageType must be one of: [${ALLOWED_TYPES.join(', ')}]`,
      });
    }

    if (!payload.description || typeof payload.description !== 'string' || payload.description.trim().length < 3) {
      errors.push({
        field: 'description',
        message: 'Damage description is required and must be at least 3 characters',
      });
    } else if (payload.description.trim().length > 1000) {
      errors.push({
        field: 'description',
        message: 'Damage description cannot exceed 1000 characters',
      });
    }

    const rawEst = payload.estimatedAmount !== undefined
      ? payload.estimatedAmount
      : payload.estimated_amount;
    let sanitizedEst = 0.00;
    if (rawEst !== undefined && rawEst !== null && rawEst !== '') {
      const est = Number(rawEst);
      if (Number.isNaN(est) || est < 0) {
        errors.push({
          field: 'estimatedAmount',
          message: 'estimatedAmount must be a non-negative number',
        });
      } else {
        sanitizedEst = est;
      }
    }

    let sanitizedPhotos;
    if (payload.photos !== undefined && payload.photos !== null) {
      if (!Array.isArray(payload.photos)) {
        errors.push({ field: 'photos', message: 'photos must be an array of storage keys' });
      } else {
        sanitizedPhotos = payload.photos
          .filter((p) => typeof p === 'string' && p.trim())
          .map((p) => p.trim());
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(
        'Invalid damage report payload parameters',
        errors,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    return {
      damageType: rawType,
      description: payload.description.trim(),
      estimatedAmount: sanitizedEst,
      photos: sanitizedPhotos || [],
    };
  }
}

module.exports = new BookingValidator();
