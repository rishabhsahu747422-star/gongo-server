'use strict';

const { BadRequestError } = require('../errors');
const {
  FUEL_TYPE,
  TRANSMISSION,
  SORT_OPTIONS,
  PAGINATION,
  GEO_LIMITS,
} = require('../constants/vehicle');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * UUID regex — accepts any well-formed UUID (all versions/variants).
 * Using a general format check prevents arbitrary strings from reaching SQL
 * while not restricting to v4-only (which would reject valid UUIDs generated
 * by other systems).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isFiniteNumber(value) {
  const n = Number(value);
  return !Number.isNaN(n) && Number.isFinite(n);
}

function isValidCoordinate(value, min, max) {
  if (!isFiniteNumber(value)) return false;
  const n = Number(value);
  return n >= min && n <= max;
}

// Allowed fuel type values (from constants — never trust raw request string)
const VALID_FUEL_TYPES = new Set(Object.values(FUEL_TYPE));
// Allowed transmission values
const VALID_TRANSMISSIONS = new Set(Object.values(TRANSMISSION));
// Allowed sort values
const VALID_SORTS = new Set(Object.values(SORT_OPTIONS));

// Brand: printable ASCII, no SQL special chars, max 100 chars
const BRAND_RE = /^[A-Za-z0-9 \-&'.]+$/;

// ── Validators ─────────────────────────────────────────────────────────────────

/**
 * Middleware: validate GET /api/v1/vehicles query parameters.
 *
 * SECURITY:
 *   - Only allowlisted query parameters are processed.
 *   - sort is checked against an explicit allowlist (not passed to SQL directly).
 *   - page and limit have hard maximums.
 *   - latitude/longitude are range-checked.
 *   - All numeric values are parsed and validated — never raw strings to SQL.
 *   - userId/partnerId are NOT accepted — eligibility is backend-enforced.
 *   - SQL injection: parameterized queries in repository; validator only passes
 *     typed values.
 */
function validateVehicleSearch(req, res, next) {
  const q = req.query;
  const errors = [];

  // ── Pagination ─────────────────────────────────────────────────
  let page = PAGINATION.DEFAULT_PAGE;
  let limit = PAGINATION.DEFAULT_LIMIT;

  if (q.page !== undefined) {
    const p = Number(q.page);
    if (!Number.isInteger(p) || p < 1) {
      errors.push('page must be a positive integer');
    } else {
      page = p;
    }
  }

  if (q.limit !== undefined) {
    const l = Number(q.limit);
    if (!Number.isInteger(l) || l < 1 || l > PAGINATION.MAX_LIMIT) {
      errors.push(`limit must be a positive integer not exceeding ${PAGINATION.MAX_LIMIT}`);
    } else {
      limit = l;
    }
  }

  // ── Sort allowlist ─────────────────────────────────────────────
  let sort = SORT_OPTIONS.RELEVANCE;
  if (q.sort !== undefined) {
    if (!VALID_SORTS.has(q.sort)) {
      errors.push(`sort must be one of: ${[...VALID_SORTS].join(', ')}`);
    } else {
      sort = q.sort;
    }
  }

  // ── Category slug ──────────────────────────────────────────────
  let categorySlug = null;
  const rawCat = q.category !== undefined ? q.category : q.categorySlug;
  if (rawCat !== undefined) {
    const cat = String(rawCat).trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,50}$/.test(cat)) {
      errors.push('category must be a simple slug (1-50 alphanumeric/dash/underscore characters)');
    } else {
      categorySlug = cat;
    }
  }

  // ── Brand ──────────────────────────────────────────────────────
  let brand = null;
  if (q.brand !== undefined) {
    const b = String(q.brand).trim();
    if (b.length < 1 || b.length > 100 || !BRAND_RE.test(b)) {
      errors.push('brand must be 1-100 printable characters with no special SQL characters');
    } else {
      brand = b;
    }
  }

  // ── Shop ID — must be UUID ──────────────────────────────────────
  let shopId = null;
  if (q.shop !== undefined) {
    if (!isValidUUID(q.shop)) {
      errors.push('shop must be a valid UUID');
    } else {
      shopId = q.shop;
    }
  }

  // ── City name or UUID ──────────────────────────────────────────
  let city = null;
  let cityId = null;
  if (q.city !== undefined) {
    const cityVal = String(q.city).trim();
    if (isValidUUID(cityVal)) {
      cityId = cityVal;
    } else if (cityVal.length >= 1 && cityVal.length <= 150 && /^[A-Za-z0-9 \-.']+$/.test(cityVal)) {
      city = cityVal;
    } else {
      errors.push('city must be a valid UUID or city name (1-150 alphanumeric characters)');
    }
  }

  // ── Fuel type ──────────────────────────────────────────────────
  let fuelType = null;
  if (q.fuelType !== undefined) {
    const ft = String(q.fuelType).trim().toUpperCase();
    if (!VALID_FUEL_TYPES.has(ft)) {
      errors.push(`fuelType must be one of: ${[...VALID_FUEL_TYPES].join(', ')}`);
    } else {
      fuelType = ft;
    }
  }

  // ── Transmission ───────────────────────────────────────────────
  let transmission = null;
  if (q.transmission !== undefined) {
    const tr = String(q.transmission).trim().toUpperCase();
    if (!VALID_TRANSMISSIONS.has(tr)) {
      errors.push(`transmission must be one of: ${[...VALID_TRANSMISSIONS].join(', ')}`);
    } else {
      transmission = tr;
    }
  }

  // ── Price range ────────────────────────────────────────────────
  let minPrice;
  let maxPrice;
  if (q.minPrice !== undefined) {
    if (!isFiniteNumber(q.minPrice) || Number(q.minPrice) < 0) {
      errors.push('minPrice must be a non-negative number');
    } else {
      minPrice = Number(q.minPrice);
    }
  }
  if (q.maxPrice !== undefined) {
    if (!isFiniteNumber(q.maxPrice) || Number(q.maxPrice) < 0) {
      errors.push('maxPrice must be a non-negative number');
    } else {
      maxPrice = Number(q.maxPrice);
    }
  }
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    errors.push('minPrice must not exceed maxPrice');
  }

  // ── Rating ─────────────────────────────────────────────────────
  let minRating;
  if (q.minRating !== undefined) {
    const r = Number(q.minRating);
    if (!isFiniteNumber(q.minRating) || r < 0 || r > 5) {
      errors.push('minRating must be a number between 0 and 5');
    } else {
      minRating = r;
    }
  }

  // ── Date/time availability interval params ─────────────────────
  let startAt = null;
  let endAt = null;
  const rawStart = q.startAt || q.startDate || q.pickupDate;
  const rawEnd = q.endAt || q.endDate || q.returnDate;

  if (rawStart) {
    const sDate = new Date(rawStart);
    if (isNaN(sDate.getTime())) {
      errors.push('startAt/pickupDate must be a valid ISO date string or timestamp');
    } else {
      startAt = sDate.toISOString();
    }
  }

  if (rawEnd) {
    const eDate = new Date(rawEnd);
    if (isNaN(eDate.getTime())) {
      errors.push('endAt/returnDate must be a valid ISO date string or timestamp');
    } else {
      endAt = eDate.toISOString();
    }
  }

  if (startAt && endAt && new Date(startAt) >= new Date(endAt)) {
    errors.push('endAt/returnDate must be after startAt/pickupDate');
  }

  if (errors.length > 0) {
    return next(new BadRequestError(errors.join('; '), 'VALIDATION_ERROR'));
  }

  // Attach parsed, safe values to req for controller/service
  req.vehicleQuery = {
    page,
    limit,
    sort,
    categorySlug,
    brand,
    shopId,
    city,
    cityId,
    fuelType,
    transmission,
    minPrice,
    maxPrice,
    minRating,
    startAt,
    endAt,
  };

  return next();
}

