'use strict';

const platformFeeRepository = require('../repositories/platform-fee.repository');
const { validatePlatformFeePayload } = require('../validators/platform-fee.validator');
const { NotFoundError, ValidationError } = require('../errors');
const { roundMoney } = require('../utils/money');

class PlatformFeeService {
  constructor(repo = platformFeeRepository) {
    this.repo = repo;
  }

  /**
   * Calculates total platform fee from service charge, convenience fee and GST.
   *
   * Formula:
   * baseCharges = serviceCharge + convenienceFee
   * gstAmount = baseCharges * gst / 100
   * total = baseCharges + gstAmount
   *
   * @param {object} params
   * @param {number|string} params.serviceCharge
   * @param {number|string} params.convenienceFee
   * @param {number|string} params.gst
   * @returns {number}
   */
  calculateTotalPlatformFees({ serviceCharge, convenienceFee, gst }) {
    const sc = Number(serviceCharge || 0);
    const cf = Number(convenienceFee || 0);
    const g = Number(gst || 0);

    const baseCharges = roundMoney(sc + cf);
    const gstAmount = roundMoney((baseCharges * g) / 100);
    return roundMoney(baseCharges + gstAmount);
  }

  /**
   * Retrieves active platform charges configuration.
   *
   * @param {object} [options]
   * @param {boolean} [options.throwIfMissing=true]
   * @param {import('pg').PoolClient} [options.client=null]
   * @returns {Promise<object|null>}
   */
  async getActivePlatformFee({ vehicleType = null, throwIfMissing = true, client = null } = {}) {
    const active = await this.repo.findActive(vehicleType, client);

    if (!active) {
      if (throwIfMissing) {
        throw new NotFoundError('Active platform fee configuration not found');
      }
      return null;
    }

    const formatFeeGroup = (group, isCar = false) => {
      const defaultSc = isCar ? 5.00 : 2.50;
      const defaultCf = isCar ? 3.00 : 2.00;
      const defaultGst = 18.00;

      const scVal = roundMoney(group?.serviceCharge?.value ?? defaultSc);
      const cfVal = roundMoney(group?.convenienceFee?.value ?? defaultCf);
      const gstVal = roundMoney(group?.gst?.value ?? defaultGst);

      return {
        serviceCharge: {
          id: group?.serviceCharge?.id,
          calculationType: group?.serviceCharge?.calculationType || 'fixed',
          value: scVal,
          currency: group?.serviceCharge?.currency || 'INR',
          isActive: group?.serviceCharge?.isActive ?? true,
          createdAt: group?.serviceCharge?.createdAt,
          updatedAt: group?.serviceCharge?.updatedAt,
        },
        convenienceFee: {
          id: group?.convenienceFee?.id,
          calculationType: group?.convenienceFee?.calculationType || 'fixed',
          value: cfVal,
          currency: group?.convenienceFee?.currency || 'INR',
          isActive: group?.convenienceFee?.isActive ?? true,
          createdAt: group?.convenienceFee?.createdAt,
          updatedAt: group?.convenienceFee?.updatedAt,
        },
        gst: {
          id: group?.gst?.id,
          calculationType: group?.gst?.calculationType || 'percentage',
          value: gstVal,
          currency: group?.gst?.currency || 'INR',
          isActive: group?.gst?.isActive ?? true,
          createdAt: group?.gst?.createdAt,
          updatedAt: group?.gst?.updatedAt,
        },
        totalPlatformFees: this.calculateTotalPlatformFees({
          serviceCharge: scVal,
          convenienceFee: cfVal,
          gst: gstVal,
        }),
      };
    };

    if (vehicleType === 'car') {
      return formatFeeGroup(active, true);
    }

    if (vehicleType === 'bike') {
      return formatFeeGroup(active, false);
    }

    const bikeFormatted = formatFeeGroup(active.bike || active, false);
    const carFormatted = formatFeeGroup(active.car || active, true);

    return {
      ...bikeFormatted,
      bike: bikeFormatted,
      car: carFormatted,
    };
  }

  /**
   * Reusable single platform fee calculation helper.
   *
   * @param {object} params
   * @param {string} params.feeType - 'fixed' | 'percentage'
   * @param {number|string} params.feeValue - Fee value (fixed amount or percentage 0-100)
   * @param {number|string} params.baseAmount - Applicable booking/base amount
   * @returns {number} Calculated fee in INR rounded to 2 decimal places
   */
  calculatePlatformFee(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new ValidationError('Calculation parameters must be a valid object');
    }

    const { feeType, feeValue, baseAmount } = params;

    if (!feeType || typeof feeType !== 'string') {
      throw new ValidationError("Invalid feeType: must be 'fixed' or 'percentage'");
    }
    const cleanFeeType = feeType.trim().toLowerCase();
    if (cleanFeeType !== 'fixed' && cleanFeeType !== 'percentage') {
      throw new ValidationError("Invalid feeType: must be 'fixed' or 'percentage'");
    }

    if (
      feeValue === undefined
      || feeValue === null
      || (typeof feeValue === 'string' && feeValue.trim() === '')
    ) {
      throw new ValidationError('feeValue is required for calculation');
    }
    if (typeof feeValue !== 'number' && typeof feeValue !== 'string') {
      throw new ValidationError('feeValue must be a valid number');
    }
    const numericFeeValue = Number(feeValue);
    if (Number.isNaN(numericFeeValue) || !Number.isFinite(numericFeeValue)) {
      throw new ValidationError('feeValue must be a valid number');
    }
    if (numericFeeValue < 0) {
      throw new ValidationError('feeValue cannot be negative');
    }
    if (cleanFeeType === 'percentage' && numericFeeValue > 100) {
      throw new ValidationError('Percentage fee cannot exceed 100');
    }

    if (
      baseAmount === undefined
      || baseAmount === null
      || (typeof baseAmount === 'string' && baseAmount.trim() === '')
    ) {
      throw new ValidationError('baseAmount is required for calculation');
    }
    if (typeof baseAmount !== 'number' && typeof baseAmount !== 'string') {
      throw new ValidationError('baseAmount must be a valid number');
    }
    const numericBase = Number(baseAmount);
    if (Number.isNaN(numericBase) || !Number.isFinite(numericBase)) {
      throw new ValidationError('baseAmount must be a valid number');
    }
    if (numericBase < 0) {
      throw new ValidationError('baseAmount cannot be negative');
    }

    if (cleanFeeType === 'fixed') {
      return roundMoney(numericFeeValue);
    }

    const fee = (numericBase * numericFeeValue) / 100;
    return roundMoney(fee);
  }

  /**
   * Updates or establishes active platform charges configuration.
   *
   * @param {object} payload
   * @param {string|null} [adminId=null] - Authenticated admin user ID
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{ previous: object, current: object }>}
   */
  async updatePlatformFee(payload, adminId = null, client = null) {
    const validated = validatePlatformFeePayload(payload);
    const vehicleType = validated.vehicleType || payload?.vehicleType || null;

    const params = {
      serviceCharge: validated.serviceCharge,
      convenienceFee: validated.convenienceFee,
      gst: validated.gst,
      adminId,
    };
    if (vehicleType) {
      params.vehicleType = vehicleType;
    }

    return this.repo.updateActiveCharges(params, client);
  }
}

const defaultInstance = new PlatformFeeService();

module.exports = defaultInstance;
module.exports.PlatformFeeService = PlatformFeeService;
