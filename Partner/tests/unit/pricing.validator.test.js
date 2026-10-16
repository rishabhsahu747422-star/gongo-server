'use strict';

const pricingValidator = require('../../src/validators/pricing.validator');
const { ValidationError } = require('../../src/errors');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Unit: PricingValidator', () => {
  const validFullPricing = {
    pricePerHour: 140,
    pricePer4Hours: 500,
    pricePerDay: 2200,
    securityDeposit: 4000,
    extraKmCharge: 14,
    currency: 'INR',
  };

  it('accepts complete explicit pricing payload', () => {
    const validated = pricingValidator.validatePricing(validFullPricing);
    expect(validated).toEqual({
      pricePerHour: 140,
      // Optional duration slabs (migration 043) are normalized to null when omitted
      price3Hours: null,
      price6Hours: null,
      price12Hours: null,
      pricePer4Hours: 500,
      pricePerDay: 2200,
      securityDeposit: 4000,
      extraKmCharge: 14,
      currency: 'INR',
      isActive: true,
    });
  });

  it('auto-derives pricePerHour and pricePer4Hours when only pricePerDay is provided', () => {
    const payload = {
      pricePerDay: 1500,
      securityDeposit: 3000,
    };
    const validated = pricingValidator.validatePricing(payload);
    expect(validated.pricePerDay).toBe(1500);
    // 1500 / 15 = 100
    expect(validated.pricePerHour).toBe(100);
    // 1500 / 4 = 375
    expect(validated.pricePer4Hours).toBe(375);
    expect(validated.securityDeposit).toBe(3000);
    expect(validated.extraKmCharge).toBe(0);
    expect(validated.currency).toBe('INR');
    expect(validated.isActive).toBe(true);
  });

  it('supports snake_case field names seamlessly', () => {
    const payload = {
      price_per_day: 1200,
      price_per_hour: 80,
      price_per_4_hours: 300,
      security_deposit: 2000,
      extra_km_charge: 10,
    };
    const validated = pricingValidator.validatePricing(payload);
    expect(validated.pricePerDay).toBe(1200);
    expect(validated.pricePerHour).toBe(80);
    expect(validated.pricePer4Hours).toBe(300);
    expect(validated.securityDeposit).toBe(2000);
    expect(validated.extraKmCharge).toBe(10);
    expect(validated.isActive).toBe(true);
  });

  it('rejects missing pricePerDay', () => {
    expect(() => {
      pricingValidator.validatePricing({
        securityDeposit: 1000,
      });
    }).toThrow(ValidationError);
  });

  it('rejects negative rates or deposits', () => {
    expect(() => {
      pricingValidator.validatePricing({
        pricePerDay: -500,
      });
    }).toThrow(ValidationError);

    expect(() => {
      pricingValidator.validatePricing({
        pricePerDay: 1000,
        pricePerHour: -10,
      });
    }).toThrow(ValidationError);

    expect(() => {
      pricingValidator.validatePricing({
        pricePerDay: 1000,
        securityDeposit: -50,
      });
    }).toThrow(ValidationError);
  });

  it('rejects rates exceeding realistic bounds', () => {
    expect(() => {
      pricingValidator.validatePricing({
        pricePerDay: 2000000,
      });
    }).toThrow(ValidationError);
  });

  it('rejects non-INR currency', () => {
    expect(() => {
      pricingValidator.validatePricing({
        pricePerDay: 1000,
        currency: 'USD',
      });
    }).toThrow(ValidationError);
  });

  it('rejects client attempt to inject isActive with MASS_ASSIGNMENT_VIOLATION', () => {
    try {
      pricingValidator.validatePricing({
        pricePerDay: 1000,
        isActive: false,
      });
      throw new Error('Should have thrown ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    }
  });

  it('rejects server-controlled fields with MASS_ASSIGNMENT_VIOLATION', () => {
    const malicious = [
      { ...validFullPricing, id: 'some-uuid' },
      { ...validFullPricing, vehicle_id: 'some-vehicle-uuid' },
      { ...validFullPricing, vehicleId: 'some-vehicle-uuid' },
      { ...validFullPricing, created_at: new Date().toISOString() },
    ];

    malicious.forEach((payload) => {
      try {
        pricingValidator.validatePricing(payload);
        throw new Error('Should have thrown ValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
      }
    });
  });

  it('rejects unknown fields in payload', () => {
    expect(() => {
      pricingValidator.validatePricing({
        ...validFullPricing,
        discountRate: 50,
      });
    }).toThrow(ValidationError);
  });

  it('rejects empty payload or non-object', () => {
    expect(() => pricingValidator.validatePricing({})).toThrow(ValidationError);
    expect(() => pricingValidator.validatePricing(null)).toThrow(ValidationError);
    expect(() => pricingValidator.validatePricing('invalid')).toThrow(ValidationError);
  });
});
