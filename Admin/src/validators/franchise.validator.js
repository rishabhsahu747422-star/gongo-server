'use strict';

const { BadRequestError, ValidationError } = require('../errors');

const ALLOWED_STATUSES = new Set(['new', 'contacted', 'in_review', 'approved', 'rejected', 'closed']);

/**
 * Normalizes and validates Indian 10-digit mobile phone.
 */
function normalizePhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return digits;
  }
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) {
    return digits.slice(2);
  }
  return null;
}

/**
 * Validates public franchise application creation request body.
 */
function validateCreateFranchiseApplication(req, res, next) {
  try {
    const body = req.body || {};

    const rawName = body.name || body.fullName || body.applicantName;
    if (!rawName || typeof rawName !== 'string' || rawName.trim().length < 2) {
      throw new BadRequestError('Full Name is required (minimum 2 characters).', 'INVALID_APPLICANT_NAME');
    }
    if (rawName.trim().length > 150) {
      throw new BadRequestError('Full Name cannot exceed 150 characters.', 'INVALID_APPLICANT_NAME');
    }

    const rawPhone = body.phone || body.mobileNumber;
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      throw new BadRequestError('Please provide a valid 10-digit Indian mobile number.', 'INVALID_PHONE');
    }

    const rawEmail = body.email;
    if (!rawEmail || typeof rawEmail !== 'string') {
      throw new BadRequestError('Email address is required.', 'INVALID_EMAIL');
    }
    const cleanEmail = rawEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 150) {
      throw new BadRequestError('Please provide a valid email address.', 'INVALID_EMAIL');
    }

    const rawCity = body.city || body.targetCity;
    if (!rawCity || typeof rawCity !== 'string' || rawCity.trim().length < 2) {
      throw new BadRequestError('Target City is required.', 'INVALID_CITY');
    }
    if (rawCity.trim().length > 100) {
      throw new BadRequestError('Target City cannot exceed 100 characters.', 'INVALID_CITY');
    }

    const rawState = body.state || '';
    if (rawState && (typeof rawState !== 'string' || rawState.length > 100)) {
      throw new BadRequestError('State cannot exceed 100 characters.', 'INVALID_STATE');
    }

    const rawInvestment = body.investmentCapacity || body.investment || '';
    if (rawInvestment && (typeof rawInvestment !== 'string' || rawInvestment.length > 50)) {
      throw new BadRequestError('Investment capacity value is invalid.', 'INVALID_INVESTMENT');
    }

    const rawExperience = body.businessExperience || body.mobilityExperience || body.experience || '';
    if (rawExperience && (typeof rawExperience !== 'string' || rawExperience.length > 50)) {
      throw new BadRequestError('Business experience value is invalid.', 'INVALID_EXPERIENCE');
    }

    const rawMessage = body.message || body.businessGoals || '';
    if (rawMessage && (typeof rawMessage !== 'string' || rawMessage.length > 2000)) {
      throw new BadRequestError('Message cannot exceed 2000 characters.', 'INVALID_MESSAGE');
    }

    // Attach sanitized, mass-assignment safe payload
    req.sanitizedFranchise = {
      applicantName: rawName.trim(),
      phone,
      email: cleanEmail,
      city: rawCity.trim(),
      state: rawState.trim() || null,
      investmentCapacity: rawInvestment.trim() || '25-50',
      businessExperience: rawExperience.trim() || 'none',
      message: rawMessage.trim() || null,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Validates status update payload for admin management.
 */
function validateStatusUpdate(req, res, next) {
  try {
    const { status, adminNotes, notes } = req.body || {};

    if (!status || typeof status !== 'string') {
      throw new BadRequestError('Application status is required.', 'INVALID_STATUS');
    }

    const normStatus = status.toLowerCase().trim();
    if (!ALLOWED_STATUSES.has(normStatus)) {
      throw new BadRequestError(
        `Invalid status '${status}'. Must be one of: ${Array.from(ALLOWED_STATUSES).join(', ')}`,
        'INVALID_STATUS',
      );
    }

    const noteVal = adminNotes !== undefined ? adminNotes : notes;
    if (noteVal !== undefined && noteVal !== null) {
      if (typeof noteVal !== 'string') {
        throw new BadRequestError('Admin notes must be a string.', 'INVALID_ADMIN_NOTES');
      }
      if (noteVal.length > 2000) {
        throw new BadRequestError('Admin notes cannot exceed 2000 characters.', 'INVALID_ADMIN_NOTES');
      }
    }

    req.sanitizedStatusUpdate = {
      status: normStatus,
      adminNotes: noteVal ? noteVal.trim() : null,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Validates list and search query parameters.
 */
function validateListQuery(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));

    let status = req.query.status || 'all';
    if (status !== 'all') {
      status = status.toLowerCase().trim();
      if (!ALLOWED_STATUSES.has(status)) {
        throw new BadRequestError(
          `Invalid status filter '${status}'. Must be one of: all, ${Array.from(ALLOWED_STATUSES).join(', ')}`,
          'INVALID_STATUS_FILTER',
        );
      }
    }

    req.sanitizedQuery = {
      page,
      limit,
      status,
      search: req.query.search ? String(req.query.search).trim() : null,
      sortBy: req.query.sortBy || req.query.sort || 'created_at',
      sortOrder: String(req.query.sortOrder || req.query.order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  validateCreateFranchiseApplication,
  validateStatusUpdate,
  validateListQuery,
  ALLOWED_STATUSES,
};
