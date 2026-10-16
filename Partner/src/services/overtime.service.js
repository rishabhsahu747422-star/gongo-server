'use strict';

/**
 * OvertimeService — authoritative server-side calculation and lifecycle reconciliation
 * for rental overtime duration, pricing, and payment obligations.
 *
 * Rules:
 * 1. Overtime starts strictly from authoritative scheduled return timestamp (scheduled_return_at / end_at).
 * 2. Mobile device clock is NEVER trusted; server timestamp is authoritative.
 * 3. Calculation is deterministic; money is rounded safely without floating-point errors.
 * 4. Separates live overtime accrual from payment obligations to prevent double charging.
 */

const { PAYMENT_TYPE, PAYMENT_STATUS } = require('../constants/payment');

const ROUNDING_RULE = Object.freeze({
  CEIL_HOUR: 'CEIL_HOUR',
  EXACT_PRO_RATA: 'EXACT_PRO_RATA',
  HALF_HOUR: 'HALF_HOUR',
});

function roundMoney(val) {
  const num = Number(val || 0);
  if (Number.isNaN(num) || !Number.isFinite(num)) return 0.00;
  return Math.round(num * 100) / 100;
}

function formatOvertimeDuration(totalSeconds) {
  const secs = Math.max(0, Math.floor(totalSeconds));
  if (secs === 0) return '0m';

  const hours = Math.floor(secs / 3600);
  const remainingSecs = secs % 3600;
  const minutes = Math.floor(remainingSecs / 60);
  const seconds = remainingSecs % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

class OvertimeService {
  /**
   * Evaluates the authoritative overtime state for a booking.
   *
   * @param {object} booking
   * @param {Date} [referenceTime]
   * @param {object} [options]
   * @param {number} [options.gracePeriodMinutes]
   * @param {string} [options.roundingRule]
   * @param {number} [options.rateOverride]
   * @param {Array<object>} [options.existingPayments]
   * @returns {object}
   */
  static calculateOvertimeState(booking, referenceTime = new Date(), options = {}) {
    if (!booking) {
      return {
        isOvertime: false,
        overtimeStartedAt: null,
        scheduledReturnAt: null,
        overtimeDurationSeconds: 0,
        overtimeDurationFormatted: '0m',
        overtimeDurationMinutes: 0,
        gracePeriodMinutes: 15,
        isGracePeriod: false,
        billableHours: 0,
        overtimeRate: 0,
        overtimeAmount: 0.00,
        totalOvertimePaid: 0.00,
        remainingOvertimeDue: 0.00,
        extraPaymentRequired: false,
        extraPaymentStatus: 'NOT_REQUIRED',
        canCompleteReturn: true,
        returnPaymentRequired: false,
      };
    }

    const scheduledRaw = booking.expected_return_at
      || booking.expectedReturnAt
      || booking.end_at
      || booking.endAt;

    if (!scheduledRaw) {
      return {
        isOvertime: false,
        overtimeStartedAt: null,
        scheduledReturnAt: null,
        overtimeDurationSeconds: 0,
        overtimeDurationFormatted: '0m',
        overtimeDurationMinutes: 0,
        gracePeriodMinutes: 15,
        isGracePeriod: false,
        billableHours: 0,
        overtimeRate: 0,
        overtimeAmount: 0.00,
        totalOvertimePaid: 0.00,
        remainingOvertimeDue: 0.00,
        extraPaymentRequired: false,
        extraPaymentStatus: 'NOT_REQUIRED',
        canCompleteReturn: true,
        returnPaymentRequired: false,
      };
    }

    const scheduledDate = new Date(scheduledRaw);
    const scheduledMs = scheduledDate.getTime();
    if (Number.isNaN(scheduledMs)) {
      return {
        isOvertime: false,
        overtimeStartedAt: null,
        scheduledReturnAt: null,
        overtimeDurationSeconds: 0,
        overtimeDurationFormatted: '0m',
        overtimeDurationMinutes: 0,
        gracePeriodMinutes: 15,
        isGracePeriod: false,
        billableHours: 0,
        overtimeRate: 0,
        overtimeAmount: 0.00,
        totalOvertimePaid: 0.00,
        remainingOvertimeDue: 0.00,
        extraPaymentRequired: false,
        extraPaymentStatus: 'NOT_REQUIRED',
        canCompleteReturn: true,
        returnPaymentRequired: false,
      };
    }

    const scheduledIso = scheduledDate.toISOString();
    const serverDate = referenceTime instanceof Date ? referenceTime : new Date(referenceTime);
    const serverMs = serverDate.getTime();

    // Check if vehicle has already been returned or booking completed/cancelled
    const rawStatus = String(booking.booking_status || booking.bookingStatus || booking.status || '').toUpperCase();
    const isReturned = Boolean(booking.returned_at || booking.returnedAt) || ['COMPLETED', 'RETURNED'].includes(rawStatus);
    const isCancelled = ['CANCELLED', 'REFUNDED'].includes(rawStatus);

    // Handover check: Overtime is ONLY applicable for active rentals where vehicle handover occurred
    const isHandoverCompleted = Boolean(
      booking.picked_up_at ||
      booking.pickedUpAt ||
      booking.is_verified ||
      booking.isVerified ||
      ['ACTIVE', 'IN_PROGRESS', 'VEHICLE_PICKED', 'RETURN_PENDING'].includes(rawStatus)
    );

    if (isReturned || isCancelled || !isHandoverCompleted) {
      return {
        isOvertime: false,
        overtimeStartedAt: null,
        scheduledReturnAt: scheduledIso,
        overtimeDurationSeconds: 0,
        overtimeDurationFormatted: '0m',
        overtimeDurationMinutes: 0,
        gracePeriodMinutes: 15,
        isGracePeriod: false,
        billableHours: 0,
        overtimeRate: 0,
        overtimeAmount: 0.00,
        totalOvertimePaid: 0.00,
        remainingOvertimeDue: 0.00,
        extraPaymentRequired: false,
        extraPaymentStatus: 'NOT_REQUIRED',
        canCompleteReturn: true,
        returnPaymentRequired: false,
      };
    }

    const diffMs = serverMs - scheduledMs;

    // Rate resolution
    const resolvedRate = options.rateOverride !== undefined && options.rateOverride !== null
      ? Number(options.rateOverride)
      : Number(
        booking.price_per_hour
        || booking.pricePerHour
        || booking.late_fee_per_hour
        || booking.lateFeePerHour
        || booking.hourlyRate
        || 100,
      );
    const overtimeRate = roundMoney(resolvedRate > 0 ? resolvedRate : 100);

    // If server time <= scheduled return time, not in overtime
    if (diffMs <= 0) {
      return {
        isOvertime: false,
        overtimeStartedAt: null,
        scheduledReturnAt: scheduledIso,
        overtimeDurationSeconds: 0,
        overtimeDurationFormatted: '0m',
        overtimeDurationMinutes: 0,
        gracePeriodMinutes: 15,
        isGracePeriod: false,
        billableHours: 0,
        overtimeRate,
        overtimeAmount: 0.00,
        totalOvertimePaid: 0.00,
        remainingOvertimeDue: 0.00,
        extraPaymentRequired: false,
        extraPaymentStatus: 'NOT_REQUIRED',
        canCompleteReturn: true,
        returnPaymentRequired: false,
      };
    }

    // OVERTIME ACTIVE
    const overtimeDurationSeconds = Math.floor(diffMs / 1000);
    const overtimeDurationFormatted = formatOvertimeDuration(overtimeDurationSeconds);
    const diffMinutes = Math.floor(diffMs / (60 * 1000));

    // Configured grace period & rounding rules (reusing existing 15-minute grace period)
    const DEFAULT_GRACE_PERIOD_MINUTES = 15;
    const gracePeriodMinutes = options.gracePeriodMinutes !== undefined
      ? Number(options.gracePeriodMinutes)
      : (process.env.OVERTIME_GRACE_PERIOD_MINUTES !== undefined
        ? Number(process.env.OVERTIME_GRACE_PERIOD_MINUTES)
        : DEFAULT_GRACE_PERIOD_MINUTES);

    const roundingRule = options.roundingRule || process.env.OVERTIME_ROUNDING_RULE || ROUNDING_RULE.CEIL_HOUR;

    let overtimeAmount = 0.00;
    let billableHours = 0;

    if (diffMinutes > gracePeriodMinutes) {
      if (roundingRule === ROUNDING_RULE.EXACT_PRO_RATA) {
        overtimeAmount = roundMoney((diffMinutes / 60) * overtimeRate);
      } else if (roundingRule === ROUNDING_RULE.HALF_HOUR) {
        const halfHours = Math.ceil(diffMinutes / 30);
        overtimeAmount = roundMoney((halfHours / 2) * overtimeRate);
      } else {
        // Default: CEIL_HOUR
        billableHours = Math.max(1, Math.ceil(diffMinutes / 60));
        overtimeAmount = roundMoney(billableHours * overtimeRate);
      }
    }

    // Payment reconciliation if payment records provided
    let totalOvertimePaid = 0.00;
    let pendingPayment = null;

    if (Array.isArray(options.existingPayments)) {
      for (const p of options.existingPayments) {
        const type = (p.payment_type || p.paymentType || '').toUpperCase();
        if (type === 'OVERTIME_CHARGE' || type === 'POST_RENTAL_SETTLEMENT') {
          const status = String(p.status || '').toLowerCase();
          if (status === 'paid' || status === 'success') {
            totalOvertimePaid = roundMoney(totalOvertimePaid + Number(p.amount || 0));
          } else if (status === 'pending' || status === 'initiated' || status === 'authorized') {
            pendingPayment = p;
          }
        }
      }
    }

    const remainingOvertimeDue = Math.max(0, roundMoney(overtimeAmount - totalOvertimePaid));
    const extraPaymentRequired = remainingOvertimeDue > 0;

    let extraPaymentStatus = 'NOT_REQUIRED';
    if (extraPaymentRequired) {
      extraPaymentStatus = pendingPayment ? 'PENDING' : 'PENDING';
    } else if (totalOvertimePaid > 0) {
      extraPaymentStatus = 'PAID';
    }

    const canCompleteReturn = !extraPaymentRequired;
    const returnPaymentRequired = extraPaymentRequired;

    return {
      isOvertime: true,
      overtimeStartedAt: scheduledIso,
      scheduledReturnAt: scheduledIso,
      overtimeDurationSeconds,
      overtimeDurationFormatted,
      overtimeDurationMinutes: diffMinutes,
      gracePeriodMinutes,
      isGracePeriod: diffMinutes <= gracePeriodMinutes,
      billableHours,
      overtimeRate,
      overtimeAmount,
      totalOvertimePaid,
      remainingOvertimeDue,
      extraPaymentRequired,
      extraPaymentStatus,
      canCompleteReturn,
      returnPaymentRequired,
    };
  }

  /**
   * Extracts persisted overtime details from a completed booking or return verification record.
   *
   * @param {object} booking
   * @param {object} [returnVerification]
   * @returns {object}
   */
  static extractPersistedOvertime(booking, returnVerification = null) {
    if (!booking) {
      return {
        hasOvertime: false,
        scheduledReturnAt: null,
        actualReturnAt: null,
        overtimeDurationMinutes: 0,
        overtimeDurationFormatted: '0m',
        gracePeriodMinutes: 15,
        billableHours: 0,
        hourlyRate: 0,
        overtimeRate: 0,
        overtimeAmount: 0.00,
        finalOvertimeAmount: 0.00,
        overtimePaymentStatus: 'NOT_REQUIRED',
        paymentReference: null,
      };
    }

    const notesRaw = (returnVerification && returnVerification.notes)
      || booking.return_notes
      || booking.notes;

    let parsedJson = null;
    if (typeof notesRaw === 'string' && notesRaw.trim().startsWith('{')) {
      try {
        parsedJson = JSON.parse(notesRaw);
      } catch {}
    } else if (typeof notesRaw === 'object' && notesRaw !== null) {
      parsedJson = notesRaw;
    }

    const overtimeJson = parsedJson?.overtime
      || parsedJson?.overtimeDetails
      || (parsedJson?.scheduledReturnAt ? parsedJson : null);

    const scheduledReturnAt = overtimeJson?.scheduledReturnAt
      || booking.expected_return_at
      || booking.expectedReturnAt
      || booking.end_at
      || booking.endAt
      || null;

    const actualReturnAt = overtimeJson?.actualReturnAt
      || (returnVerification && returnVerification.returned_at)
      || booking.returned_at
      || booking.returnedAt
      || null;

    const lateMinutes = overtimeJson?.overtimeDurationMinutes !== undefined
      ? Number(overtimeJson.overtimeDurationMinutes)
      : (returnVerification && returnVerification.late_minutes !== undefined
        ? Number(returnVerification.late_minutes)
        : Number(booking.late_minutes || 0));

    const lateFee = overtimeJson?.overtimeAmount !== undefined
      ? Number(overtimeJson.overtimeAmount)
      : (returnVerification && returnVerification.late_fee !== undefined
        ? Number(returnVerification.late_fee)
        : Number(booking.return_late_fee || booking.late_fee || 0));

    const hourlyRate = overtimeJson?.hourlyRate !== undefined
      ? Number(overtimeJson.hourlyRate)
      : Number(booking.price_per_hour || booking.pricePerHour || booking.hourlyRate || 100);

    const gracePeriodMinutes = overtimeJson?.gracePeriodMinutes !== undefined
      ? Number(overtimeJson.gracePeriodMinutes)
      : 15;

    const billableHours = overtimeJson?.billableHours !== undefined
      ? Number(overtimeJson.billableHours)
      : (lateMinutes > gracePeriodMinutes ? Math.max(1, Math.ceil(lateMinutes / 60)) : 0);

    const overtimePaymentStatus = overtimeJson?.overtimePaymentStatus
      || (lateFee > 0 ? (['COMPLETED', 'RETURNED'].includes(String(booking.booking_status || booking.status || '').toUpperCase()) ? 'PAID' : 'PENDING') : 'NOT_REQUIRED');

    const paymentReference = overtimeJson?.paymentReference || null;
    const collectionDetails = overtimeJson?.collectionDetails || null;

    return {
      hasOvertime: lateMinutes > 0,
      scheduledReturnAt,
      actualReturnAt,
      overtimeDurationMinutes: lateMinutes,
      overtimeDurationFormatted: formatOvertimeDuration(lateMinutes * 60),
      gracePeriodMinutes,
      billableHours,
      hourlyRate,
      overtimeRate: hourlyRate,
      overtimeAmount: roundMoney(lateFee),
      finalOvertimeAmount: roundMoney(lateFee),
      overtimePaymentStatus,
      paymentReference,
      collectionDetails,
      confirmedAmount: overtimeJson?.confirmedAmount !== undefined ? Number(overtimeJson.confirmedAmount) : (overtimePaymentStatus === 'COLLECTED_BY_PARTNER' ? roundMoney(lateFee) : null),
      waivedAmount: overtimeJson?.waivedAmount !== undefined ? Number(overtimeJson.waivedAmount) : (overtimePaymentStatus === 'WAIVED_BY_PARTNER' ? roundMoney(lateFee) : null),
    };
  }
}

module.exports = OvertimeService;
module.exports.ROUNDING_RULE = ROUNDING_RULE;
module.exports.roundMoney = roundMoney;
module.exports.formatOvertimeDuration = formatOvertimeDuration;
