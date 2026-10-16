'use strict';

const adminPartnerRepository = require('../repositories/admin-partner.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const auditService = require('./audit.service');
const { ValidationError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const logger = require('../config/logger');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_PARTNER_STATUSES = new Set(['ONLINE', 'OFFLINE']);
const ALLOWED_KYC_STATUSES = new Set([
  'PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED',
]);
const ALLOWED_SORT_COLS = new Set([
  'created_at', 'updated_at', 'rating', 'review_count', 'business_name',
]);
const ALLOWED_UPDATE_FIELDS = new Set([
  'isActive', 'is_active', 'partnerStatus', 'partner_status', 'reason', 'force',
]);

class AdminPartnerService {
  /**
   * Asserts valid UUID format for partner identifiers.
   * @private
   */
  _assertUuid(id, paramName = 'id') {
    if (!id || typeof id !== 'string') {
      throw new ValidationError(`Invalid ${paramName}: must be a valid identifier`, [
        { field: paramName, message: 'Invalid identifier format' },
      ]);
    }
    const trimmed = id.trim();
    const isDevMockId = process.env.NODE_ENV !== 'test' && /^(bkg|cust|prt|veh|shop|usr|admin)-[0-9]+$/i.test(trimmed);
    if (!UUID_REGEX.test(trimmed) && !isDevMockId) {
      throw new ValidationError(`Invalid ${paramName}: must be a valid identifier`, [
        { field: paramName, message: 'Invalid identifier format' },
      ]);
    }
    return trimmed;
  }

  /**
   * Validates and normalizes date range parameters for listing queries.
   * @private
   */
  _parseDates(startDateStr, endDateStr) {
    if (!startDateStr && !endDateStr) {
      return { startDate: null, endDate: null };
    }

    if (!startDateStr || !endDateStr) {
      throw new ValidationError('Both startDate and endDate are required for date range filter');
    }

    const start = new Date(startDateStr);
    const end = new Date(endDateStr);

    if (Number.isNaN(start.getTime())) {
      throw new ValidationError('Invalid startDate format');
    }
    if (Number.isNaN(end.getTime())) {
      throw new ValidationError('Invalid endDate format');
    }

    let adjustedEnd = end;
    if (/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
      adjustedEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    }

    if (start >= adjustedEnd) {
      throw new ValidationError('startDate must be before endDate');
    }

    if (adjustedEnd.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) {
      throw new ValidationError('Date range cannot exceed 366 days');
    }

    return { startDate: start, endDate: adjustedEnd };
  }

  /**
   * GET /api/v1/admin/partners
   * Lists partners with pagination, search, and multidimensional filters.
   *
   * @param {object} [query={}]
   * @returns {Promise<object>}
   */
  async listPartners(query = {}) {
    const rawSearch = query.search || query.q;
    const search = rawSearch && typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, 100)
      : null;

    let partnerStatus = null;
    if (query.partnerStatus || query.status) {
      const ps = String(query.partnerStatus || query.status).toUpperCase().trim();
      if (!ALLOWED_PARTNER_STATUSES.has(ps)) {
        throw new ValidationError('Invalid partnerStatus. Allowed: ONLINE, OFFLINE');
      }
      partnerStatus = ps;
    }

    let kycStatus = null;
    if (query.kycStatus || query.kyc_status) {
      const ks = String(query.kycStatus || query.kyc_status).toUpperCase().trim();
      if (!ALLOWED_KYC_STATUSES.has(ks)) {
        throw new ValidationError(
          'Invalid kycStatus. Allowed: PENDING, UNDER_REVIEW, VERIFIED, REJECTED, SUSPENDED',
        );
      }
      kycStatus = ks;
    }

    let isActive = null;
    if (query.isActive !== undefined || query.is_active !== undefined) {
      const val = query.isActive !== undefined ? query.isActive : query.is_active;
      if (val === true || val === 'true') isActive = true;
      else if (val === false || val === 'false') isActive = false;
      else {
        throw new ValidationError('isActive must be a boolean (true or false)');
      }
    }

    const city = query.city && typeof query.city === 'string'
      ? query.city.trim().slice(0, 100)
      : null;

    const { startDate, endDate } = this._parseDates(
      query.startDate || query.from,
      query.endDate || query.to,
    );

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 10;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    if (Number.isNaN(limit) || limit < 1) {
      throw new ValidationError('limit must be a positive integer between 1 and 50');
    }
    if (Number.isNaN(offset) || offset < 0) {
      throw new ValidationError('offset must be a non-negative integer');
    }

    const safeLimit = Math.min(limit, 50);
    const safeOffset = offset;

    const rawSortBy = query.sortBy || query.sort;
    const sortBy = rawSortBy && ALLOWED_SORT_COLS.has(rawSortBy.toLowerCase().trim())
      ? rawSortBy.toLowerCase().trim()
      : 'created_at';

    const rawSortOrder = query.sortOrder || query.order;
    const sortOrder = rawSortOrder && String(rawSortOrder).toUpperCase().trim() === 'ASC'
      ? 'ASC'
      : 'DESC';

    logger.info('Listing admin partners', {
      search,
      partnerStatus,
      kycStatus,
      isActive,
      city,
      limit: safeLimit,
      offset: safeOffset,
      sortBy,
      sortOrder,
    });

    const { partners, total } = await adminPartnerRepository.listPartners({
      search,
      partnerStatus,
      kycStatus,
      isActive,
      city,
      startDate,
      endDate,
      limit: safeLimit,
      offset: safeOffset,
      sortBy,
      sortOrder,
    });

    const pages = Math.ceil(total / safeLimit) || 1;

    return {
      partners,
      pagination: {
        total,
        limit: safeLimit,
        offset: safeOffset,
        pages,
      },
    };
  }

  /**
   * GET /api/v1/admin/partners/:id
   * Retrieves partner detail view with safe operational summaries.
   *
   * @param {string} partnerId
   * @returns {Promise<object>}
   */
  async getPartnerDetail(partnerId) {
    const validId = this._assertUuid(partnerId);

    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const summaries = await adminPartnerRepository.getPartnerSummaries(validId);

    return {
      partner,
      ...summaries,
    };
  }

  /**
   * PATCH /api/v1/admin/partners/:id/status
   * Modifies partner operational status and/or active flag with audit logging and safety guards.
   *
   * @param {string} partnerId
   * @param {object} body
   * @param {object} auditContext
   * @returns {Promise<object>}
   */
  async updatePartnerStatus(partnerId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(partnerId);

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body is required');
    }

    // Mass-assignment protection: reject disallowed fields
    Object.keys(body).forEach((key) => {
      if (!ALLOWED_UPDATE_FIELDS.has(key)) {
        throw new ValidationError(`Field '${key}' is not allowed in partner status update`);
      }
    });

    let newIsActive = null;
    if (body.isActive !== undefined || body.is_active !== undefined) {
      const val = body.isActive !== undefined ? body.isActive : body.is_active;
      if (typeof val === 'boolean') {
        newIsActive = val;
      } else if (val === 'true') {
        newIsActive = true;
      } else if (val === 'false') {
        newIsActive = false;
      } else {
        throw new ValidationError('isActive must be a boolean');
      }
    }

    let newPartnerStatus = null;
    if (body.partnerStatus || body.partner_status) {
      const ps = String(body.partnerStatus || body.partner_status).toUpperCase().trim();
      if (!ALLOWED_PARTNER_STATUSES.has(ps)) {
        throw new ValidationError('partnerStatus must be either ONLINE or OFFLINE');
      }
      newPartnerStatus = ps;
    }

    if (newIsActive === null && newPartnerStatus === null) {
      throw new ValidationError('At least one of isActive or partnerStatus must be provided');
    }

    const reason = body.reason && typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 500)
      : null;

    const force = Boolean(body.force);

    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const beforeState = {
      isActive: partner.isActive,
      partnerStatus: partner.partnerStatus,
    };

    const action = newIsActive === false ? 'PARTNER_SUSPEND' : 'PARTNER_STATUS_CHANGE';

    const updated = await adminPartnerRepository.withTransaction(async (client) => {
      const lockedPartner = await adminPartnerRepository.findPartnerByIdForUpdate(
        validId,
        client,
      );
      if (!lockedPartner) {
        throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
      }

      // Deactivation safety check under row lock:
      // ensure no active bookings unless force is explicitly set
      if (newIsActive === false && lockedPartner.isActive === true) {
        const activeBookings = await adminPartnerRepository.getActiveBookingCount(validId, client);
        if (activeBookings > 0 && !force) {
          throw new ValidationError(
            `Cannot deactivate partner with ${activeBookings} active/upcoming bookings. `
            + 'Settle or reassign bookings first or specify force: true.',
            [{ field: 'isActive', message: 'Partner has active bookings', count: activeBookings }],
          );
        }
      }

      const res = await adminPartnerRepository.updatePartnerStatus(
        validId,
        { isActive: newIsActive, partnerStatus: newPartnerStatus },
        client,
      );

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'partners.update',
        action,
        targetResource: 'PARTNER',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: {
          isActive: res.isActive,
          partnerStatus: res.partnerStatus,
        },
        metadata: { reason, force },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'partners.update',
      action,
      targetResource: 'PARTNER',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState,
      afterState: {
        isActive: updated.isActive,
        partnerStatus: updated.partnerStatus,
      },
      metadata: { reason, force },
    });

    return updated;
  }

  /**
   * POST /api/v1/admin/partners/:id/approve
   * Approves partner verification (KYC) with audit logging.
   *
   * @param {string} partnerId
   * @param {object} body
   * @param {object} auditContext
   * @returns {Promise<object>}
   */
  async approvePartner(partnerId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(partnerId);

    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const beforeState = { kycStatus: partner.kycStatus };
    const reason = body.reason && typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 500)
      : 'Partner approved by admin';

    const updated = await adminPartnerRepository.withTransaction(async (client) => {
      const res = await adminPartnerRepository.updateKycStatus(validId, 'VERIFIED', client);

      // Record in partner_verification_history
      await adminPartnerRepository.insertVerificationHistory({
        partnerId: validId,
        verificationType: 'KYC',
        oldStatus: beforeState.kycStatus,
        newStatus: 'VERIFIED',
        reason,
        verifiedBy: auditContext.actorId || null,
      }, client);

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'partners.verify',
        action: 'PARTNER_APPROVED',
        targetResource: 'PARTNER',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { kycStatus: 'VERIFIED' },
        metadata: { reason },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'partners.verify',
      action: 'PARTNER_APPROVED',
      targetResource: 'PARTNER',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState,
      afterState: { kycStatus: 'VERIFIED' },
      metadata: { reason },
    });

    return updated;
  }

  /**
   * POST /api/v1/admin/partners/:id/reject
   * Rejects partner verification with mandatory reason and audit logging.
   */
  async rejectPartner(partnerId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(partnerId);

    const reason = body.reason && typeof body.reason === 'string'
      ? body.reason.trim()
      : null;

    if (!reason || reason.length < 3) {
      throw new ValidationError(
        'A valid rejection reason (minimum 3 characters) is required',
        [{ field: 'reason', message: 'Rejection reason is mandatory' }],
      );
    }

    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const beforeState = { kycStatus: partner.kycStatus };

    const updated = await adminPartnerRepository.withTransaction(async (client) => {
      const res = await adminPartnerRepository.updateKycStatus(validId, 'REJECTED', client);

      // Record in partner_verification_history
      await adminPartnerRepository.insertVerificationHistory({
        partnerId: validId,
        verificationType: 'KYC',
        oldStatus: beforeState.kycStatus,
        newStatus: 'REJECTED',
        reason,
        verifiedBy: auditContext.actorId || null,
      }, client);

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'partners.verify',
        action: 'PARTNER_REJECTED',
        targetResource: 'PARTNER',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { kycStatus: 'REJECTED' },
        metadata: { reason },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'partners.verify',
      action: 'PARTNER_REJECTED',
      targetResource: 'PARTNER',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState,
      afterState: { kycStatus: 'REJECTED' },
      metadata: { reason },
    });

    return updated;
  }

  /**
   * PATCH /api/v1/admin/partners/:id/suspend
   * Suspends partner with reason and audit history.
   */
  async suspendPartner(partnerId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(partnerId);
    const reason = body.reason && typeof body.reason === 'string' ? body.reason.trim() : 'Suspended by admin';
    const force = Boolean(body.force);

    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const beforeState = { isActive: partner.isActive, status: partner.partnerStatus };

    const updated = await adminPartnerRepository.withTransaction(async (client) => {
      const lockedPartner = await adminPartnerRepository.findPartnerByIdForUpdate(validId, client);
      if (!lockedPartner) {
        throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
      }

      if (!force) {
        const activeBookings = await adminPartnerRepository.getActiveBookingCount(validId, client);
        if (activeBookings > 0) {
          throw new ValidationError(
            `Cannot deactivate partner with ${activeBookings} active/upcoming bookings. `
            + 'Settle or reassign bookings first or specify force: true.',
            [{ field: 'isActive', message: 'Partner has active bookings', count: activeBookings }],
          );
        }
      }

      const res = await adminPartnerRepository.updatePartnerStatus(validId, { isActive: false, partnerStatus: 'OFFLINE' }, client);

      await adminPartnerRepository.insertVerificationHistory({
        partnerId: validId,
        verificationType: 'STATUS',
        oldStatus: 'ACTIVE',
        newStatus: 'SUSPENDED',
        reason,
        verifiedBy: auditContext.actorId || null,
      }, client);

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'partners.update',
        action: 'SUSPEND_PARTNER',
        targetResource: 'PARTNER',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { isActive: false, status: 'OFFLINE' },
        metadata: { reason, force },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'partners.update',
      action: 'SUSPEND_PARTNER',
      targetResource: 'PARTNER',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState,
      afterState: { isActive: false, status: 'OFFLINE' },
      metadata: { reason, force },
    });

    return updated;
  }

  /**
   * PATCH /api/v1/admin/partners/:id/reactivate
   * Reactivates suspended partner with audit history.
   */
  async reactivatePartner(partnerId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(partnerId);
    const reason = body.reason && typeof body.reason === 'string' ? body.reason.trim() : 'Reactivated by admin';

    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const beforeState = { isActive: partner.isActive, status: partner.partnerStatus };

    const updated = await adminPartnerRepository.withTransaction(async (client) => {
      const res = await adminPartnerRepository.updatePartnerStatus(validId, { isActive: true, partnerStatus: 'ONLINE' }, client);

      await adminPartnerRepository.insertVerificationHistory({
        partnerId: validId,
        verificationType: 'STATUS',
        oldStatus: 'SUSPENDED',
        newStatus: 'ACTIVE',
        reason,
        verifiedBy: auditContext.actorId || null,
      }, client);

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'partners.update',
        action: 'REACTIVATE_PARTNER',
        targetResource: 'PARTNER',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { isActive: true, status: 'ONLINE' },
        metadata: { reason },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'partners.update',
      action: 'REACTIVATE_PARTNER',
      targetResource: 'PARTNER',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState,
      afterState: { isActive: true, status: 'ONLINE' },
      metadata: { reason },
    });

    return updated;
  }

  /**
   * GET /api/v1/admin/partners/:id/verification-history
   */
  async getPartnerVerificationHistory(partnerId) {
    const validId = this._assertUuid(partnerId);
    const history = await adminPartnerRepository.getPartnerVerificationHistory(validId);
    return { verificationHistory: history, history };
  }

  /**
   * GET /api/v1/admin/partners/:id/documents
   */
  async getPartnerDocuments(partnerId) {
    const validId = this._assertUuid(partnerId);
    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const documents = await adminPartnerRepository.getPartnerDocuments(validId);
    return { documents };
  }

  /**
   * GET /api/v1/admin/partners/:id/kyc
   */
  async getPartnerKyc(partnerId) {
    const validId = this._assertUuid(partnerId);
    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const documents = await adminPartnerRepository.getPartnerDocuments(validId);
    const summaries = await adminPartnerRepository.getPartnerSummaries(validId);

    return {
      partnerId: validId,
      kycStatus: partner.kycStatus,
      registeredSince: partner.registeredSince,
      kycSummary: summaries.kycSummary,
      documents,
    };
  }

  /**
   * GET /api/v1/admin/partners/:id/bank-accounts
   */
  async getPartnerBankAccounts(partnerId) {
    const validId = this._assertUuid(partnerId);
    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const bankAccounts = await adminPartnerRepository.getPartnerBankAccounts(validId);
    return { bankAccounts };
  }

  /**
   * GET /api/v1/admin/partners/:id/shops
   */
  async getPartnerShops(partnerId) {
    const validId = this._assertUuid(partnerId);
    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const shops = await adminPartnerRepository.getPartnerShops(validId);
    return { shops };
  }

  /**
   * GET /api/v1/admin/partners/:id/vehicles
   */
  async getPartnerVehicles(partnerId, query = {}) {
    const validId = this._assertUuid(partnerId);
    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 10;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    const { vehicles, total } = await adminPartnerRepository.getPartnerVehicles(
      validId,
      {
        category: query.category || null,
        manualStatus: query.manualStatus || query.manual_status || null,
        rentalStatus: query.rentalStatus || query.rental_status || null,
        limit,
        offset,
      },
    );

    return {
      vehicles,
      pagination: {
        total,
        limit: Math.min(Math.max(1, limit), 50),
        offset: Math.max(0, offset),
      },
    };
  }

  /**
   * GET /api/v1/admin/partners/:id/bookings
   */
  async getPartnerBookings(partnerId, query = {}) {
    const validId = this._assertUuid(partnerId);
    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 10;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    const { bookings, total } = await adminPartnerRepository.getPartnerBookings(
      validId,
      {
        status: query.status || query.booking_status || null,
        limit,
        offset,
      },
    );

    return {
      bookings,
      pagination: {
        total,
        limit: Math.min(Math.max(1, limit), 50),
        offset: Math.max(0, offset),
      },
    };
  }

  /**
   * GET /api/v1/admin/partners/:id/earnings
   */
  async getPartnerEarnings(partnerId) {
    const validId = this._assertUuid(partnerId);
    const partner = await adminPartnerRepository.findPartnerById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    const summaries = await adminPartnerRepository.getPartnerSummaries(validId);
    return {
      partnerId: validId,
      earnings: summaries.financialSummary,
    };
  }
}

module.exports = new AdminPartnerService();