/**
 * Middleware: validate GET /api/v1/vehicles/nearby query parameters.
 *
 * SECURITY:
 *   - latitude must be [-90, 90]
 *   - longitude must be [-180, 180]
 *   - radius capped at GEO_LIMITS.MAX_RADIUS_KM (100 km) to prevent full-table scans
 *   - All values are parsed server-side; client-supplied distance is ignored
 */
function validateNearbySearch(req, res, next) {
  const q = req.query;
  const errors = [];

  // latitude — required
  if (q.latitude === undefined) {
    errors.push('latitude is required');
  } else if (!isValidCoordinate(q.latitude, -90, 90)) {
    errors.push('latitude must be a number between -90 and 90');
  }

  // longitude — required
  if (q.longitude === undefined) {
    errors.push('longitude is required');
  } else if (!isValidCoordinate(q.longitude, -180, 180)) {
    errors.push('longitude must be a number between -180 and 180');
  }

  // radius — optional, defaults to GEO_LIMITS.DEFAULT_RADIUS_KM
  let radiusKm = GEO_LIMITS.DEFAULT_RADIUS_KM;
  if (q.radius !== undefined) {
    if (!isFiniteNumber(q.radius) || Number(q.radius) <= 0) {
      errors.push('radius must be a positive number');
    } else if (Number(q.radius) > GEO_LIMITS.MAX_RADIUS_KM) {
      errors.push(`radius must not exceed ${GEO_LIMITS.MAX_RADIUS_KM} km`);
    } else {
      radiusKm = Number(q.radius);
    }
  }

  // Pagination
  let page = PAGINATION.DEFAULT_PAGE;
  let limit = PAGINATION.DEFAULT_LIMIT;

  if (q.page !== undefined) {
    const p = Number(q.page);
    if (!Number.isInteger(p) || p < 1) {
      errors.push('page must be a positive integer');
    } else {
      page = p;
    }
  }

  if (q.limit !== undefined) {
    const l = Number(q.limit);
    if (!Number.isInteger(l) || l < 1 || l > PAGINATION.MAX_LIMIT) {
      errors.push(`limit must be a positive integer not exceeding ${PAGINATION.MAX_LIMIT}`);
    } else {
      limit = l;
    }
  }

  // Date/time availability interval params
  let startAt = null;
  let endAt = null;
  const rawStart = q.startAt || q.startDate || q.pickupDate;
  const rawEnd = q.endAt || q.endDate || q.returnDate;

  if (rawStart) {
    const sDate = new Date(rawStart);
    if (isNaN(sDate.getTime())) {
      errors.push('startAt/pickupDate must be a valid ISO date string or timestamp');
    } else {
      startAt = sDate.toISOString();
    }
  }

  if (rawEnd) {
    const eDate = new Date(rawEnd);
    if (isNaN(eDate.getTime())) {
      errors.push('endAt/returnDate must be a valid ISO date string or timestamp');
    } else {
      endAt = eDate.toISOString();
    }
  }

  if (startAt && endAt && new Date(startAt) >= new Date(endAt)) {
    errors.push('endAt/returnDate must be after startAt/pickupDate');
  }

  if (errors.length > 0) {
    return next(new BadRequestError(errors.join('; '), 'VALIDATION_ERROR'));
  }

  req.nearbyQuery = {
    latitude: Number(q.latitude),
    longitude: Number(q.longitude),
    radiusKm,
    page,
    limit,
    startAt,
    endAt,
  };

  return next();
}

/**
 * Middleware: validate vehicle ID path parameter.
 * Prevents non-UUID strings from reaching the repository.
 */
function validateVehicleId(req, res, next) {
  const { vehicleId } = req.params;
  if (!isValidUUID(vehicleId)) {
    return next(new BadRequestError('vehicleId must be a valid UUID', 'VALIDATION_ERROR'));
  }
  return next();
}

module.exports = {
  validateVehicleSearch,
  validateNearbySearch,
  validateVehicleId,
};
