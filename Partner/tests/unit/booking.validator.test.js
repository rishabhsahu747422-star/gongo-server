'use strict';

const bookingValidator = require('../../src/validators/booking.validator');
const { ValidationError } = require('../../src/errors');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Unit: BookingValidator', () => {
  const validUuid = '11111111-1111-4111-a111-111111111111';

  describe('validateBookingListQuery', () => {
    it('returns default options with no query parameters provided', () => {
      const result = bookingValidator.validateBookingListQuery();
      expect(result).toEqual({
        page: 1,
        limit: 20,
        offset: 0,
      });
    });

    it('parses valid status values successfully', () => {
      const validStatuses = ['UPCOMING', 'CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'ALL'];
      validStatuses.forEach((status) => {
        const result = bookingValidator.validateBookingListQuery({ status: status.toLowerCase() });
        expect(result.status).toBe(status);
      });
    });

    it('rejects invalid status values', () => {
      expect(() => {
        bookingValidator.validateBookingListQuery({ status: 'INVALID_STATUS' });
      }).toThrow(ValidationError);

      try {
        bookingValidator.validateBookingListQuery({ status: 'INVALID_STATUS' });
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.VALIDATION_ERROR);
        expect(err.details[0].field).toBe('status');
      }
    });

    it('parses valid tab values successfully', () => {
      const tabs = ['Upcoming', 'active', 'COMPLETED', 'Cancelled', 'CANCELLED'];
      tabs.forEach((tab) => {
        const result = bookingValidator.validateBookingListQuery({ tab });
        expect(result.tab).toBe(tab.trim());
      });
    });

    it('rejects invalid tab values', () => {
      expect(() => {
        bookingValidator.validateBookingListQuery({ tab: 'invalid_tab' });
      }).toThrow(ValidationError);
    });

    it('validates vehicleId UUID format', () => {
      const result = bookingValidator.validateBookingListQuery({ vehicleId: validUuid });
      expect(result.vehicleId).toBe(validUuid);

      expect(() => {
        bookingValidator.validateBookingListQuery({ vehicleId: 'not-a-uuid' });
      }).toThrow(ValidationError);
    });

    it('parses valid ISO startDate and endDate', () => {
      const query = {
        startDate: '2026-09-20T10:00:00.000Z',
        endDate: '2026-09-25T10:00:00.000Z',
      };
      const result = bookingValidator.validateBookingListQuery(query);
      expect(result.startDate).toBe('2026-09-20T10:00:00.000Z');
      expect(result.endDate).toBe('2026-09-25T10:00:00.000Z');
    });

    it('rejects malformed date strings', () => {
      expect(() => {
        bookingValidator.validateBookingListQuery({ startDate: 'not-a-date' });
      }).toThrow(ValidationError);

      expect(() => {
        bookingValidator.validateBookingListQuery({ endDate: 'not-a-date' });
      }).toThrow(ValidationError);
    });

    it('rejects endDate earlier than startDate', () => {
      expect(() => {
        bookingValidator.validateBookingListQuery({
          startDate: '2026-09-25T10:00:00.000Z',
          endDate: '2026-09-20T10:00:00.000Z',
        });
      }).toThrow(ValidationError);
    });

    it('validates and trims search query', () => {
      const result = bookingValidator.validateBookingListQuery({ search: '  BK-1002  ' });
      expect(result.search).toBe('BK-1002');
    });

    it('rejects search queries longer than 100 characters', () => {
      expect(() => {
        bookingValidator.validateBookingListQuery({ search: 'a'.repeat(101) });
      }).toThrow(ValidationError);
    });

    it('validates page and limit pagination parameters', () => {
      const result = bookingValidator.validateBookingListQuery({ page: '3', limit: '15' });
      expect(result.page).toBe(3);
      expect(result.limit).toBe(15);
      expect(result.offset).toBe(30);
    });

    it('rejects invalid limit values', () => {
      expect(() => {
        bookingValidator.validateBookingListQuery({ limit: '0' });
      }).toThrow(ValidationError);

      expect(() => {
        bookingValidator.validateBookingListQuery({ limit: '101' });
      }).toThrow(ValidationError);

      expect(() => {
        bookingValidator.validateBookingListQuery({ limit: 'abc' });
      }).toThrow(ValidationError);
    });

    it('rejects invalid page values', () => {
      expect(() => {
        bookingValidator.validateBookingListQuery({ page: '0' });
      }).toThrow(ValidationError);

      expect(() => {
        bookingValidator.validateBookingListQuery({ page: '-1' });
      }).toThrow(ValidationError);
    });
  });

  describe('validateBookingId', () => {
    it('accepts and returns a valid UUID string', () => {
      const result = bookingValidator.validateBookingId(validUuid);
      expect(result).toBe(validUuid);
    });

    it('rejects non-UUID identifiers', () => {
      expect(() => {
        bookingValidator.validateBookingId('not-a-uuid');
      }).toThrow(ValidationError);

      expect(() => {
        bookingValidator.validateBookingId(null);
      }).toThrow(ValidationError);

      expect(() => {
        bookingValidator.validateBookingId('');
      }).toThrow(ValidationError);
    });
  });
});
