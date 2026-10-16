'use strict';

const { BadRequestError } = require('../errors');

/**
 * Validates a single cancellation rule list for a vehicle type.
 *
 * @param {Array<object>} rules
 * @param {string} [vehicleType='']
 * @throws {BadRequestError}
 */
function validateRulesList(rules, vehicleType = '') {
  const prefix = vehicleType ? `[${vehicleType.toUpperCase()}] ` : '';

  if (!Array.isArray(rules) || rules.length === 0) {
    throw new BadRequestError(
      `${prefix}At least one cancellation rule is required.`,
      'INVALID_CANCELLATION_RULES',
    );
  }

  let prevNoticeHours = null;

  rules.forEach((rule, index) => {
    const tierNum = index + 1;
    if (!rule || typeof rule !== 'object') {
      throw new BadRequestError(
        `${prefix}Tier ${tierNum} must be a valid rule object.`,
        'INVALID_CANCELLATION_RULE',
      );
    }

    const rawHours = rule.noticeHours ?? rule.notice_hours;
    const rawRefund = rule.refundPercentage ?? rule.refund_percentage;

    // Validate Notice Hours
    if (
      rawHours === undefined
      || rawHours === null
      || rawHours === ''
      || Number.isNaN(Number(rawHours))
      || !Number.isFinite(Number(rawHours))
    ) {
      throw new BadRequestError(
        `${prefix}Tier ${tierNum} notice window must be a valid number.`,
        'INVALID_NOTICE_HOURS',
      );
    }

    const hours = Number(rawHours);
    if (hours <= 0) {
      throw new BadRequestError(
        `${prefix}Tier ${tierNum} notice window must be greater than 0 hours.`,
        'INVALID_NOTICE_HOURS',
      );
    }

    // Validate Refund Percentage
    if (
      rawRefund === undefined
      || rawRefund === null
      || rawRefund === ''
      || Number.isNaN(Number(rawRefund))
      || !Number.isFinite(Number(rawRefund))
    ) {
      throw new BadRequestError(
        `${prefix}Tier ${tierNum} refund percentage must be a valid number.`,
        'INVALID_REFUND_PERCENTAGE',
      );
    }

    const refund = Number(rawRefund);
    if (refund < 0 || refund > 100) {
      throw new BadRequestError(
        `${prefix}Tier ${tierNum} refund percentage must be between 0 and 100.`,
        'INVALID_REFUND_PERCENTAGE',
      );
    }

    // Validate Threshold Order
    // Must be non-decreasing; cannot decrease
    if (prevNoticeHours !== null && hours < prevNoticeHours) {
      throw new BadRequestError(
        `${prefix}Tier ${tierNum} notice window (${hours}h) cannot be less than previous tier (${prevNoticeHours}h).`,
        'INVALID_NOTICE_HOURS_ORDER',
      );
    }

    prevNoticeHours = hours;
  });
}

/**
 * Validates save payload for cancellation rules.
 *
 * @param {object} body
 * @returns {object} Validated parameters
 */
function validateCancellationRulesPayload(body) {
  if (!body || typeof body !== 'object') {
    throw new BadRequestError(
      'Request body must be a valid JSON object.',
      'INVALID_PAYLOAD',
    );
  }

  const { vehicleType, rules, bike, car } = body;

  // Case 1: All Vehicles payload with bike and car arrays
  if (
    vehicleType === 'all'
    || (bike !== undefined && car !== undefined)
  ) {
    if (!bike || !car) {
      throw new BadRequestError(
        'Both bike and car rules must be provided for All Vehicles mode.',
        'MISSING_VEHICLE_RULES',
      );
    }
    validateRulesList(bike, 'bike');
    validateRulesList(car, 'car');
    return {
      mode: 'all',
      bike,
      car,
    };
  }

  // Case 2: Specific vehicle type (bike or car)
  const normType = String(vehicleType || '').toLowerCase().trim();
  if (normType !== 'bike' && normType !== 'car') {
    throw new BadRequestError(
      'vehicleType must be either "bike", "car", or "all".',
      'INVALID_VEHICLE_TYPE',
    );
  }

  const rulesList = rules || (normType === 'bike' ? bike : car);
  if (!rulesList) {
    throw new BadRequestError(
      `Rules array is required for vehicle type "${normType}".`,
      'MISSING_RULES',
    );
  }

  validateRulesList(rulesList, normType);

  return {
    mode: 'single',
    vehicleType: normType,
    rules: rulesList,
  };
}

module.exports = {
  validateRulesList,
  validateCancellationRulesPayload,
};
