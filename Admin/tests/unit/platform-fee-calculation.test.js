'use strict';

const { roundMoney, formatMoney } = require('../../src/utils/money');
const { validatePlatformFeePayload } = require('../../src/validators/platform-fee.validator');
const { PlatformFeeService } = require('../../src/services/platform-fee.service');

describe('Platform Fees: Financial Baselines & Calculation Logic', () => {
  const service = new PlatformFeeService();

  test('1. Baseline calculation: ₹2.50 Service Charge + ₹2.00 Convenience Fee + 18% GST = ₹5.31', () => {
    const serviceCharge = 2.50;
    const convenienceFee = 2.00;
    const gstRate = 18;

    const baseCharges = roundMoney(serviceCharge + convenienceFee);
    expect(baseCharges).toBe(4.50);

    const gstAmount = roundMoney((baseCharges * gstRate) / 100);
    expect(gstAmount).toBe(0.81);

    const totalPlatformFees = roundMoney(baseCharges + gstAmount);
    expect(totalPlatformFees).toBe(5.31);
    expect(formatMoney(totalPlatformFees)).toBe('5.31');

    const calculatedTotal = service.calculateTotalPlatformFees({
      serviceCharge,
      convenienceFee,
      gst: gstRate,
    });
    expect(calculatedTotal).toBe(5.31);
  });

  test('2. Changing Service Charge recalculates total dynamically', () => {
    // Change Service Charge to 5.00
    const serviceCharge = 5.00;
    const convenienceFee = 2.00;
    const gstRate = 18;

    // base = 7.00, gst = 1.26, total = 8.26
    const total = service.calculateTotalPlatformFees({
      serviceCharge,
      convenienceFee,
      gst: gstRate,
    });
    expect(total).toBe(8.26);
  });

  test('3. Changing Convenience Fee recalculates total dynamically', () => {
    // Change Convenience Fee to 4.00
    const serviceCharge = 2.50;
    const convenienceFee = 4.00;
    const gstRate = 18;

    // base = 6.50, gst = 1.17, total = 7.67
    const total = service.calculateTotalPlatformFees({
      serviceCharge,
      convenienceFee,
      gst: gstRate,
    });
    expect(total).toBe(7.67);
  });

  test('4. Changing GST Rate recalculates total dynamically', () => {
    // Change GST Rate to 12%
    const serviceCharge = 2.50;
    const convenienceFee = 2.00;
    const gstRate = 12;

    // base = 4.50, gst = 0.54, total = 5.04
    const total = service.calculateTotalPlatformFees({
      serviceCharge,
      convenienceFee,
      gst: gstRate,
    });
    expect(total).toBe(5.04);
  });

  test('5. Zero service charge and zero convenience fee results in zero total', () => {
    const total = service.calculateTotalPlatformFees({
      serviceCharge: 0,
      convenienceFee: 0,
      gst: 18,
    });
    expect(total).toBe(0);
  });

  test('6. Payload validation preserves only editable settings without totalPlatformFees', () => {
    const rawFormPayload = {
      serviceCharge: 2.50,
      convenienceFee: 2.00,
      gst: 18,
      totalPlatformFees: 5.31, // UI calculated value that should NOT be part of stored settings
    };

    const validated = validatePlatformFeePayload(rawFormPayload);
    expect(validated).toEqual({
      serviceCharge: 2.50,
      convenienceFee: 2.00,
      gst: 18,
    });
    expect(validated.totalPlatformFees).toBeUndefined();
  });

  test('7. Validation rejects negative values and out-of-bound GST', () => {
    expect(() => validatePlatformFeePayload({
      serviceCharge: -1,
      convenienceFee: 2,
      gst: 18,
    })).toThrow();

    expect(() => validatePlatformFeePayload({
      serviceCharge: 2.5,
      convenienceFee: -10,
      gst: 18,
    })).toThrow();

    expect(() => validatePlatformFeePayload({
      serviceCharge: 2.5,
      convenienceFee: 2,
      gst: -1,
    })).toThrow();

    expect(() => validatePlatformFeePayload({
      serviceCharge: 2.5,
      convenienceFee: 2,
      gst: 150,
    })).toThrow();

    expect(() => validatePlatformFeePayload({
      serviceCharge: 'invalid',
      convenienceFee: 2,
      gst: 18,
    })).toThrow();

    expect(() => validatePlatformFeePayload({
      serviceCharge: NaN,
      convenienceFee: 2,
      gst: 18,
    })).toThrow();

    expect(() => validatePlatformFeePayload({
      serviceCharge: Infinity,
      convenienceFee: 2,
      gst: 18,
    })).toThrow();
  });
});
