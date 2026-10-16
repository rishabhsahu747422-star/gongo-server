'use strict';

const { ValidationError } = require('../errors');
const { roundMoney } = require('../utils/money');

const ALLOWED_FEE_TYPES = new Set(['fixed', 'percentage']);

function validateNumericField(val, fieldName, { min = 0, max = null } = {}) {
  if (
    val === undefined
    || val === null
    || (typeof val === 'string' && val.trim() === '')
  ) {
    throw new ValidationError(`${fieldName} is required`);
  }

  if (typeof val !== 'number' && typeof val !== 'string') {
    throw new ValidationError(`${fieldName} must be a valid number`);
  }

  const num = Number(val);
  if (Number.isNaN(num) || !Number.isFinite(num)) {
    throw new ValidationError(`${fieldName} must be a valid number`);
  }

  if (min !== null && num < min) {
    throw new ValidationError(`${fieldName} cannot be negative`);
  }

  if (max !== null && num > max) {
    throw new ValidationError(`${fieldName} cannot exceed ${max}`);
  }

  return roundMoney(num);
}

/**
 * Validates platform charges payload.
 *
 * Supports the 3-component platform fee structure:
 * { serviceCharge, convenienceFee, gst }
 *
 * Also supports legacy { feeType, feeValue, currency } payload for backward compatibility.
 *
 * @param {object} body
 * @returns {{
 *   serviceCharge: number,
 *   convenienceFee: number,
 *   gst: number,
 *   feeType?: string,
 *   feeValue?: number,
 *   currency?: string
 * }}
 */
function validatePlatformFeePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a valid JSON object');
  }

  // Legacy single-fee payload branch
  if (
    body.serviceCharge === undefined
    && body.convenienceFee === undefined
    && body.gst === undefined
    && (body.feeType !== undefined || body.feeValue !== undefined)
  ) {
    const { feeType, feeValue, currency } = body;

    if (feeType === undefined || feeType === null || feeType === '') {
      throw new ValidationError('feeType is required');
    }
    if (typeof feeType !== 'string' || !ALLOWED_FEE_TYPES.has(feeType.trim().toLowerCase())) {
      throw new ValidationError("feeType must be either 'fixed' or 'percentage'");
    }
    const cleanFeeType = feeType.trim().toLowerCase();

    const max = cleanFeeType === 'percentage' ? 100 : null;
    const validatedFeeValue = validateNumericField(feeValue, 'feeValue', { min: 0, max });

    let cleanCurrency = 'INR';
    if (currency !== undefined && currency !== null && currency !== '') {
      if (typeof currency !== 'string' || currency.trim().toUpperCase() !== 'INR') {
        throw new ValidationError('Only INR currency is currently supported');
      }
      cleanCurrency = 'INR';
    }

    return {
      serviceCharge: 2.50,
      convenienceFee: cleanFeeType === 'fixed' ? validatedFeeValue : 2.00,
      gst: cleanFeeType === 'percentage' ? validatedFeeValue : 18.00,
      feeType: cleanFeeType,
      feeValue: validatedFeeValue,
      currency: cleanCurrency,
    };
  }

  // 3-component platform fee payload
  const serviceCharge = validateNumericField(body.serviceCharge, 'Service Charge', { min: 0 });
  const convenienceFee = validateNumericField(body.convenienceFee, 'Customer Convenience Fee', { min: 0 });
  const gst = validateNumericField(body.gst, 'Standard GST Tax Rate', { min: 0, max: 100 });

  const result = {
    serviceCharge,
    convenienceFee,
    gst,
  };

  if (body.vehicleType !== undefined && body.vehicleType !== null && body.vehicleType !== '') {
    if (typeof body.vehicleType !== 'string') {
      throw new ValidationError("vehicleType must be either 'bike' or 'car'");
    }
    const cleanVt = body.vehicleType.trim().toLowerCase();
    if (cleanVt !== 'bike' && cleanVt !== 'car') {
      throw new ValidationError("vehicleType must be either 'bike' or 'car'");
    }
    result.vehicleType = cleanVt;
  }

  return result;
}

module.exports = {
  validatePlatformFeePayload,
  validateNumericField,
  ALLOWED_FEE_TYPES,
};
