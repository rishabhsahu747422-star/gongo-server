'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { detectProtectedFields } = require('../middlewares/massAssignment');

const PROTECTED_PRICING_FIELDS = Object.freeze([
  'id',
  'vehicle_id',
  'vehicleId',
  'isActive',
  'is_active',
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
]);

const ALLOWED_PRICING_FIELDS = Object.freeze([
  'pricePerHour',
  'price_per_hour',
  'price3Hours',
  'price_3_hours',
  'price6Hours',
  'price_6_hours',
  'price12Hours',
  'price_12_hours',
  'pricePer4Hours',
  'price_per_4_hours',
  'pricePerDay',
  'price_per_day',
  'securityDeposit',
  'security_deposit',
  'extraKmCharge',
  'extra_km_charge',
  'currency',
  'kmLimitPerDay',
  'km_limit_per_day',
  'kmLimit24Hours',
  'km_limit_24_hours',
  'kmLimitDay',
  'kmLimitPerHour',
  'km_limit_per_hour',
  'kmLimit1Hour',
  'km_limit_1_hour',
  'kmLimit3Hours',
  'km_limit_3_hours',
  'kmLimit6Hours',
  'km_limit_6_hours',
  'kmLimit12Hours',
  'km_limit_12_hours',
]);

class PricingValidator {
  /**
   * Validate vehicle pricing upsert payload.
   *
   * @param {object} body
   * @returns {object} Normalized pricing payload
   */
  validatePricing(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    if (Object.keys(body).length === 0) {
      throw new ValidationError('Pricing payload cannot be empty');
    }

    // Mass assignment check
    const baseViolations = detectProtectedFields(body);
    const extraViolations = PROTECTED_PRICING_FIELDS.filter(
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
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_PRICING_FIELDS.includes(k));
    if (unknownFields.length > 0) {
      throw new ValidationError(
        `Unknown field(s) [${unknownFields.join(', ')}] are not permitted for vehicle pricing`,
        unknownFields.map((f) => ({ field: f, message: 'Field not permitted' })),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const errors = [];

    // Extract fields (supporting camelCase or snake_case)
    const rawPricePerDay = body.pricePerDay !== undefined
      ? body.pricePerDay
      : body.price_per_day;
    const rawPricePerHour = body.pricePerHour !== undefined
      ? body.pricePerHour
      : body.price_per_hour;
    const rawPrice3Hours = body.price3Hours !== undefined
      ? body.price3Hours
      : body.price_3_hours;
    const rawPrice6Hours = body.price6Hours !== undefined
      ? body.price6Hours
      : body.price_6_hours;
    const rawPrice12Hours = body.price12Hours !== undefined
      ? body.price12Hours
      : body.price_12_hours;
    const rawPricePer4Hours = body.pricePer4Hours !== undefined
      ? body.pricePer4Hours
      : body.price_per_4_hours;
    const rawSecurityDeposit = body.securityDeposit !== undefined
      ? body.securityDeposit
      : body.security_deposit;
    const rawExtraKmCharge = body.extraKmCharge !== undefined
      ? body.extraKmCharge
      : body.extra_km_charge;
    const rawCurrency = body.currency;

    const rawKmLimitPerDay = body.kmLimitPerDay !== undefined
      ? body.kmLimitPerDay
      : (body.km_limit_per_day !== undefined
        ? body.km_limit_per_day
        : (body.kmLimit24Hours !== undefined
          ? body.kmLimit24Hours
          : (body.km_limit_24_hours !== undefined ? body.km_limit_24_hours : body.kmLimitDay)));
    const rawKmLimitPerHour = body.kmLimitPerHour !== undefined
      ? body.kmLimitPerHour
      : (body.km_limit_per_hour !== undefined
        ? body.km_limit_per_hour
        : (body.kmLimit1Hour !== undefined ? body.kmLimit1Hour : body.km_limit_1_hour));
    const rawKmLimit3Hours = body.kmLimit3Hours !== undefined
      ? body.kmLimit3Hours
      : body.km_limit_3_hours;
    const rawKmLimit6Hours = body.kmLimit6Hours !== undefined
      ? body.kmLimit6Hours
      : body.km_limit_6_hours;
    const rawKmLimit12Hours = body.kmLimit12Hours !== undefined
      ? body.kmLimit12Hours
      : body.km_limit_12_hours;

    // 1. pricePerDay (Primary rental rate)
    let pricePerDay = null;
    if (rawPricePerDay === undefined || rawPricePerDay === null || rawPricePerDay === '') {
      errors.push({ field: 'pricePerDay', message: 'pricePerDay is required' });
    } else {
      const num = Number(rawPricePerDay);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'pricePerDay', message: 'pricePerDay must be a non-negative number' });
      } else if (num > 1000000) {
        errors.push({ field: 'pricePerDay', message: 'pricePerDay cannot exceed 1,000,000' });
      } else {
        pricePerDay = Number(num.toFixed(2));
      }
    }

