'use strict';

/**
 * Deterministic relative-date helpers for tests.
 *
 * Many fixtures were originally written with hardcoded calendar dates
 * (e.g. '2026-11-01T10:00:00Z'). Those become "time bombs" once real time
 * passes them, because validators and queries compare them against "now"
 * (startAt-not-in-past, coupon valid_from/valid_until vs CURRENT_TIMESTAMP,
 * payment/booking expiry, no-show windows, ...).
 *
 * createDateShifter() keeps the original literals readable in the test source
 * but moves the whole fixture set forward/backward by a whole number of WEEKS so
 * that the earliest ("anchor") date always lands `leadDays`..`leadDays + 6`
 * days after today (UTC). Because every literal is shifted by the same whole
 * number of weeks:
 *   - time-of-day and timezone suffix are preserved exactly,
 *   - day spacing / durations / overlaps between fixtures are identical
 *     (so pricing-by-hours, grace periods, cancellation windows are unchanged),
 *   - weekday is preserved (in case anything is weekday-sensitive),
 *   - the output string keeps the exact original format (with/without millis,
 *     'Z' vs '+05:30', date-only, ...).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(.*)$/s;

const pad = (n, width = 2) => String(n).padStart(width, '0');

function utcDayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function parseDatePrefix(value) {
  const match = DATE_PREFIX.exec(String(value));
  if (!match) {
    throw new Error(`relativeDates: expected a value starting with YYYY-MM-DD, got "${value}"`);
  }
  const [, y, m, d, rest] = match;
  return { dayMs: Date.UTC(Number(y), Number(m) - 1, Number(d)), rest };
}

function formatDay(dayMs) {
  const d = new Date(dayMs);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Shift the calendar-date part of an ISO-like string by `days` whole days,
 * leaving everything after the date (time, millis, offset) untouched.
 */
function shiftIsoByDays(value, days) {
  const { dayMs, rest } = parseDatePrefix(value);
  return `${formatDay(dayMs + days * DAY_MS)}${rest}`;
}

/**
 * @param {string} anchorDate  Earliest fixture date ('YYYY-MM-DD...') of the set.
 * @param {object} [opts]
 * @param {number} [opts.leadDays=14]  Minimum number of days between today and the anchor.
 * @param {number} [opts.now=Date.now()]
 * @returns {(value: string) => string} shifter; also exposes `.shiftDays` and `.date(value)`.
 */
function createDateShifter(anchorDate, { leadDays = 14, now = Date.now() } = {}) {
  const { dayMs: anchorMs } = parseDatePrefix(anchorDate);
  const targetMs = utcDayStart(now) + leadDays * DAY_MS;
  const weeks = Math.ceil((targetMs - anchorMs) / (7 * DAY_MS));
  const shiftDays = weeks * 7 + 0; // "+ 0" normalises -0 from Math.ceil of a small negative

  const shift = (value) => shiftIsoByDays(value, shiftDays);
  shift.shiftDays = shiftDays;
  shift.date = (value) => new Date(shift(value));
  return shift;
}

/**
 * ISO string `dayOffset` days from today (UTC) at the given UTC time.
 * Negative offsets give past dates.
 */
function daysFromNowAt(dayOffset, hour = 0, minute = 0, second = 0, { now = Date.now() } = {}) {
  const base = new Date(now);
  return new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate() + dayOffset,
    hour,
    minute,
    second,
  )).toISOString();
}

module.exports = {
  DAY_MS,
  createDateShifter,
  shiftIsoByDays,
  daysFromNowAt,
};
