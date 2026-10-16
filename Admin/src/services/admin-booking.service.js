'use strict';

const adminBookingRepository = require('../repositories/admin-booking.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const auditService = require('./audit.service');
const s3Provider = require('../providers/s3');
const { ValidationError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const logger = require('../config/logger');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SORT_COLS = new Set([
  'created_at',
  'updated_at',
  'start_at',
  'expected_return_at',
  'booking_number',
  'booking_status',
]);

const ALLOWED_BOOKING_STATUSES = new Set([
  'PENDING',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'BOOKED',
  'UPCOMING',
  'PICKUP_SCHEDULED',
  'CONFIRMED_UPCOMING',
  'ACTIVE',
  'IN_PROGRESS',
  'VEHICLE_PICKED',
  'COMPLETED',
  'CANCELLED',
]);

const ALLOWED_PAYMENT_STATUSES = new Set([
  'PENDING',
  'COMPLETED',
  'FAILED',
  'REFUNDED',
]);

const ALLOWED_STATUS_UPDATE_FIELDS = new Set([
  'status',
  'bookingStatus',
  'booking_status',
  'reason',
  'force',
]);

const ALLOWED_CANCEL_FIELDS = new Set(['reason', 'force']);

// Canonical state transitions (Admin can cancel from any active/pending status)
const VALID_TRANSITIONS = {
  PENDING: new Set(['PENDING_PAYMENT', 'PAYMENT_PENDING', 'CONFIRMED', 'CANCELLED']),
  PENDING_PAYMENT: new Set(['CONFIRMED', 'PAYMENT_COMPLETED', 'CANCELLED']),
  PAYMENT_PENDING: new Set(['CONFIRMED', 'PAYMENT_COMPLETED', 'CANCELLED']),
  PAYMENT_COMPLETED: new Set(['CONFIRMED', 'UPCOMING', 'ACTIVE', 'CANCELLED']),
  CONFIRMED: new Set(['UPCOMING', 'ACTIVE', 'PICKUP_SCHEDULED', 'IN_PROGRESS', 'CANCELLED']),
  BOOKED: new Set(['UPCOMING', 'ACTIVE', 'PICKUP_SCHEDULED', 'IN_PROGRESS', 'CANCELLED']),
  UPCOMING: new Set(['ACTIVE', 'PICKUP_SCHEDULED', 'IN_PROGRESS', 'CANCELLED']),
  PICKUP_SCHEDULED: new Set(['ACTIVE', 'IN_PROGRESS', 'VEHICLE_PICKED', 'CANCELLED']),
  CONFIRMED_UPCOMING: new Set(['ACTIVE', 'IN_PROGRESS', 'CANCELLED']),
  ACTIVE: new Set(['IN_PROGRESS', 'COMPLETED', 'RETURN_PENDING', 'RETURNED', 'CANCELLED']),
  IN_PROGRESS: new Set(['COMPLETED', 'RETURN_PENDING', 'RETURNED', 'CANCELLED']),
  VEHICLE_PICKED: new Set(['IN_PROGRESS', 'COMPLETED', 'RETURN_PENDING', 'RETURNED', 'CANCELLED']),
  RETURN_PENDING: new Set(['RETURNED', 'COMPLETED', 'CANCELLED']),
  RETURNED: new Set(['COMPLETED', 'CANCELLED']),
  COMPLETED: new Set(['CANCELLED']), // Admin override permitted
  CANCELLED: new Set([]), // Terminal
  REFUNDED: new Set([]), // Terminal
};

class AdminBookingService {
  /**
   * Asserts valid UUID format for booking, customer, partner, and vehicle identifiers.
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
   * Resolves raw storage key/relative image URLs into valid presigned or accessible URLs.
   * @private
   */
  async _resolveVehicleImageUrls(vehicle) {
    if (!vehicle) return vehicle;
    let coverUrl = vehicle.coverImageUrl || vehicle.primaryImage || vehicle.primaryImageUrl;
    const key = vehicle.storageKey || coverUrl;
    if (key && typeof key === 'string' && !key.startsWith('http://') && !key.startsWith('https://')) {
      try {
        const presigned = await s3Provider.createPresignedGetUrl({ key, expiresInSeconds: 86400 });
        if (presigned && presigned.downloadUrl) {
          coverUrl = presigned.downloadUrl;
        }
      } catch (err) {
        logger.warn('Failed to presign booking vehicle cover image', { error: err.message, key });
      }
    }

    let images = vehicle.images;
    if (Array.isArray(images) && images.length > 0) {
      images = await Promise.all(
        images.map(async (img) => {
          let imgUrl = img.imageUrl || img.url;
          const imgKey = img.storageKey || imgUrl;
          if (imgKey && typeof imgKey === 'string' && !imgKey.startsWith('http://') && !imgKey.startsWith('https://')) {
            try {
              const presigned = await s3Provider.createPresignedGetUrl({ key: imgKey, expiresInSeconds: 86400 });
              if (presigned && presigned.downloadUrl) {
                imgUrl = presigned.downloadUrl;
              }
            } catch (_) {}
          }
          return {
            ...img,
            imageUrl: imgUrl,
            url: imgUrl,
          };
        })
      );
    }

    return {
      ...vehicle,
      coverImageUrl: coverUrl || null,
      primaryImage: coverUrl || null,
      primaryImageUrl: coverUrl || null,
      imageUrl: coverUrl || null,
      images: images || [],
    };
  }

  /**
   * GET /api/v1/admin/bookings
   * Lists bookings with pagination, search, and multidimensional filters.
   *
   * @param {object} [query={}]
   * @returns {Promise<object>}
   */
  async listBookings(query = {}) {
    const rawSearch = query.search || query.q;
    const search = rawSearch && typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, 100)
      : null;

    let bookingStatus = null;
    const rawStatus = query.bookingStatus || query.booking_status || query.status;
    if (rawStatus) {
      const s = String(rawStatus).toUpperCase().trim();
      if (!ALLOWED_BOOKING_STATUSES.has(s)) {
        throw new ValidationError(
          `Invalid bookingStatus: must be one of ${Array.from(ALLOWED_BOOKING_STATUSES).join(', ')}`,
        );
      }
      bookingStatus = s;
    }

    let paymentStatus = null;
    const rawPayStatus = query.paymentStatus || query.payment_status;
    if (rawPayStatus) {
      const ps = String(rawPayStatus).toUpperCase().trim();
      if (!ALLOWED_PAYMENT_STATUSES.has(ps)) {
        throw new ValidationError(
          `Invalid paymentStatus: must be one of ${Array.from(ALLOWED_PAYMENT_STATUSES).join(', ')}`,
        );
      }
      paymentStatus = ps;
    }

    let customerId = null;
    if (query.customerId || query.customer_id) {
      customerId = this._assertUuid(query.customerId || query.customer_id, 'customerId');
    }

    let partnerId = null;
    if (query.partnerId || query.partner_id) {
      partnerId = this._assertUuid(query.partnerId || query.partner_id, 'partnerId');
    }

    let vehicleId = null;
    if (query.vehicleId || query.vehicle_id) {
      vehicleId = this._assertUuid(query.vehicleId || query.vehicle_id, 'vehicleId');
    }

    const { startDate, endDate } = this._parseDates(
      query.startDate || query.from,
      query.endDate || query.to,
    );

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 50;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    if (Number.isNaN(limit) || limit < 1) {
      throw new ValidationError('limit must be a positive integer between 1 and 100');
    }
    if (Number.isNaN(offset) || offset < 0) {
      throw new ValidationError('offset must be a non-negative integer');
    }

    const safeLimit = Math.min(limit, 100);
    const safeOffset = offset;

    const rawSortBy = query.sortBy || query.sort;
    const sortBy = rawSortBy && ALLOWED_SORT_COLS.has(rawSortBy.toLowerCase().trim())
      ? rawSortBy.toLowerCase().trim()
      : 'created_at';

    const rawSortOrder = query.sortOrder || query.order;
    const sortOrder = rawSortOrder && String(rawSortOrder).toUpperCase().trim() === 'ASC'
      ? 'ASC'
      : 'DESC';

    logger.info('Listing admin bookings', {
      search,
      bookingStatus,
      paymentStatus,
      customerId,
      partnerId,
      vehicleId,
      limit: safeLimit,
      offset: safeOffset,
      sortBy,
      sortOrder,
    });

    const { bookings, total } = await adminBookingRepository.listBookings({
      search,
      bookingStatus,
      paymentStatus,
      customerId,
      partnerId,
      vehicleId,
      startDate,
      endDate,
      limit: safeLimit,
      offset: safeOffset,
      sortBy,
      sortOrder,
    });

    const pages = Math.ceil(total / safeLimit) || 1;

    const resolvedBookings = await Promise.all(
      bookings.map(async (b) => {
        if (!b.vehicle) return b;
        const resolvedVehicle = await this._resolveVehicleImageUrls(b.vehicle);
        return {
          ...b,
          vehicle: resolvedVehicle,
          coverImageUrl: resolvedVehicle.coverImageUrl,
          vehicleImage: resolvedVehicle.coverImageUrl,
        };
      })
    );

    return {
      bookings: resolvedBookings,
      pagination: {
        total,
        limit: safeLimit,
        offset: safeOffset,
        pages,
      },
    };
  }

  /**
   * GET /api/v1/admin/bookings/:id
   * Retrieves single booking detail with customer, partner, vehicle, pricing, and summaries.
   *
   * @param {string} bookingId
   * @returns {Promise<object>}
   */
  async getBookingDetail(bookingId) {
    const validId = this._assertUuid(bookingId);

    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }

    const [summaries, payments, damages] = await Promise.all([
      adminBookingRepository.getBookingSummaries(validId),
      adminBookingRepository.getBookingPayments(validId),
      adminBookingRepository.getBookingDamages(validId),
    ]);

    if (booking.vehicle) {
      booking.vehicle = await this._resolveVehicleImageUrls(booking.vehicle);
      booking.coverImageUrl = booking.vehicle.coverImageUrl;
      booking.vehicleImage = booking.vehicle.coverImageUrl;
    }

    return {
      booking,
      ...summaries,
      payments,
      damages,
    };
  }

  /**
   * PATCH /api/v1/admin/bookings/:id/status
   * Updates booking status with state transition validation, concurrency row lock, and audit.
   *
   * @param {string} bookingId
   * @param {object} body
   * @param {object} auditContext
   * @returns {Promise<object>}
   */
  async updateBookingStatus(bookingId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(bookingId);

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body is required');
    }

    // Mass-assignment protection: reject disallowed fields
    Object.keys(body).forEach((key) => {
      if (!ALLOWED_STATUS_UPDATE_FIELDS.has(key)) {
        throw new ValidationError(`Field '${key}' is not allowed in booking status update`);
      }
    });

    const rawStatus = body.status || body.bookingStatus || body.booking_status;
    if (!rawStatus) {
      throw new ValidationError('status field is required');
    }

    const targetStatus = String(rawStatus).toUpperCase().trim();
    if (!ALLOWED_BOOKING_STATUSES.has(targetStatus)) {
      throw new ValidationError(
        `Invalid status: must be one of ${Array.from(ALLOWED_BOOKING_STATUSES).join(', ')}`,
      );
    }

    const reason = body.reason && typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 500)
      : null;
    const force = Boolean(body.force);

    // Concurrency protection: transaction with row-level lock
    const updated = await adminBookingRepository.withTransaction(async (client) => {
      const current = await adminBookingRepository.findBookingByIdForUpdate(validId, client);
      if (!current) {
        throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
      }

      const currentStatus = current.bookingStatus;

      if (currentStatus === targetStatus) {
        return adminBookingRepository.findBookingById(validId, client);
      }

      // Check terminal states
      if (currentStatus === 'COMPLETED') {
        throw new ValidationError('Cannot change status of a COMPLETED booking');
      }
      if (currentStatus === 'CANCELLED') {
        throw new ValidationError('Cannot change status of a CANCELLED booking');
      }

      const isCancellation = targetStatus === 'CANCELLED';

      // Validate allowed transitions unless force is explicitly set or is cancellation
      const allowed = VALID_TRANSITIONS[currentStatus] || new Set(['CANCELLED']);
      if (!isCancellation && !allowed.has(targetStatus) && !force) {
        throw new ValidationError(
          `Invalid booking status transition from '${currentStatus}' to '${targetStatus}'. `
          + `Allowed transitions: [${Array.from(allowed).join(', ')}]`,
          [{ field: 'status', message: 'Invalid state transition', currentStatus, targetStatus }],
        );
      }

      // Vehicle rental status coordination
      if (targetStatus === 'ACTIVE') {
        await adminBookingRepository.updateVehicleRentalStatus(
          current.vehicleId,
          'ACTIVE',
          client,
        );
      } else if (targetStatus === 'COMPLETED' || targetStatus === 'CANCELLED') {
        await adminBookingRepository.updateVehicleRentalStatus(
          current.vehicleId,
          'IDLE',
          client,
        );
      }

      const beforeState = { bookingStatus: currentStatus };
      const action = targetStatus === 'CANCELLED' ? 'BOOKING_CANCELLED' : 'BOOKING_STATUS_CHANGE';

      const res = await adminBookingRepository.updateBookingStatus(validId, targetStatus, client);

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'bookings.update',
        action,
        targetResource: 'BOOKING',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { bookingStatus: res.bookingStatus },
        metadata: { reason, force, fromStatus: currentStatus, toStatus: targetStatus },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'bookings.update',
      action: updated.bookingStatus === 'CANCELLED' ? 'BOOKING_CANCELLED' : 'BOOKING_STATUS_CHANGE',
      targetResource: 'BOOKING',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState: { bookingStatus: updated.bookingStatus },
      afterState: { bookingStatus: updated.bookingStatus },
      metadata: { reason, force, targetStatus },
    });

    return updated;
  }

  /**
   * POST /api/v1/admin/bookings/:id/cancel
   * Cancels a booking atomically with reason validation and vehicle release.
   *
   * @param {string} bookingId
   * @param {object} body
   * @param {object} auditContext
   * @returns {Promise<object>}
   */
  async cancelBooking(bookingId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(bookingId);

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body is required');
    }

    Object.keys(body).forEach((key) => {
      if (!ALLOWED_CANCEL_FIELDS.has(key)) {
        throw new ValidationError(`Field '${key}' is not allowed in booking cancellation`);
      }
    });

    if (!body.reason || typeof body.reason !== 'string' || body.reason.trim().length < 5) {
      throw new ValidationError('Cancellation reason is required (minimum 5 characters)', [
        { field: 'reason', message: 'Cancellation reason is required (minimum 5 characters)' },
      ]);
    }
    const reason = body.reason.trim().slice(0, 500);

    const force = body.force !== undefined ? Boolean(body.force) : true;

    // Concurrency protection: transaction with row-level lock
    const updated = await adminBookingRepository.withTransaction(async (client) => {
      const current = await adminBookingRepository.findBookingByIdForUpdate(validId, client);
      if (!current) {
        throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
      }

      if (current.bookingStatus === 'COMPLETED') {
        throw new ValidationError('Cannot cancel a COMPLETED booking');
      }
      if (current.bookingStatus === 'CANCELLED') {
        throw new ValidationError('Booking is already CANCELLED');
      }

      // Restore vehicle rental status to IDLE
      if (current.vehicleId) {
        await adminBookingRepository.updateVehicleRentalStatus(
          current.vehicleId,
          'IDLE',
          client,
        );
      }

      const beforeState = {
        bookingStatus: current.bookingStatus,
        paymentStatus: current.paymentStatus,
      };

      const res = await adminBookingRepository.updateBookingStatus(validId, 'CANCELLED', client);

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'bookings.cancel',
        action: 'BOOKING_CANCELLED',
        targetResource: 'BOOKING',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { bookingStatus: res.bookingStatus },
        metadata: { reason, force, previousStatus: current.bookingStatus },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'bookings.cancel',
      action: 'BOOKING_CANCELLED',
      targetResource: 'BOOKING',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState: { bookingStatus: updated.bookingStatus },
      afterState: { bookingStatus: 'CANCELLED' },
      metadata: { reason, force },
    });

    return updated;
  }

  /**
   * GET /api/v1/admin/bookings/:id/timeline
   * Assembles a deterministic chronological event timeline from canonical records.
   *
   * @param {string} bookingId
   * @returns {Promise<object>}
   */
  async getBookingTimeline(bookingId) {
    const validId = this._assertUuid(bookingId);

    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }

    const [summaries, payments, actions] = await Promise.all([
      adminBookingRepository.getBookingSummaries(validId),
      adminBookingRepository.getBookingPayments(validId),
      adminBookingRepository.getBookingAdminActions(validId),
    ]);

    const events = [];

    // 1. Created Event
    events.push({
      type: 'BOOKING_CREATED',
      title: 'Booking Created',
      timestamp: booking.createdAt,
      status: 'SUCCESS',
      metadata: {
        bookingNumber: booking.bookingNumber,
        customerId: booking.customerId,
        vehicleId: booking.vehicleId,
        startAt: booking.startAt,
        expectedReturnAt: booking.expectedReturnAt,
      },
    });

    // 2. Payment Events
    (payments || []).forEach((p) => {
      events.push({
        type: `PAYMENT_${p.status}`,
        title: `Payment ${p.status}`,
        timestamp: p.createdAt,
        status: p.status === 'SUCCESS' ? 'SUCCESS' : 'INFO',
        metadata: {
          paymentId: p.id,
          amount: p.amount,
          currency: p.currency,
          provider: p.provider,
        },
      });
    });

    // 3. Pickup Verification
    if (summaries.pickupVerification && summaries.pickupVerification.verifiedAt) {
      events.push({
        type: 'PICKUP_VERIFIED',
        title: 'Vehicle Picked Up',
        timestamp: summaries.pickupVerification.verifiedAt,
        status: 'SUCCESS',
        metadata: {
          odometerStart: summaries.pickupVerification.odometerStart,
          fuelLevelStart: summaries.pickupVerification.fuelLevelStart,
        },
      });
    }

    // 4. Return Verification
    if (summaries.returnVerification && summaries.returnVerification.returnedAt) {
      events.push({
        type: 'RETURN_VERIFIED',
        title: 'Vehicle Returned',
        timestamp: summaries.returnVerification.returnedAt,
        status: 'SUCCESS',
        metadata: {
          odometerEnd: summaries.returnVerification.odometerEnd,
          returnStatus: summaries.returnVerification.returnStatus,
          lateMinutes: summaries.returnVerification.lateMinutes,
          extraKm: summaries.returnVerification.extraKm,
        },
      });
    }

    // 5. Admin Actions
    (actions || []).forEach((a) => {
      events.push({
        type: a.action,
        title: `Admin Action: ${a.action}`,
        timestamp: a.createdAt,
        status: 'INFO',
        metadata: {
          actorId: a.actorId,
          actorRole: a.actorRole,
          reason: a.metadata ? a.metadata.reason : null,
          beforeState: a.beforeState,
          afterState: a.afterState,
        },
      });
    });

    // Sort chronologically ascending
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return {
      bookingId: validId,
      bookingNumber: booking.bookingNumber,
      timeline: events,
    };
  }

  /**
   * GET /api/v1/admin/bookings/:id/payment (and /payments)
   */
  async getBookingPayments(bookingId) {
    const validId = this._assertUuid(bookingId);
    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }

    const payments = await adminBookingRepository.getBookingPayments(validId);
    return {
      bookingId: validId,
      payments,
    };
  }

  /**
   * GET /api/v1/admin/bookings/:id/status-history
   */
  async getBookingStatusHistory(bookingId) {
    const validId = this._assertUuid(bookingId);
    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }
    const history = await adminBookingRepository.getBookingStatusHistory(validId);
    return {
      bookingId: validId,
      history,
    };
  }

  /**
   * GET /api/v1/admin/bookings/:id/customer
   */
  async getBookingCustomer(bookingId) {
    const validId = this._assertUuid(bookingId);
    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }
    const customer = await adminBookingRepository.getBookingCustomerDetails(validId);
    return {
      bookingId: validId,
      customer,
    };
  }

  /**
   * GET /api/v1/admin/bookings/:id/pickup
   */
  async getBookingPickup(bookingId) {
    const validId = this._assertUuid(bookingId);
    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }
    const pickup = await adminBookingRepository.getBookingPickup(validId);
    return {
      bookingId: validId,
      pickup,
    };
  }

  /**
   * GET /api/v1/admin/bookings/:id/return
   */
  async getBookingReturn(bookingId) {
    const validId = this._assertUuid(bookingId);
    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }
    const returnData = await adminBookingRepository.getBookingReturn(validId);
    return {
      bookingId: validId,
      return: returnData,
    };
  }

  /**
   * GET /api/v1/admin/bookings/:id/agreement
   */
  async getBookingAgreement(bookingId) {
    const validId = this._assertUuid(bookingId);
    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }
    const agreement = await adminBookingRepository.getBookingAgreement(validId);
    return {
      bookingId: validId,
      agreement,
    };
  }

  /**
   * GET /api/v1/admin/bookings/:id/commission
   */
  async getBookingCommission(bookingId) {
    const validId = this._assertUuid(bookingId);
    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }

    const commission = await adminBookingRepository.getBookingCommission(validId);
    return {
      bookingId: validId,
      commission,
    };
  }

  /**
   * GET /api/v1/admin/bookings/:id/settlement
   */
  async getBookingSettlement(bookingId) {
    const validId = this._assertUuid(bookingId);
    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }

    const settlement = await adminBookingRepository.getBookingSettlement(validId);
    return {
      bookingId: validId,
      settlement,
    };
  }

  /**
   * GET /api/v1/admin/bookings/:id/tracking
   */
  async getBookingTracking(bookingId) {
    const validId = this._assertUuid(bookingId);
    const booking = await adminBookingRepository.findBookingById(validId);
    if (!booking) {
      throw new NotFoundError('Booking not found', ERROR_CODES.NOT_FOUND);
    }

    const [summaries, damages] = await Promise.all([
      adminBookingRepository.getBookingSummaries(validId),
      adminBookingRepository.getBookingDamages(validId),
    ]);

    return {
      bookingId: validId,
      pickup: summaries.pickupVerification,
      return: summaries.returnVerification,
      damages,
    };
  }
}

module.exports = new AdminBookingService();
