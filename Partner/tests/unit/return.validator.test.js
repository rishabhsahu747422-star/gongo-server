'use strict';

const bookingValidator = require('../../src/validators/booking.validator');
const { ValidationError } = require('../../src/errors');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Unit: Return & Damage Validator', () => {
  describe('validateReturnPayload', () => {
    it('accepts an empty return payload object and applies defaults', () => {
      const sanitized = bookingValidator.validateReturnPayload({});
      expect(sanitized).toEqual({
        odometerEnd: undefined,
        fuelLevelEnd: undefined,
        extraKm: 0,
        notes: undefined,
        photos: undefined,
        damageReport: undefined,
      });
    });

    it('accepts a fully populated valid return payload', () => {
      const payload = {
        odometerEnd: 15420.5,
        fuelLevelEnd: 'FULL',
        extraKm: 25.5,
        notes: 'Vehicle in pristine condition, slight mud on tyres.',
        photos: ['storage/keys/return1.jpg', 'storage/keys/return2.jpg'],
      };

      const sanitized = bookingValidator.validateReturnPayload(payload);
      expect(sanitized.odometerEnd).toBe(15420.5);
      expect(sanitized.fuelLevelEnd).toBe('FULL');
      expect(sanitized.extraKm).toBe(25.5);
      expect(sanitized.notes).toBe('Vehicle in pristine condition, slight mud on tyres.');
      expect(sanitized.photos).toHaveLength(2);
    });

    it('accepts optional overtimeCollected boolean flag in return payload', () => {
      const sanitizedChecked = bookingValidator.validateReturnPayload({ overtimeCollected: true });
      expect(sanitizedChecked.overtimeCollected).toBe(true);

      const sanitizedUnchecked = bookingValidator.validateReturnPayload({ overtimeCollected: false });
      expect(sanitizedUnchecked.overtimeCollected).toBe(false);
    });

    it('accepts embedded damage report within return payload', () => {
      const payload = {
        odometerEnd: 15420,
        fuelLevelEnd: 'HALF',
        damageReport: {
          damageType: 'SCRATCH',
          description: 'Minor scratch on left rear bumper',
          estimatedAmount: 1200,
          photos: ['storage/keys/dmg1.jpg'],
        },
      };

      const sanitized = bookingValidator.validateReturnPayload(payload);
      expect(sanitized.damageReport).toBeDefined();
      expect(sanitized.damageReport.damageType).toBe('SCRATCH');
      expect(sanitized.damageReport.description).toBe('Minor scratch on left rear bumper');
      expect(sanitized.damageReport.estimatedAmount).toBe(1200);
      expect(sanitized.damageReport.photos).toHaveLength(1);
    });

    it('rejects protected fields with MASS_ASSIGNMENT_VIOLATION', () => {
      const protectedAttempts = [
        { status: 'COMPLETED' },
        { bookingStatus: 'COMPLETED' },
        { rentalStatus: 'IDLE' },
        { actualReturnAt: '2026-10-01T12:00:00.000Z' },
        { lateFee: 0 },
        { lateMinutes: 0 },
        { partnerId: 'some-id' },
        { verifiedBy: 'user-id' },
        { returnStatus: 'ON_TIME' },
        { totalDistance: 100 },
      ];

      protectedAttempts.forEach((payload) => {
        expect(() => bookingValidator.validateReturnPayload(payload)).toThrow(ValidationError);
        try {
          bookingValidator.validateReturnPayload(payload);
        } catch (err) {
          expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
        }
      });
    });

    it('rejects unknown fields in return payload', () => {
      const payload = {
        odometerEnd: 1000,
        hackerField: 'injected',
      };

      expect(() => bookingValidator.validateReturnPayload(payload)).toThrow(ValidationError);
      try {
        bookingValidator.validateReturnPayload(payload);
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.VALIDATION_ERROR);
        expect(err.details[0].field).toBe('hackerField');
      }
    });

    it('rejects negative odometerEnd or extraKm', () => {
      expect(() => bookingValidator.validateReturnPayload({ odometerEnd: -5 })).toThrow(
        ValidationError,
      );
      expect(() => bookingValidator.validateReturnPayload({ extraKm: -10 })).toThrow(
        ValidationError,
      );
    });

    it('rejects notes exceeding 500 characters', () => {
      const longNotes = 'a'.repeat(501);
      expect(() => bookingValidator.validateReturnPayload({ notes: longNotes })).toThrow(
        ValidationError,
      );
    });

    it('rejects non-object payload', () => {
      expect(() => bookingValidator.validateReturnPayload(null)).toThrow(ValidationError);
      expect(() => bookingValidator.validateReturnPayload('string')).toThrow(ValidationError);
      expect(() => bookingValidator.validateReturnPayload([1, 2, 3])).toThrow(ValidationError);
    });
  });

  describe('validateDamageReportPayload', () => {
    it('accepts a valid damage report payload', () => {
      const payload = {
        damageType: 'DENT',
        description: 'Dent on driver side door from parking lot',
        estimatedAmount: 2500.5,
        photos: ['storage/dent1.jpg'],
      };

      const sanitized = bookingValidator.validateDamageReportPayload(payload);
      expect(sanitized.damageType).toBe('DENT');
      expect(sanitized.description).toBe('Dent on driver side door from parking lot');
      expect(sanitized.estimatedAmount).toBe(2500.5);
      expect(sanitized.photos).toHaveLength(1);
    });

    it('rejects protected fields with MASS_ASSIGNMENT_VIOLATION', () => {
      const protectedAttempts = [
        { status: 'APPROVED', description: 'Dent on bumper' },
        { approvedAmount: 5000, description: 'Dent on bumper' },
        { reportedBy: 'attacker-id', description: 'Dent on bumper' },
        { bookingId: 'booking-id', description: 'Dent on bumper' },
      ];

      protectedAttempts.forEach((payload) => {
        expect(() => bookingValidator.validateDamageReportPayload(payload)).toThrow(
          ValidationError,
        );
        try {
          bookingValidator.validateDamageReportPayload(payload);
        } catch (err) {
          expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
        }
      });
    });

    it('rejects disallowed damage type', () => {
      const payload = {
        damageType: 'TOTAL_WRECK_CUSTOM_TYPE',
        description: 'Complete vehicle damage',
      };

      expect(() => bookingValidator.validateDamageReportPayload(payload)).toThrow(
        ValidationError,
      );
    });

    it('rejects missing or too short description', () => {
      expect(() => bookingValidator.validateDamageReportPayload({ description: 'hi' })).toThrow(
        ValidationError,
      );
      expect(() => bookingValidator.validateDamageReportPayload({})).toThrow(
        ValidationError,
      );
    });

    it('rejects negative estimatedAmount', () => {
      expect(() => bookingValidator.validateDamageReportPayload({
        description: 'Scratched panel',
        estimatedAmount: -100,
      })).toThrow(ValidationError);
    });
  });
});
