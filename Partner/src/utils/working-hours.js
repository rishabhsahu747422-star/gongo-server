'use strict';

const TIME_12H_REGEX = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
const TIME_24H_REGEX = /^(\d{1,2}):(\d{2})$/;

/**
 * Validates and normalizes a time string into canonical "hh:mm AM/PM" format.
 * Accepts 12-hour ("9:00 AM", "09:00 AM", "06:00 PM") or 24-hour ("09:00", "18:00", "00:00").
 *
 * @param {string} val
 * @returns {string|null} Canonical "hh:mm AM/PM" string or null if invalid
 */
function normalizeTimeString(val) {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (!trimmed) return null;

  const match12 = trimmed.match(TIME_12H_REGEX);
  if (match12) {
    const hour = Number(match12[1]);
    const minute = Number(match12[2]);
    const period = match12[3].toUpperCase();
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
      return null;
    }
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return `${hh}:${mm} ${period}`;
  }

  const match24 = trimmed.match(TIME_24H_REGEX);
  if (match24) {
    const hour24 = Number(match24[1]);
    const minute = Number(match24[2]);
    if (hour24 < 0 || hour24 > 23 || minute < 0 || minute > 59) {
      return null;
    }
    const period = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const hh = String(hour12).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return `${hh}:${mm} ${period}`;
  }

  return null;
}

/**
 * Converts a normalized "hh:mm AM/PM" time string to minutes from midnight (0..1439).
 *
 * @param {string} timeStr
 * @returns {number|null}
 */
function timeToMinutes(timeStr) {
  const norm = normalizeTimeString(timeStr);
  if (!norm) return null;
  const match = norm.match(TIME_12H_REGEX);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  const minute = Number(match[2]);
  const period = match[3].toUpperCase();
  if (period === 'PM') hour += 12;
  return hour * 60 + minute;
}

/**
 * Checks whether an opening and closing time pair represents an overnight schedule
 * (e.g., 06:00 PM to 02:00 AM).
 *
 * @param {string|null} openingTime
 * @param {string|null} closingTime
 * @returns {boolean}
 */
function isOvernightSchedule(openingTime, closingTime) {
  const openMins = timeToMinutes(openingTime);
  const closeMins = timeToMinutes(closingTime);
  if (openMins === null || closeMins === null) return false;
  return closeMins < openMins;
}

/**
 * Formats structured working hours into human-readable operatingInfo text.
 *
 * @param {object} params
 * @param {string|null} [params.openingTime]
 * @param {string|null} [params.closingTime]
 * @param {boolean} [params.isOpen24Hours]
 * @param {string|null} [params.fallbackOperatingInfo]
 * @returns {string|null}
 */
function formatOperatingInfo({
  openingTime = null,
  closingTime = null,
  isOpen24Hours = false,
  fallbackOperatingInfo = null,
} = {}) {
  if (isOpen24Hours === true) {
    return 'Open 24 Hours';
  }
  if (openingTime && closingTime) {
    return `${openingTime} - ${closingTime}`;
  }
  return fallbackOperatingInfo || null;
}

/**
 * Extracts and normalizes working hours from database row(s).
 * Handles existing records with missing structured working hours gracefully.
 *
 * @param {object|null} primaryRow
 * @param {object|null} [secondaryRow]
 * @returns {{
 *   openingTime: string|null,
 *   closingTime: string|null,
 *   isOpen24Hours: boolean,
 *   operatingInfo: string|null,
 *   workingHours: {
 *     openingTime: string|null,
 *     closingTime: string|null,
 *     isOpen24Hours: boolean,
 *     isOvernight: boolean
 *   }
 * }}
 */
function resolveWorkingHoursFromRows(primaryRow = null, secondaryRow = null) {
  const p = primaryRow || {};
  const s = secondaryRow || {};

  const rawIs24 = (p.is_open_24_hours !== undefined && p.is_open_24_hours !== null)
    ? Boolean(p.is_open_24_hours)
    : ((s.is_open_24_hours !== undefined && s.is_open_24_hours !== null)
      ? Boolean(s.is_open_24_hours)
      : false);

  const rawOpen = p.opening_time || s.opening_time || null;
  const rawClose = p.closing_time || s.closing_time || null;
  const rawOpInfo = p.operating_info || s.operating_info || null;

  if (rawIs24) {
    const operatingInfo = 'Open 24 Hours';
    return {
      openingTime: null,
      closingTime: null,
      isOpen24Hours: true,
      operatingInfo,
      workingHours: {
        openingTime: null,
        closingTime: null,
        isOpen24Hours: true,
        isOvernight: false,
      },
    };
  }

  if (rawOpen && rawClose) {
    const openingTime = normalizeTimeString(rawOpen) || rawOpen;
    const closingTime = normalizeTimeString(rawClose) || rawClose;
    const isOvernight = isOvernightSchedule(openingTime, closingTime);
    const operatingInfo = `${openingTime} - ${closingTime}${isOvernight ? ' (Next Day)' : ''}`;
    return {
      openingTime,
      closingTime,
      isOpen24Hours: false,
      operatingInfo,
      workingHours: {
        openingTime,
        closingTime,
        isOpen24Hours: false,
        isOvernight,
      },
    };
  }

  if (typeof rawOpInfo === 'string' && /^open\s*24\s*hours$/i.test(rawOpInfo.trim())) {
    return {
      openingTime: null,
      closingTime: null,
      isOpen24Hours: true,
      operatingInfo: 'Open 24 Hours',
      workingHours: {
        openingTime: null,
        closingTime: null,
        isOpen24Hours: true,
        isOvernight: false,
      },
    };
  }

  return {
    openingTime: null,
    closingTime: null,
    isOpen24Hours: false,
    operatingInfo: rawOpInfo || null,
    workingHours: {
      openingTime: null,
      closingTime: null,
      isOpen24Hours: false,
      isOvernight: false,
    },
  };
}

