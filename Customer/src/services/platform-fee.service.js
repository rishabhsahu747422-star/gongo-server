'use strict';

const PlatformFeeRepository = require('../repositories/platform-fee.repository');
const { NotFoundError, BadRequestError } = require('../errors');
const { roundMoney } = require('../utils/money');

class PlatformFeeService {
  constructor(repo = new PlatformFeeRepository()) {
    this.repo = repo;
  }

  /**
   * Retrieves the current active platform fee configuration.
   *
   * @param {object} [options]
   * @param {boolean} [options.throwIfMissing=true]
   * @param {import('pg').PoolClient} [options.client=null]
   * @returns {Promise<object|null>}
   */
  async getActivePlatformFee({ throwIfMissing = true, client = null } = {}) {
    const active = await this.repo.findActive(client);

    if (!active) {
      if (throwIfMissing) {
        throw new NotFoundError('Active platform fee configuration not found', 'PLATFORM_FEE_NOT_FOUND');
      }
      return null;
    }

    return {
      id: active.id,
      feeType: active.feeType,
      feeValue: active.feeValue,
      currency: active.currency,
      isActive: active.isActive,
      createdBy: active.createdBy,
      createdAt: active.createdAt,
      updatedAt: active.updatedAt,
    };
  }

  /**
   * Reusable platform fee calculation helper.
   *
   * Business rules:
   * - Fixed: feeValue = fixed INR amount. Result = feeValue.
   * - Percentage: platformFee = baseAmount * feeValue / 100.
   * - Rounded to 2 decimal places using standard monetary rounding.
   * - Validates feeType, feeValue, and baseAmount boundaries.
   *
   * @param {object} params
   * @param {string} params.feeType - 'fixed' | 'percentage'
   * @param {number|string} params.feeValue - Fee value (fixed amount or percentage 0-100)
   * @param {number|string} params.baseAmount - Applicable booking/base amount
   * @returns {number} Calculated platform fee in INR rounded to 2 decimal places
   */
  calculatePlatformFee(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new BadRequestError('Calculation parameters must be a valid object', 'INVALID_PARAMETERS');
    }

    const { feeType, feeValue, baseAmount } = params;

    // 1. Validate feeType
    if (!feeType || typeof feeType !== 'string') {
      throw new BadRequestError("Invalid feeType: must be 'fixed' or 'percentage'", 'INVALID_FEE_TYPE');
    }
    const cleanFeeType = feeType.trim().toLowerCase();
    if (cleanFeeType !== 'fixed' && cleanFeeType !== 'percentage') {
      throw new BadRequestError("Invalid feeType: must be 'fixed' or 'percentage'", 'INVALID_FEE_TYPE');
    }

    // 2. Validate feeValue
    if (
      feeValue === undefined
      || feeValue === null
      || (typeof feeValue === 'string' && feeValue.trim() === '')
    ) {
      throw new BadRequestError('feeValue is required for calculation', 'INVALID_FEE_VALUE');
    }
    if (typeof feeValue !== 'number' && typeof feeValue !== 'string') {
      throw new BadRequestError('feeValue must be a valid number', 'INVALID_FEE_VALUE');
    }
    const numericFeeValue = Number(feeValue);
    if (Number.isNaN(numericFeeValue) || !Number.isFinite(numericFeeValue)) {
      throw new BadRequestError('feeValue must be a valid number', 'INVALID_FEE_VALUE');
    }
    if (numericFeeValue < 0) {
      throw new BadRequestError('feeValue cannot be negative', 'INVALID_FEE_VALUE');
    }
    if (cleanFeeType === 'percentage' && numericFeeValue > 100) {
      throw new BadRequestError('Percentage fee cannot exceed 100', 'INVALID_FEE_VALUE');
    }

    // 3. Validate baseAmount
    if (
      baseAmount === undefined
      || baseAmount === null
      || (typeof baseAmount === 'string' && baseAmount.trim() === '')
    ) {
      throw new BadRequestError('baseAmount is required for calculation', 'INVALID_BASE_AMOUNT');
    }
    if (typeof baseAmount !== 'number' && typeof baseAmount !== 'string') {
      throw new BadRequestError('baseAmount must be a valid number', 'INVALID_BASE_AMOUNT');
    }
    const numericBase = Number(baseAmount);
    if (Number.isNaN(numericBase) || !Number.isFinite(numericBase)) {
      throw new BadRequestError('baseAmount must be a valid number', 'INVALID_BASE_AMOUNT');
    }
    if (numericBase < 0) {
      throw new BadRequestError('baseAmount cannot be negative', 'INVALID_BASE_AMOUNT');
    }

    // 4. Calculate based on feeType
    if (cleanFeeType === 'fixed') {
      return roundMoney(numericFeeValue);
    }

