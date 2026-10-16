'use strict';

const {
  normalizeTimeString,
  timeToMinutes,
  isOvernightSchedule,
  formatOperatingInfo,
  resolveWorkingHoursFromRows,
  validateWorkingHoursPayload,
} = require('../../src/utils/working-hours');
const partnerValidator = require('../../src/validators/partner.validator');

describe('Working Hours Utility & Validation', () => {
  describe('normalizeTimeString', () => {
    it('normalizes standard 12-hour times with AM/PM', () => {
      expect(normalizeTimeString('9:00 AM')).toBe('09:00 AM');
      expect(normalizeTimeString('09:00 am')).toBe('09:00 AM');
      expect(normalizeTimeString('12:30 pm')).toBe('12:30 PM');
      expect(normalizeTimeString('06:45 PM')).toBe('06:45 PM');
    });

    it('normalizes 24-hour military time formats', () => {
      expect(normalizeTimeString('09:00')).toBe('09:00 AM');
      expect(normalizeTimeString('18:30')).toBe('06:30 PM');
      expect(normalizeTimeString('00:00')).toBe('12:00 AM');
      expect(normalizeTimeString('23:59')).toBe('11:59 PM');
    });

    it('returns null for invalid time strings', () => {
      expect(normalizeTimeString('invalid')).toBeNull();
      expect(normalizeTimeString('25:00')).toBeNull();
      expect(normalizeTimeString('12:60 AM')).toBeNull();
      expect(normalizeTimeString(null)).toBeNull();
      expect(normalizeTimeString('')).toBeNull();
    });
  });

  describe('timeToMinutes', () => {
    it('calculates total minutes from midnight', () => {
      expect(timeToMinutes('12:00 AM')).toBe(0);
      expect(timeToMinutes('09:00 AM')).toBe(540);
      expect(timeToMinutes('12:00 PM')).toBe(720);
      expect(timeToMinutes('01:30 PM')).toBe(810);
      expect(timeToMinutes('11:59 PM')).toBe(1439);
    });
  });

  describe('isOvernightSchedule', () => {
    it('detects overnight hours correctly', () => {
      expect(isOvernightSchedule('06:00 PM', '02:00 AM')).toBe(true);
      expect(isOvernightSchedule('10:00 PM', '06:00 AM')).toBe(true);
      expect(isOvernightSchedule('09:00 AM', '09:00 PM')).toBe(false);
      expect(isOvernightSchedule('08:00 AM', '08:00 AM')).toBe(false);
    });
  });

  describe('formatOperatingInfo', () => {
    it('formats 24 hours schedule', () => {
      expect(formatOperatingInfo({ isOpen24Hours: true })).toBe('Open 24 Hours');
    });

    it('formats overnight schedule', () => {
      expect(formatOperatingInfo({ openingTime: '06:00 PM', closingTime: '02:00 AM' }))
        .toBe('06:00 PM - 02:00 AM');
    });

    it('formats standard schedule', () => {
      expect(formatOperatingInfo({ openingTime: '09:00 AM', closingTime: '09:00 PM' }))
        .toBe('09:00 AM - 09:00 PM');
    });
  });

  describe('resolveWorkingHoursFromRows', () => {
    it('resolves structured working hours when present', () => {
      const row = {
        opening_time: '09:00 AM',
        closing_time: '09:00 PM',
        is_open_24_hours: false,
        operating_info: '09:00 AM - 09:00 PM',
      };
      const resolved = resolveWorkingHoursFromRows(row);
      expect(resolved.isOpen24Hours).toBe(false);
      expect(resolved.openingTime).toBe('09:00 AM');
      expect(resolved.closingTime).toBe('09:00 PM');
      expect(resolved.workingHours.isOvernight).toBe(false);
    });

    it('leaves structured times null if only legacy operating_info exists so existing profiles remain valid', () => {
      const row = {
        operating_info: '08:00 AM - 10:00 PM (All Days)',
      };
      const resolved = resolveWorkingHoursFromRows(row);
      expect(resolved.openingTime).toBeNull();
      expect(resolved.closingTime).toBeNull();
      expect(resolved.isOpen24Hours).toBe(false);
      expect(resolved.operatingInfo).toBe('08:00 AM - 10:00 PM (All Days)');
    });

    it('handles Open 24 Hours legacy string', () => {
      const row = {
        operating_info: 'Open 24 Hours',
      };
      const resolved = resolveWorkingHoursFromRows(row);
      expect(resolved.isOpen24Hours).toBe(true);
      expect(resolved.openingTime).toBeNull();
      expect(resolved.closingTime).toBeNull();
      expect(resolved.operatingInfo).toBe('Open 24 Hours');
    });

    it('gracefully handles missing or empty operating info', () => {
      const resolved = resolveWorkingHoursFromRows({});
      expect(resolved.isOpen24Hours).toBe(false);
      expect(resolved.openingTime).toBeNull();
      expect(resolved.closingTime).toBeNull();
    });
  });

  describe('validateWorkingHoursPayload', () => {
    it('handles open 24 hours without conflicting times', () => {
      const body = {
        isOpen24Hours: true,
        openingTime: '09:00 AM',
        closingTime: '09:00 PM',
      };
      const errors = [];
      const sanitized = {};
      validateWorkingHoursPayload(body, errors, sanitized);

      expect(errors).toHaveLength(0);
      expect(sanitized.isOpen24Hours).toBe(true);
      expect(sanitized.openingTime).toBeNull();
      expect(sanitized.closingTime).toBeNull();
      expect(sanitized.operatingInfo).toBe('Open 24 Hours');
    });

    it('supports overnight schedule', () => {
      const body = {
        openingTime: '06:00 PM',
        closingTime: '02:00 AM',
      };
      const errors = [];
      const sanitized = {};
      validateWorkingHoursPayload(body, errors, sanitized);

      expect(errors).toHaveLength(0);
      expect(sanitized.openingTime).toBe('06:00 PM');
      expect(sanitized.closingTime).toBe('02:00 AM');
      expect(sanitized.isOpen24Hours).toBe(false);
      expect(sanitized.operatingInfo).toBe('06:00 PM - 02:00 AM');
    });

    it('rejects identical opening and closing times when not Open 24 Hours', () => {
      const body = {
        openingTime: '09:00 AM',
        closingTime: '09:00 AM',
        isOpen24Hours: false,
      };
      const errors = [];
      const sanitized = {};
      validateWorkingHoursPayload(body, errors, sanitized);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].field).toBe('closingTime');
    });

    it('rejects invalid opening time', () => {
      const body = {
        openingTime: '99:00 PM',
        closingTime: '10:00 PM',
      };
      const errors = [];
      const sanitized = {};
      validateWorkingHoursPayload(body, errors, sanitized);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].field).toBe('openingTime');
    });
  });

  describe('partnerValidator area & working hours updates', () => {
    it('accepts area and working hours in profile update', () => {
      const result = partnerValidator.validateProfileUpdate({
        area: 'Piplani',
        openingTime: '09:00 AM',
        closingTime: '09:00 PM',
      });

      expect(result.area).toBe('Piplani');
      expect(result.locality).toBe('Piplani');
      expect(result.openingTime).toBe('09:00 AM');
      expect(result.closingTime).toBe('09:00 PM');
    });

    it('accepts locality mapped to area in shop update', () => {
      const result = partnerValidator.validateShopUpdate({
        locality: 'Kolar',
        isOpen24Hours: true,
      });

      expect(result.area).toBe('Kolar');
      expect(result.locality).toBe('Kolar');
      expect(result.isOpen24Hours).toBe(true);
      expect(result.operatingInfo).toBe('Open 24 Hours');
    });
  });
});
