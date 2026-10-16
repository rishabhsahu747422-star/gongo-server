'use strict';

const { BadRequestError } = require('../errors');

/**
 * Validates public vehicle discovery and availability search parameters.
 */
function validatePublicVehicleSearch(req, res, next) {
  try {
    const rawType = req.query.vehicleType || req.query.category || req.query.type || 'all';
    const rawCity = req.query.city || req.query.location || 'all';
    const rawDate = req.query.pickupDate || req.query.date || null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    let pickupDate = null;
    if (rawDate && typeof rawDate === 'string' && rawDate.trim()) {
      const cleanDate = rawDate.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
        throw new BadRequestError('Pickup date must be in YYYY-MM-DD format.', 'INVALID_DATE_FORMAT');
      }

      // Timezone-safe IST current date comparison
      const nowIstStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      if (cleanDate < nowIstStr) {
        throw new BadRequestError('Pickup date cannot be in the past.', 'PAST_PICKUP_DATE');
      }

      pickupDate = cleanDate;
    }

    req.sanitizedSearchQuery = {
      vehicleType: String(rawType).trim(),
      city: String(rawCity).trim(),
      pickupDate,
      page,
      limit,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  validatePublicVehicleSearch,
};