    // Percentage fee
    const fee = (numericBase * numericFeeValue) / 100;
    return roundMoney(fee);
  }

  /**
   * Authoritatively calculates all active platform charges for a given rental amount
   * using the database-configured charge types: convenience_fee, service_charge, gst.
   *
   * Business rules:
   * - convenience_fee:
   *   fixed -> fixed value
   *   percentage -> (rentalAmount * value) / 100
   * - service_charge:
   *   fixed -> fixed value
   *   percentage -> (rentalAmount * value) / 100
   * - gst:
   *   percentage -> ((convenience_fee + service_charge) * value) / 100
   *   fixed -> fixed value
   *
   * @param {number|string} [rentalAmount=0] - Applicable discounted rental amount
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{
   *   convenienceFee: number,
   *   serviceCharge: number,
   *   gst: number,
   *   platformFee: number,
   *   totalFeesAndTax: number,
   *   activeCharges: object,
   * }>}
   */
  async calculateChargesForRental(rentalAmount = 0, clientOrOptions = null, maybeOptions = {}) {
    let client = null;
    let options = {};

    if (clientOrOptions && typeof clientOrOptions.query === 'function') {
      client = clientOrOptions;
      options = maybeOptions || {};
    } else if (typeof clientOrOptions === 'string') {
      options = { vehicleCategory: clientOrOptions };
    } else if (clientOrOptions && typeof clientOrOptions === 'object') {
      options = clientOrOptions;
    }

    const category = String(options.vehicleCategory || options.category || 'BIKE').toUpperCase();
    const isCar = category === 'CAR';

    const rows = await this.repo.findActiveCharges(client);

    const activeCharges = {
      convenienceFee: null,
      serviceCharge: null,
      gst: null,
    };

    if (Array.isArray(rows)) {
      rows.forEach((row) => {
        if (!row || !row.is_active) return;
        const item = {
          id: row.id,
          calculationType: (row.calculation_type || 'fixed').toLowerCase(),
          value: Number(row.value || 0),
          currency: row.currency || 'INR',
          isActive: Boolean(row.is_active),
        };

        if (isCar) {
          if (row.charge_type === 'convenience_fee_car') {
            activeCharges.convenienceFee = item;
          } else if (row.charge_type === 'service_charge_car') {
            activeCharges.serviceCharge = item;
          } else if (row.charge_type === 'gst_car') {
            activeCharges.gst = item;
          }
        } else {
          if (row.charge_type === 'convenience_fee') {
            activeCharges.convenienceFee = item;
          } else if (row.charge_type === 'service_charge') {
            activeCharges.serviceCharge = item;
          } else if (row.charge_type === 'gst') {
            activeCharges.gst = item;
          }
        }
      });
    }

    // Default fallbacks if car charges are not yet present in mock or older DB snapshot
    if (isCar) {
      if (!activeCharges.serviceCharge) {
        activeCharges.serviceCharge = { calculationType: 'fixed', value: 5.00, currency: 'INR', isActive: true };
      }
      if (!activeCharges.convenienceFee) {
        activeCharges.convenienceFee = { calculationType: 'fixed', value: 3.00, currency: 'INR', isActive: true };
      }
      if (!activeCharges.gst) {
        activeCharges.gst = { calculationType: 'percentage', value: 18.00, currency: 'INR', isActive: true };
      }
    }

    const cleanRental = Math.max(0, Number(rentalAmount || 0));

    // A) Convenience Fee
    let convenienceFee = 0;
    if (activeCharges.convenienceFee?.isActive) {
      const { calculationType, value } = activeCharges.convenienceFee;
      if (calculationType === 'fixed') {
        convenienceFee = roundMoney(value);
      } else if (calculationType === 'percentage') {
        convenienceFee = roundMoney((cleanRental * value) / 100);
      }
    }

    // B) Service Charge
    let serviceCharge = 0;
    if (activeCharges.serviceCharge?.isActive) {
      const { calculationType, value } = activeCharges.serviceCharge;
      if (calculationType === 'fixed') {
        serviceCharge = roundMoney(value);
      } else if (calculationType === 'percentage') {
        serviceCharge = roundMoney((cleanRental * value) / 100);
      }
    }

    // C) GST (calculated on platform charges: convenienceFee + serviceCharge)
    let gst = 0;
    if (activeCharges.gst?.isActive) {
      const { calculationType, value } = activeCharges.gst;
      if (calculationType === 'percentage') {
        const baseForGst = roundMoney(convenienceFee + serviceCharge);
        gst = roundMoney((baseForGst * value) / 100);
      } else if (calculationType === 'fixed') {
        gst = roundMoney(value);
      }
    }

    const platformFee = roundMoney(convenienceFee + serviceCharge);
    const totalFeesAndTax = roundMoney(platformFee + gst);

    return {
      convenienceFee,
      serviceCharge,
      gst,
      platformFee,
      totalFeesAndTax,
      activeCharges,
      vehicleCategory: isCar ? 'CAR' : 'BIKE',
    };
  }
}

const defaultInstance = new PlatformFeeService();

module.exports = defaultInstance;
module.exports.PlatformFeeService = PlatformFeeService;
