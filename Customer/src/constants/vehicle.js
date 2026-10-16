'use strict';

/**
 * Vehicle domain constants.
 *
 * These are the canonical enum values used across:
 *   - Database CHECK constraints (must stay in sync)
 *   - Validator allowlists
 *   - Repository query builders
 *   - Test fixtures
 *
 * Any change here must be accompanied by a migration to update CHECK constraints.
 */

/** Vehicle listing statuses */
const VEHICLE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
});

/** Statuses that are publicly discoverable (listing eligibility filter) */
const DISCOVERABLE_STATUSES = Object.freeze(new Set([VEHICLE_STATUS.ACTIVE]));

/** Fuel type enum */
const FUEL_TYPE = Object.freeze({
  PETROL: 'PETROL',
  DIESEL: 'DIESEL',
  ELECTRIC: 'ELECTRIC',
  CNG: 'CNG',
  HYBRID: 'HYBRID',
});

/** Transmission type enum */
const TRANSMISSION = Object.freeze({
  MANUAL: 'MANUAL',
  AUTOMATIC: 'AUTOMATIC',
  SEMI_AUTOMATIC: 'SEMI_AUTOMATIC',
});

/**
 * Sort allowlist for vehicle search.
 *
 * Only these values are accepted from client query params.
 * Any value not in this set must be rejected with a 400 error.
 * This prevents sort injection through arbitrary SQL expressions.
 */
const SORT_OPTIONS = Object.freeze({
  RELEVANCE: 'relevance',
  PRICE_LOW: 'price_low',
  PRICE_HIGH: 'price_high',
  RATING: 'rating',
  DISTANCE: 'distance',
});

/**
 * Maps each sort option to its safe ORDER BY clause fragment.
 * Fragments are hardcoded strings — never constructed from request input.
 */
const SORT_CLAUSES = Object.freeze({
  [SORT_OPTIONS.RELEVANCE]: 'created_at DESC',
  [SORT_OPTIONS.PRICE_LOW]: 'price_per_day ASC NULLS LAST',
  [SORT_OPTIONS.PRICE_HIGH]: 'price_per_day DESC NULLS LAST',
  [SORT_OPTIONS.RATING]: 'rating_avg DESC',
  // Distance sort is applied post-query in application layer (Haversine)
  [SORT_OPTIONS.DISTANCE]: 'created_at DESC',
});

/** Partner verification statuses eligible for public inventory */
const PARTNER_ELIGIBLE_STATUSES = Object.freeze(['approved', 'verified', 'APPROVED', 'VERIFIED']);

/** Discovery pagination limits */
const PAGINATION = Object.freeze({
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
});

/** Nearby search geographic limits */
const GEO_LIMITS = Object.freeze({
  /** Maximum allowed search radius in kilometres */
  MAX_RADIUS_KM: 100,
  /** Default search radius in kilometres */
  DEFAULT_RADIUS_KM: 10,
  /** Earth radius for Haversine calculation (km) */
  EARTH_RADIUS_KM: 6371,
});

/** Redis cache TTLs (seconds) for vehicle discovery */
const CACHE_TTL = Object.freeze({
  CATEGORIES: 3600, // 1 hour — very stable data
  CITIES: 1800, // 30 min — stable but city list may grow
});

module.exports = {
  VEHICLE_STATUS,
  DISCOVERABLE_STATUSES,
  FUEL_TYPE,
  TRANSMISSION,
  SORT_OPTIONS,
  SORT_CLAUSES,
  PARTNER_ELIGIBLE_STATUSES,
  PAGINATION,
  GEO_LIMITS,
  CACHE_TTL,
};
