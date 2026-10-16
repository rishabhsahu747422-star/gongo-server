'use strict';

const availabilityValidator = require('../../src/validators/availability.validator');
const { ValidationError } = require('../../src/errors');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Unit: AvailabilityValidator', () => {
  const futureStart = new Date(Date.now() + 86400000).toISOString();
  const futureEnd = new Date(Date.now() + 2 * 86400000).toISOString();

  describe('validateCreateBlock', () => {
    it('accepts valid block creation payload', () => {
      const payload = {
        startTime: futureStart,
        endTime: futureEnd,
        reason: 'Service',
      };
      const validated = availabilityValidator.validateCreateBlock(payload);
      expect(validated.startTime).toBe(futureStart);
      expect(validated.endTime).toBe(futureEnd);
      expect(validated.reason).toBe('Service');
    });

    it('defaults reason to Maintenance when not specified', () => {
      const payload = {
        startTime: futureStart,
        endTime: futureEnd,
      };
      const validated = availabilityValidator.validateCreateBlock(payload);
      expect(validated.reason).toBe('Maintenance');
    });

    it('normalizes case-insensitive reason', () => {
      const payload = {
        startTime: futureStart,
        endTime: futureEnd,
        reason: 'personal use',
      };
      const validated = availabilityValidator.validateCreateBlock(payload);
      expect(validated.reason).toBe('Personal Use');
    });

    it('rejects missing startTime or endTime', () => {
      expect(() => {
        availabilityValidator.validateCreateBlock({ endTime: futureEnd });
      }).toThrow(ValidationError);

      expect(() => {
        availabilityValidator.validateCreateBlock({ startTime: futureStart });
      }).toThrow(ValidationError);
    });

    it('rejects invalid date format', () => {
      expect(() => {
        availabilityValidator.validateCreateBlock({
          startTime: 'not-a-date',
          endTime: futureEnd,
        });
      }).toThrow(ValidationError);
    });

    it('rejects endTime <= startTime', () => {
      expect(() => {
        availabilityValidator.validateCreateBlock({
          startTime: futureEnd,
          endTime: futureStart,
        });
      }).toThrow(ValidationError);

      expect(() => {
        availabilityValidator.validateCreateBlock({
          startTime: futureStart,
          endTime: futureStart,
        });
      }).toThrow(ValidationError);
    });

    it('rejects disallowed reason outside taxonomy', () => {
      expect(() => {
        availabilityValidator.validateCreateBlock({
          startTime: futureStart,
          endTime: futureEnd,
          reason: 'Holiday Trip',
        });
      }).toThrow(ValidationError);
    });

    it('rejects server-controlled fields with MASS_ASSIGNMENT_VIOLATION', () => {
      const malicious = [
        { startTime: futureStart, endTime: futureEnd, id: 'some-uuid' },
        { startTime: futureStart, endTime: futureEnd, vehicle_id: 'some-vehicle-uuid' },
        { startTime: futureStart, endTime: futureEnd, created_by: 'some-user-uuid' },
      ];

      malicious.forEach((payload) => {
        try {
          availabilityValidator.validateCreateBlock(payload);
          throw new Error('Should have thrown ValidationError');
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
        }
      });
    });

    it('rejects unknown fields', () => {
      expect(() => {
        availabilityValidator.validateCreateBlock({
          startTime: futureStart,
          endTime: futureEnd,
          customNote: 'Note',
        });
      }).toThrow(ValidationError);
    });
  });

  describe('validateUpdateBlock', () => {
    it('accepts valid partial update', () => {
      const validated = availabilityValidator.validateUpdateBlock({
        reason: 'Damage',
      });
      expect(validated.reason).toBe('Damage');
    });

    it('rejects client attempt to inject isActive with MASS_ASSIGNMENT_VIOLATION', () => {
      try {
        availabilityValidator.validateUpdateBlock({
          isActive: false,
        });
        throw new Error('Should have thrown ValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
      }
    });

    it('rejects update with endTime <= startTime when both provided', () => {
      expect(() => {
        availabilityValidator.validateUpdateBlock({
          startTime: futureEnd,
          endTime: futureStart,
        });
      }).toThrow(ValidationError);
    });

    it('rejects server-controlled fields in update', () => {
      expect(() => {
        availabilityValidator.validateUpdateBlock({
          id: 'some-id',
        });
      }).toThrow(ValidationError);
    });

    it('rejects empty update payload', () => {
      expect(() => availabilityValidator.validateUpdateBlock({})).toThrow(ValidationError);
    });
  });

  describe('validateAvailabilityQuery', () => {
    it('applies standard defaults for query', () => {
      const options = availabilityValidator.validateAvailabilityQuery({});
      expect(options.limit).toBe(100);
      expect(options.offset).toBe(0);
      expect(options.isActive).toBe(true);
    });

    it('accepts valid date range filtering', () => {
      const options = availabilityValidator.validateAvailabilityQuery({
        startDate: futureStart,
        endDate: futureEnd,
        isActive: 'false',
        limit: '50',
        page: '2',
      });
      expect(options.startDate).toBe(futureStart);
      expect(options.endDate).toBe(futureEnd);
      expect(options.isActive).toBe(false);
      expect(options.limit).toBe(50);
      expect(options.offset).toBe(50);
    });

    it('supports isActive=all to fetch all blocks', () => {
      const options = availabilityValidator.validateAvailabilityQuery({
        isActive: 'all',
      });
      expect(options.isActive).toBeNull();
    });

    it('rejects startDate > endDate', () => {
      expect(() => {
        availabilityValidator.validateAvailabilityQuery({
          startDate: futureEnd,
          endDate: futureStart,
        });
      }).toThrow(ValidationError);
    });
  });
});