    // 2. pricePerHour (explicit or auto-derived from pricePerDay / 15)
    let pricePerHour = null;
    if (rawPricePerHour !== undefined && rawPricePerHour !== null && rawPricePerHour !== '') {
      const num = Number(rawPricePerHour);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'pricePerHour', message: 'pricePerHour must be a non-negative number' });
      } else if (num > 1000000) {
        errors.push({ field: 'pricePerHour', message: 'pricePerHour cannot exceed 1,000,000' });
      } else {
        pricePerHour = Number(num.toFixed(2));
      }
    } else if (pricePerDay !== null) {
      // Auto-derive fallback per frontend AppContext contract
      pricePerHour = Number((pricePerDay / 15).toFixed(2));
    }

    // 3. price3Hours (explicit duration pricing)
    let price3Hours = null;
    if (rawPrice3Hours !== undefined && rawPrice3Hours !== null && rawPrice3Hours !== '') {
      const num = Number(rawPrice3Hours);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'price3Hours', message: 'price3Hours must be a non-negative number' });
      } else if (num > 1000000) {
        errors.push({ field: 'price3Hours', message: 'price3Hours cannot exceed 1,000,000' });
      } else {
        price3Hours = Number(num.toFixed(2));
      }
    }

    // 4. price6Hours (explicit duration pricing)
    let price6Hours = null;
    if (rawPrice6Hours !== undefined && rawPrice6Hours !== null && rawPrice6Hours !== '') {
      const num = Number(rawPrice6Hours);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'price6Hours', message: 'price6Hours must be a non-negative number' });
      } else if (num > 1000000) {
        errors.push({ field: 'price6Hours', message: 'price6Hours cannot exceed 1,000,000' });
      } else {
        price6Hours = Number(num.toFixed(2));
      }
    }

    // 5. price12Hours (explicit duration pricing)
    let price12Hours = null;
    if (rawPrice12Hours !== undefined && rawPrice12Hours !== null && rawPrice12Hours !== '') {
      const num = Number(rawPrice12Hours);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'price12Hours', message: 'price12Hours must be a non-negative number' });
      } else if (num > 1000000) {
        errors.push({ field: 'price12Hours', message: 'price12Hours cannot exceed 1,000,000' });
      } else {
        price12Hours = Number(num.toFixed(2));
      }
    }

    // 6. pricePer4Hours (legacy support, explicit or auto-derived from pricePerDay / 4)
    let pricePer4Hours = null;
    if (rawPricePer4Hours !== undefined && rawPricePer4Hours !== null && rawPricePer4Hours !== '') {
      const num = Number(rawPricePer4Hours);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'pricePer4Hours', message: 'pricePer4Hours must be a non-negative number' });
      } else if (num > 1000000) {
        errors.push({ field: 'pricePer4Hours', message: 'pricePer4Hours cannot exceed 1,000,000' });
      } else {
        pricePer4Hours = Number(num.toFixed(2));
      }
    } else if (pricePerDay !== null) {
      // Auto-derive fallback per frontend AppContext contract
      pricePer4Hours = Number((pricePerDay / 4).toFixed(2));
    }

    // 7. securityDeposit
    let securityDeposit = 0.00;
    if (rawSecurityDeposit !== undefined && rawSecurityDeposit !== null && rawSecurityDeposit !== '') {
      const num = Number(rawSecurityDeposit);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'securityDeposit', message: 'securityDeposit must be a non-negative number' });
      } else if (num > 1000000) {
        errors.push({ field: 'securityDeposit', message: 'securityDeposit cannot exceed 1,000,000' });
      } else {
        securityDeposit = Number(num.toFixed(2));
      }
    }

    // 8. extraKmCharge
    let extraKmCharge = 0.00;
    if (rawExtraKmCharge !== undefined && rawExtraKmCharge !== null && rawExtraKmCharge !== '') {
      const num = Number(rawExtraKmCharge);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'extraKmCharge', message: 'extraKmCharge must be a non-negative number' });
      } else if (num > 10000) {
        errors.push({ field: 'extraKmCharge', message: 'extraKmCharge cannot exceed 10,000' });
      } else {
        extraKmCharge = Number(num.toFixed(2));
      }
    }

    // 9. currency
    let currency = 'INR';
    if (rawCurrency !== undefined && rawCurrency !== null) {
      if (typeof rawCurrency !== 'string' || rawCurrency.trim().toUpperCase() !== 'INR') {
        errors.push({ field: 'currency', message: 'currency must be INR' });
      } else {
        currency = rawCurrency.trim().toUpperCase();
      }
    }

    // 10. kmLimitPerDay
    let kmLimitPerDay = null;
    if (rawKmLimitPerDay !== undefined && rawKmLimitPerDay !== null && rawKmLimitPerDay !== '') {
      const num = Number(rawKmLimitPerDay);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'kmLimitPerDay', message: 'kmLimitPerDay must be a non-negative number' });
      } else if (num > 100000) {
        errors.push({ field: 'kmLimitPerDay', message: 'kmLimitPerDay cannot exceed 100,000' });
      } else {
        kmLimitPerDay = Number(num.toFixed(2));
      }
    }

    // 11. kmLimitPerHour
    let kmLimitPerHour = null;
    if (rawKmLimitPerHour !== undefined && rawKmLimitPerHour !== null && rawKmLimitPerHour !== '') {
      const num = Number(rawKmLimitPerHour);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'kmLimitPerHour', message: 'kmLimitPerHour must be a non-negative number' });
      } else if (num > 100000) {
        errors.push({ field: 'kmLimitPerHour', message: 'kmLimitPerHour cannot exceed 100,000' });
      } else {
        kmLimitPerHour = Number(num.toFixed(2));
      }
    }

    // 12. kmLimit3Hours
    let kmLimit3Hours = null;
    if (rawKmLimit3Hours !== undefined && rawKmLimit3Hours !== null && rawKmLimit3Hours !== '') {
      const num = Number(rawKmLimit3Hours);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'kmLimit3Hours', message: 'kmLimit3Hours must be a non-negative number' });
      } else if (num > 100000) {
        errors.push({ field: 'kmLimit3Hours', message: 'kmLimit3Hours cannot exceed 100,000' });
      } else {
        kmLimit3Hours = Number(num.toFixed(2));
      }
    }

    // 13. kmLimit6Hours
    let kmLimit6Hours = null;
    if (rawKmLimit6Hours !== undefined && rawKmLimit6Hours !== null && rawKmLimit6Hours !== '') {
      const num = Number(rawKmLimit6Hours);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'kmLimit6Hours', message: 'kmLimit6Hours must be a non-negative number' });
      } else if (num > 100000) {
        errors.push({ field: 'kmLimit6Hours', message: 'kmLimit6Hours cannot exceed 100,000' });
      } else {
        kmLimit6Hours = Number(num.toFixed(2));
      }
    }

    // 14. kmLimit12Hours
    let kmLimit12Hours = null;
    if (rawKmLimit12Hours !== undefined && rawKmLimit12Hours !== null && rawKmLimit12Hours !== '') {
      const num = Number(rawKmLimit12Hours);
      if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) {
        errors.push({ field: 'kmLimit12Hours', message: 'kmLimit12Hours must be a non-negative number' });
      } else if (num > 100000) {
        errors.push({ field: 'kmLimit12Hours', message: 'kmLimit12Hours cannot exceed 100,000' });
      } else {
        kmLimit12Hours = Number(num.toFixed(2));
      }
    }

    if (errors.length > 0) {
      throw new ValidationError('Pricing validation failed', errors, ERROR_CODES.VALIDATION_ERROR);
    }

    return {
      pricePerHour,
      price3Hours,
      price6Hours,
      price12Hours,
      pricePer4Hours,
      pricePerDay,
      kmLimitPerDay,
      kmLimitPerHour,
      kmLimit3Hours,
      kmLimit6Hours,
      kmLimit12Hours,
      securityDeposit,
      extraKmCharge,
      currency,
      isActive: true,
    };
  }

  /**
   * Validate pricing history list query parameters.
   *
   * @param {object} query
   * @returns {{ limit: number, offset: number }}
   */
  validateHistoryQuery(query = {}) {
    const errors = [];
    const options = { limit: 50, offset: 0 };

    if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
      const limitNum = Number(query.limit);
      if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
        errors.push({ field: 'limit', message: 'limit must be an integer between 1 and 100' });
      } else {
        options.limit = limitNum;
      }
    }

    if (query.offset !== undefined && query.offset !== null && query.offset !== '') {
      const offsetNum = Number(query.offset);
      if (!Number.isInteger(offsetNum) || offsetNum < 0) {
        errors.push({ field: 'offset', message: 'offset must be a non-negative integer' });
      } else {
        options.offset = offsetNum;
      }
    }

    if (errors.length > 0) {
      throw new ValidationError('Pricing history query validation failed', errors, ERROR_CODES.VALIDATION_ERROR);
    }

    return options;
  }
}

module.exports = new PricingValidator();
