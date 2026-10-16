'use strict';

const { createDateShifter, shiftIsoByDays, daysFromNowAt, DAY_MS } = require('../../helpers/relativeDates');

describe('tests/helpers/relativeDates', () => {
  const now = Date.UTC(2026, 9, 14, 6, 30); // 2026-10-14T06:30Z

  it('shiftIsoByDays keeps time-of-day, millis and offset suffix untouched', () => {
    expect(shiftIsoByDays('2026-11-01T10:00:00Z', 7)).toBe('2026-11-08T10:00:00Z');
    expect(shiftIsoByDays('2026-11-01T10:00:00.000Z', -7)).toBe('2026-10-25T10:00:00.000Z');
    expect(shiftIsoByDays('2026-12-30T10:00:00+05:30', 7)).toBe('2027-01-06T10:00:00+05:30');
    expect(shiftIsoByDays('2026-11-01', 14)).toBe('2026-11-15');
  });

  it('createDateShifter lands the anchor 14-20 days ahead and shifts by whole weeks', () => {
    for (const nowMs of [now, Date.UTC(2027, 0, 2, 6, 30), Date.UTC(2028, 5, 15, 6, 30)]) {
      const relDate = createDateShifter('2026-11-01', { now: nowMs });
      expect(relDate.shiftDays % 7).toBe(0);
      const lead = (new Date(relDate('2026-11-01T00:00:00Z')).getTime() - nowMs) / DAY_MS;
      expect(lead).toBeGreaterThan(13);
      expect(lead).toBeLessThan(21);
      // weekday and spacing preserved
      expect(relDate.date('2026-11-01T10:00:00Z').getUTCDay()).toBe(new Date('2026-11-01T10:00:00Z').getUTCDay());
      expect(relDate.date('2026-11-06T10:00:00Z') - relDate.date('2026-11-05T10:00:00Z')).toBe(DAY_MS);
    }
  });

  it('daysFromNowAt builds a UTC ISO string at the requested time N days from today', () => {
    expect(daysFromNowAt(20, 10, 0, 0, { now })).toBe('2026-11-03T10:00:00.000Z');
    expect(daysFromNowAt(-1, 23, 59, 59, { now })).toBe('2026-10-13T23:59:59.000Z');
  });
});