/**
 * Validates working hours fields from request payload and populates `sanitized` or `errors`.
 *
 * @param {object} body
 * @param {Array<{field: string, message: string}>} errors
 * @param {object} sanitized
 */
function validateWorkingHoursPayload(body, errors, sanitized) {
  if (!body || typeof body !== 'object') return;

  if (body.workingHours !== undefined && body.workingHours !== null) {
    if (typeof body.workingHours !== 'object' || Array.isArray(body.workingHours)) {
      errors.push({
        field: 'workingHours',
        message: 'workingHours must be a valid object',
      });
      return;
    }
  }

  const wh = (body.workingHours && typeof body.workingHours === 'object') ? body.workingHours : {};

  const hasIs24 = body.isOpen24Hours !== undefined || wh.isOpen24Hours !== undefined;
  const hasOpen = body.openingTime !== undefined || wh.openingTime !== undefined;
  const hasClose = body.closingTime !== undefined || wh.closingTime !== undefined;

  if (!hasIs24 && !hasOpen && !hasClose) {
    return;
  }

  const rawIs24 = body.isOpen24Hours !== undefined ? body.isOpen24Hours : wh.isOpen24Hours;
  const rawOpen = body.openingTime !== undefined ? body.openingTime : wh.openingTime;
  const rawClose = body.closingTime !== undefined ? body.closingTime : wh.closingTime;

  if (rawIs24 !== undefined && rawIs24 !== null && typeof rawIs24 !== 'boolean') {
    errors.push({
      field: 'isOpen24Hours',
      message: 'isOpen24Hours must be a boolean value',
    });
    return;
  }

  // When Open 24 Hours is enabled, represent consistently and prevent contradictory time values
  if (rawIs24 === true) {
    if (rawOpen !== undefined && rawOpen !== null && String(rawOpen).trim() !== '') {
      if (!normalizeTimeString(String(rawOpen))) {
        errors.push({
          field: 'openingTime',
          message: 'Opening time must be a valid time (e.g. 09:00 AM)',
        });
        return;
      }
    }
    if (rawClose !== undefined && rawClose !== null && String(rawClose).trim() !== '') {
      if (!normalizeTimeString(String(rawClose))) {
        errors.push({
          field: 'closingTime',
          message: 'Closing time must be a valid time (e.g. 09:00 PM)',
        });
        return;
      }
    }
    sanitized.isOpen24Hours = true;
    sanitized.openingTime = null;
    sanitized.closingTime = null;
    sanitized.operatingInfo = 'Open 24 Hours';
    return;
  }

  // Not Open 24 Hours
  const openEmpty = rawOpen === undefined || rawOpen === null || String(rawOpen).trim() === '';
  const closeEmpty = rawClose === undefined || rawClose === null || String(rawClose).trim() === '';

  if (openEmpty && closeEmpty) {
    if (rawIs24 === false) {
      sanitized.isOpen24Hours = false;
    }
    if (rawOpen === null || rawOpen === '') sanitized.openingTime = null;
    if (rawClose === null || rawClose === '') sanitized.closingTime = null;
    return;
  }

  if (openEmpty || closeEmpty) {
    errors.push({
      field: openEmpty ? 'openingTime' : 'closingTime',
      message: 'Both opening time and closing time are required when specifying working hours',
    });
    return;
  }

  const normOpen = normalizeTimeString(String(rawOpen));
  if (!normOpen) {
    errors.push({
      field: 'openingTime',
      message: 'Opening time must be a valid time (e.g. 09:00 AM)',
    });
  }

  const normClose = normalizeTimeString(String(rawClose));
  if (!normClose) {
    errors.push({
      field: 'closingTime',
      message: 'Closing time must be a valid time (e.g. 09:00 PM)',
    });
  }

  if (!normOpen || !normClose) {
    return;
  }

  if (normOpen === normClose) {
    errors.push({
      field: 'closingTime',
      message: 'Opening time and closing time cannot be identical. Enable Open 24 Hours for 24-hour operation',
    });
    return;
  }

  sanitized.openingTime = normOpen;
  sanitized.closingTime = normClose;
  sanitized.isOpen24Hours = false;
  if (body.operatingInfo === undefined) {
    sanitized.operatingInfo = `${normOpen} - ${normClose}`;
  }
}

module.exports = {
  normalizeTimeString,
  timeToMinutes,
  isOvernightSchedule,
  formatOperatingInfo,
  resolveWorkingHoursFromRows,
  validateWorkingHoursPayload,
};
