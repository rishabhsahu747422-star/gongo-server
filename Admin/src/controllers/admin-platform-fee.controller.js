'use strict';

const platformFeeService = require('../services/platform-fee.service');
const { sendSuccess } = require('../utils/response');

function formatAdminPlatformFee(fee, isCar = false) {
  if (!fee) return null;

  const defaultSc = isCar ? 5.00 : 2.50;
  const defaultCf = isCar ? 3.00 : 2.00;
  const defaultGst = 18.00;

  const formatted = {
    serviceCharge: {
      id: fee.serviceCharge?.id,
      calculationType: fee.serviceCharge?.calculationType || 'fixed',
      value: Number(fee.serviceCharge?.value ?? defaultSc),
      currency: fee.serviceCharge?.currency || 'INR',
      isActive: fee.serviceCharge?.isActive ?? true,
      createdAt: fee.serviceCharge?.createdAt,
      updatedAt: fee.serviceCharge?.updatedAt,
    },
    convenienceFee: {
      id: fee.convenienceFee?.id,
      calculationType: fee.convenienceFee?.calculationType || 'fixed',
      value: Number(fee.convenienceFee?.value ?? defaultCf),
      currency: fee.convenienceFee?.currency || 'INR',
      isActive: fee.convenienceFee?.isActive ?? true,
      createdAt: fee.convenienceFee?.createdAt,
      updatedAt: fee.convenienceFee?.updatedAt,
    },
    gst: {
      id: fee.gst?.id,
      calculationType: fee.gst?.calculationType || 'percentage',
      value: Number(fee.gst?.value ?? defaultGst),
      currency: fee.gst?.currency || 'INR',
      isActive: fee.gst?.isActive ?? true,
      createdAt: fee.gst?.createdAt,
      updatedAt: fee.gst?.updatedAt,
    },
  };

  if (fee.totalPlatformFees !== undefined) {
    formatted.totalPlatformFees = Number(fee.totalPlatformFees);
  } else {
    const sc = Number(formatted.serviceCharge?.value || 0);
    const cf = Number(formatted.convenienceFee?.value || 0);
    const g = Number(formatted.gst?.value || 0);
    const base = Math.round((sc + cf + Number.EPSILON) * 100) / 100;
    const gstAmt = Math.round(((base * g) / 100 + Number.EPSILON) * 100) / 100;
    formatted.totalPlatformFees = Math.round((base + gstAmt + Number.EPSILON) * 100) / 100;
  }

  if (fee.bike) {
    formatted.bike = formatAdminPlatformFee(fee.bike, false);
  }

  if (fee.car) {
    formatted.car = formatAdminPlatformFee(fee.car, true);
  }

  return formatted;
}

class AdminPlatformFeeController {
  constructor(service = platformFeeService) {
    this.service = service;
  }

  /**
   * GET /admin/platform-fee
   * Retrieves active platform charge configuration.
   */
  async getPlatformFee(req, res, next) {
    try {
      const vehicleType = req.query?.vehicleType || req.params?.vehicleType || null;
      const isCar = vehicleType === 'car';
      const active = await this.service.getActivePlatformFee({ vehicleType });
      return sendSuccess(res, formatAdminPlatformFee(active, isCar));
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PUT /admin/platform-fee
   * Updates active platform charge configuration.
   */
  async updatePlatformFee(req, res, next) {
    try {
      const adminId = req.user?.id || null;
      const vehicleType = req.params?.vehicleType || req.query?.vehicleType || req.body?.vehicleType || 'bike';
      const isCar = String(vehicleType).toLowerCase().trim() === 'car';
      const payload = {
        ...req.body,
        vehicleType: isCar ? 'car' : 'bike',
      };
      const result = await this.service.updatePlatformFee(payload, adminId);

      if (req.audit) {
        req.audit({
          action: 'PLATFORM_FEE_UPDATE',
          targetResource: 'PLATFORM_CHARGE_SETTINGS',
          targetResourceId: `platform_charges_${isCar ? 'car' : 'bike'}`,
          beforeState: result.previous,
          afterState: result.current,
          metadata: {
            vehicleType: isCar ? 'car' : 'bike',
            serviceCharge: result.current?.serviceCharge?.value,
            convenienceFee: result.current?.convenienceFee?.value,
            gst: result.current?.gst?.value,
          },
        });
      }

      return sendSuccess(res, formatAdminPlatformFee(result.current, isCar));
    } catch (err) {
      return next(err);
    }
  }
}

const defaultInstance = new AdminPlatformFeeController();

module.exports = defaultInstance;
module.exports.AdminPlatformFeeController = AdminPlatformFeeController;
module.exports.formatAdminPlatformFee = formatAdminPlatformFee;
