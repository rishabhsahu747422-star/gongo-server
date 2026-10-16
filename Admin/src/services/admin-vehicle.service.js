'use strict';

const adminVehicleRepository = require('../repositories/admin-vehicle.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const auditService = require('./audit.service');
const s3Provider = require('../providers/s3');
const { ValidationError, NotFoundError, ConflictError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const logger = require('../config/logger');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SORT_COLS = new Set([
  'created_at',
  'updated_at',
  'brand',
  'model',
  'registration_number',
  'year',
]);

const ALLOWED_CATEGORIES = new Set([
  'CAR', 'BIKE', 'SCOOTER', 'SCOOTY', 'EV', 'MOTORCYCLE',
]);
const ALLOWED_MANUAL_STATUSES = new Set(['ONLINE', 'OFFLINE']);
const ALLOWED_RENTAL_STATUSES = new Set(['IDLE', 'BOOKED', 'ACTIVE']);
const ALLOWED_VERIFICATION_STATUSES = new Set(['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED']);
// Verification states that allow an admin ACTIVATE to put a vehicle ONLINE
// ('APPROVED' is a legacy alias also accepted by the Customer vehicle repository).
const VERIFIED_STATUSES = new Set(['VERIFIED', 'APPROVED']);

const ALLOWED_STATUS_UPDATE_FIELDS = new Set([
  'manualStatus',
  'manual_status',
  'offlineReason',
  'offline_reason',
  'isArchived',
  'is_archived',
  'reason',
  'force',
]);

const ALLOWED_VERIFY_FIELDS = new Set(['status', 'reason']);

class AdminVehicleService {
  /**
   * Asserts valid UUID format for vehicle and partner identifiers.
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
   * Reuses canonical presigning mechanism consistent with booking service.
   * @private
   */
  async _resolveVehicleImageUrls(vehicle) {
    if (!vehicle) return vehicle;
    let coverUrl = vehicle.coverImageUrl || vehicle.primaryImage || vehicle.primaryImageUrl;
    const key = vehicle.coverStorageKey || vehicle.storageKey || coverUrl;
    if (key && typeof key === 'string' && !key.startsWith('http://') && !key.startsWith('https://')) {
      try {
        const presigned = await s3Provider.createPresignedGetUrl({ key, expiresInSeconds: 86400 });
        if (presigned && presigned.downloadUrl) {
          coverUrl = presigned.downloadUrl;
        }
      } catch (err) {
        logger.warn('Failed to presign vehicle cover image', { error: err.message, key });
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
   * Resolves raw storage key for a document into a secure presigned URL,
   * detecting MIME type, file type (pdf/image), and clean file name.
   * @private
   */
  async _resolveDocumentDetails(doc) {
    if (!doc) return null;
    let fileUrl = doc.fileUrl || null;
    const docKey = doc.storageKey || fileUrl;
    if (docKey && typeof docKey === 'string' && !docKey.startsWith('http://') && !docKey.startsWith('https://')) {
      try {
        const presigned = await s3Provider.createPresignedGetUrl({ key: docKey, expiresInSeconds: 86400 });
        if (presigned && presigned.downloadUrl) {
          fileUrl = presigned.downloadUrl;
        }
      } catch (err) {
        logger.warn('Failed to presign vehicle document', { error: err.message, key: docKey });
      }
    }

    let mimeType = 'application/octet-stream';
    let fileType = 'unknown';
    const keyLower = String(docKey || '').toLowerCase();
    if (keyLower.endsWith('.pdf')) {
      mimeType = 'application/pdf';
      fileType = 'pdf';
    } else if (keyLower.endsWith('.jpg') || keyLower.endsWith('.jpeg')) {
      mimeType = 'image/jpeg';
      fileType = 'image';
    } else if (keyLower.endsWith('.png')) {
      mimeType = 'image/png';
      fileType = 'image';
    } else if (keyLower.endsWith('.webp')) {
      mimeType = 'image/webp';
      fileType = 'image';
    }

    const fileName = doc.documentName || (docKey && typeof docKey === 'string' ? docKey.split('/').pop() : `${doc.documentType || 'document'}.${fileType === 'pdf' ? 'pdf' : 'jpg'}`);

    return {
      ...doc,
      status: doc.verificationStatus,
      uploadedAt: doc.createdAt,
      validTill: doc.validTill || null,
      expiresAt: doc.validTill || null,
      fileName,
      mimeType,
      fileType,
      fileUrl,
      downloadUrl: fileUrl,
      documentUrl: fileUrl,
    };
  }

  /**
   * GET /api/v1/admin/vehicles
   * Lists vehicles with pagination, search, and multidimensional filters.
   *
   * @param {object} [query={}]
   * @returns {Promise<object>}
   */
  async listVehicles(query = {}) {
    const rawSearch = query.search || query.q;
    const search = rawSearch && typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, 100)
      : null;

    let partnerId = null;
    if (query.partnerId || query.partner_id) {
      partnerId = this._assertUuid(query.partnerId || query.partner_id, 'partnerId');
    }

    let shopId = null;
    if (query.shopId || query.shop_id) {
      shopId = this._assertUuid(query.shopId || query.shop_id, 'shopId');
    }

    let category = null;
    if (query.category) {
      const cat = String(query.category).toUpperCase().trim();
      if (!ALLOWED_CATEGORIES.has(cat)) {
        throw new ValidationError(
          `Invalid category: must be one of ${Array.from(ALLOWED_CATEGORIES).join(', ')}`,
        );
      }
      category = cat;
    }

    let manualStatus = null;
    if (query.manualStatus || query.manual_status) {
      const ms = String(query.manualStatus || query.manual_status).toUpperCase().trim();
      if (!ALLOWED_MANUAL_STATUSES.has(ms)) {
        throw new ValidationError(
          `Invalid manualStatus: must be one of ${Array.from(ALLOWED_MANUAL_STATUSES).join(', ')}`,
        );
      }
      manualStatus = ms;
    }

    let rentalStatus = null;
    if (query.rentalStatus || query.rental_status) {
      const rs = String(query.rentalStatus || query.rental_status).toUpperCase().trim();
      if (!ALLOWED_RENTAL_STATUSES.has(rs)) {
        throw new ValidationError(
          `Invalid rentalStatus: must be one of ${Array.from(ALLOWED_RENTAL_STATUSES).join(', ')}`,
        );
      }
      rentalStatus = rs;
    }

    let verificationStatus = null;
    if (query.verificationStatus || query.verification_status) {
      const vs = String(query.verificationStatus || query.verification_status).toUpperCase().trim();
      if (!ALLOWED_VERIFICATION_STATUSES.has(vs)) {
        throw new ValidationError(
          `Invalid verificationStatus: must be one of ${Array.from(ALLOWED_VERIFICATION_STATUSES).join(', ')}`,
        );
      }
      verificationStatus = vs;
    }

    let isArchived = null;
    if (query.isArchived !== undefined || query.is_archived !== undefined) {
      const val = query.isArchived !== undefined ? query.isArchived : query.is_archived;
      if (val === true || val === 'true') isArchived = true;
      else if (val === false || val === 'false') isArchived = false;
      else {
        throw new ValidationError('isArchived must be a boolean (true or false)');
      }
    }

    const city = query.city && typeof query.city === 'string'
      ? query.city.trim().slice(0, 100)
      : null;

    const { startDate, endDate } = this._parseDates(
      query.startDate || query.from,
      query.endDate || query.to,
    );

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const rawLimit = query.limit !== undefined ? query.limit : (query.pageSize !== undefined ? query.pageSize : 10);
    const limit = parseInt(rawLimit, 10);

    if (Number.isNaN(limit) || limit < 1) {
      throw new ValidationError('limit must be a positive integer between 1 and 50');
    }

    const safeLimit = Math.min(limit, 50);
    const rawOffset = query.offset !== undefined ? parseInt(query.offset, 10) : (page - 1) * safeLimit;

    if (Number.isNaN(rawOffset) || rawOffset < 0) {
      throw new ValidationError('offset must be a non-negative integer');
    }
    const safeOffset = rawOffset;

    const rawSortBy = query.sortBy || query.sort;
    const sortBy = rawSortBy && ALLOWED_SORT_COLS.has(rawSortBy.toLowerCase().trim())
      ? rawSortBy.toLowerCase().trim()
      : 'created_at';

    const rawSortOrder = query.sortOrder || query.order;
    const sortOrder = rawSortOrder && String(rawSortOrder).toUpperCase().trim() === 'ASC'
      ? 'ASC'
      : 'DESC';

    logger.info('Listing admin vehicles', {
      search,
      partnerId,
      shopId,
      category,
      manualStatus,
      rentalStatus,
      verificationStatus,
      isArchived,
      city,
      limit: safeLimit,
      offset: safeOffset,
      sortBy,
      sortOrder,
    });

    const { vehicles, total } = await adminVehicleRepository.listVehicles({
      search,
      partnerId,
      shopId,
      category,
      manualStatus,
      rentalStatus,
      verificationStatus,
      isArchived,
      city,
      startDate,
      endDate,
      limit: safeLimit,
      offset: safeOffset,
      sortBy,
      sortOrder,
    });

    const pages = Math.ceil(total / safeLimit) || 1;
    const currentPage = Math.floor(safeOffset / safeLimit) + 1;

    const resolvedVehicles = await Promise.all(
      vehicles.map((v) => this._resolveVehicleImageUrls(v))
    );

    return {
      vehicles: resolvedVehicles,
      pagination: {
        total,
        page: currentPage,
        limit: safeLimit,
        pageSize: safeLimit,
        offset: safeOffset,
        pages,
        totalPages: pages,
      },
    };
  }

  /**
   * GET /api/v1/admin/vehicles/:id
   * Retrieves single vehicle detail with partner info and operational summaries.
   *
   * @param {string} vehicleId
   * @returns {Promise<object>}
   */
  async getVehicleDetail(vehicleId) {
    const validId = this._assertUuid(vehicleId);

    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const summaries = await adminVehicleRepository.getVehicleSummaries(validId);

    let rawImages = [];
    try {
      if (typeof adminVehicleRepository.getVehicleImages === 'function') {
        rawImages = (await adminVehicleRepository.getVehicleImages(validId)) || [];
      }
    } catch (_) {}

    let rawDocs = [];
    try {
      if (typeof adminVehicleRepository.getVehicleDocuments === 'function') {
        rawDocs = (await adminVehicleRepository.getVehicleDocuments(validId)) || [];
      }
    } catch (_) {}

    const resolvedVehicle = await this._resolveVehicleImageUrls(vehicle);

    const images = await Promise.all(
      rawImages.map(async (img) => {
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

    const documents = await Promise.all(
      (rawDocs || []).map((doc) => this._resolveDocumentDetails(doc))
    );

    if (images.length > 0) {
      const coverImg = images.find((i) => i.isCover) || images[0];
      if (coverImg && coverImg.imageUrl) {
        resolvedVehicle.coverImageUrl = coverImg.imageUrl;
        resolvedVehicle.primaryImage = coverImg.imageUrl;
        resolvedVehicle.primaryImageUrl = coverImg.imageUrl;
      }
    }

    resolvedVehicle.images = images;
    resolvedVehicle.documents = documents;

    return {
      vehicle: resolvedVehicle,
      images,
      documents,
      ...summaries,
      bookingStats: summaries.bookingSummary,
    };
  }

  /**
   * Lifecycle invariants for the generic PATCH /:id/status endpoint, checked against the
   * row-locked vehicle inside the transaction.
   *
   *  - It can never lift an admin hold: un-archiving an archived (deactivated) vehicle or
   *    sending isArchived=false for a blocked (is_active=false) vehicle is refused with 409.
   *    (The repository derives is_active = !isArchived, so isArchived=false would silently
   *    clear a block.) Holds are lifted only by the explicit PATCH /:id/activate endpoint.
   *  - manualStatus ONLINE is refused (409) when the vehicle is archived (or archived by the
   *    same request), blocked/inactive, REJECTED, or not VERIFIED/APPROVED.
   *
   * @private
   * @param {object} vehicle - row-locked vehicle (camelCase)
   * @param {object} updates - normalized updates for this request
   */
  _assertGenericStatusTransitionAllowed(vehicle, updates) {
    const isArchived = vehicle.isArchived === true;
    const isInactive = vehicle.isActive === false;

    if (updates.isArchived === false && (isArchived || isInactive)) {
      throw new ConflictError(
        isArchived
          ? 'Vehicle is deactivated. Use the activate action to restore it; the generic status update cannot lift an admin hold.'
          : 'Vehicle is blocked. Use the activate action to lift the block; the generic status update cannot lift an admin hold.',
      );
    }

    if (updates.manualStatus !== 'ONLINE') return;

    if (isArchived || updates.isArchived === true) {
      throw new ConflictError('An archived/deactivated vehicle cannot be set ONLINE.');
    }
    if (isInactive) {
      throw new ConflictError(
        'Vehicle is blocked/inactive. Use the activate action to lift the admin hold before setting it ONLINE.',
      );
    }
    const verification = String(vehicle.verificationStatus || '').toUpperCase().trim();
    if (verification === 'REJECTED') {
      throw new ConflictError(
        'Vehicle verification was rejected. It must be re-verified and approved before it can be set ONLINE.',
      );
    }
    if (!VERIFIED_STATUSES.has(verification)) {
      throw new ConflictError(
        'Vehicle is not verified yet. Only VERIFIED/APPROVED vehicles can be set ONLINE.',
      );
    }
  }

  /**
   * PATCH /api/v1/admin/vehicles/:id/status
   * Updates vehicle status fields (manual_status, offline_reason, is_archived) with safety guards.
   *
   * @param {string} vehicleId
   * @param {object} body
   * @param {object} auditContext
   * @returns {Promise<object>}
   */
  async updateVehicleStatus(vehicleId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(vehicleId);

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body is required');
    }

    // Mass-assignment protection: reject disallowed fields
    Object.keys(body).forEach((key) => {
      if (!ALLOWED_STATUS_UPDATE_FIELDS.has(key)) {
        throw new ValidationError(`Field '${key}' is not allowed in vehicle status update`);
      }
    });

    const currentVehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!currentVehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const updates = {};

    if (body.manualStatus !== undefined || body.manual_status !== undefined) {
      const ms = String(body.manualStatus || body.manual_status).toUpperCase().trim();
      if (!ALLOWED_MANUAL_STATUSES.has(ms)) {
        throw new ValidationError(
          `Invalid manualStatus: must be one of ${Array.from(ALLOWED_MANUAL_STATUSES).join(', ')}`,
        );
      }
      updates.manualStatus = ms;
    }

    if (body.offlineReason !== undefined || body.offline_reason !== undefined) {
      const reasonVal = body.offlineReason !== undefined ? body.offlineReason : body.offline_reason;
      updates.offlineReason = reasonVal && typeof reasonVal === 'string'
        ? reasonVal.trim().slice(0, 100)
        : null;
    }

    if (body.isArchived !== undefined || body.is_archived !== undefined) {
      const val = body.isArchived !== undefined ? body.isArchived : body.is_archived;
      if (typeof val === 'boolean') {
        updates.isArchived = val;
      } else if (val === 'true') {
        updates.isArchived = true;
      } else if (val === 'false') {
        updates.isArchived = false;
      } else {
        throw new ValidationError('isArchived must be a boolean');
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new ValidationError('At least one mutable status field must be provided');
    }

    const force = Boolean(body.force);
    const reason = body.reason && typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 500)
      : null;

    let action = 'VEHICLE_STATUS_CHANGE';
    let beforeState = null;

    const updated = await adminVehicleRepository.withTransaction(async (client) => {
      const lockedVehicle = await adminVehicleRepository.findVehicleByIdForUpdate(validId, client);
      if (!lockedVehicle) {
        throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
      }

      // Lifecycle invariants are evaluated against the row-locked state (not the pre-read),
      // so a concurrent block/deactivate/rejection cannot be overridden by this request.
      this._assertGenericStatusTransitionAllowed(lockedVehicle, updates);
      const willOffline = updates.manualStatus === 'OFFLINE' && lockedVehicle.manualStatus !== 'OFFLINE';
      const willArchive = updates.isArchived === true && lockedVehicle.isArchived !== true;
      if (willArchive) action = 'VEHICLE_ARCHIVE';

      beforeState = {
        manualStatus: lockedVehicle.manualStatus,
        offlineReason: lockedVehicle.offlineReason,
        isArchived: lockedVehicle.isArchived,
        isActive: lockedVehicle.isActive !== false,
        verificationStatus: lockedVehicle.verificationStatus || null,
      };

      // Booking safety check under row lock: Prevent offlining or archiving when vehicle
      // has ongoing or upcoming bookings
      if ((willOffline || willArchive) && !force) {
        const activeBookings = await adminVehicleRepository.getActiveBookingCount(validId, client);
        if (activeBookings > 0) {
          const actionDesc = willArchive ? 'archive' : 'take offline';
          throw new ValidationError(
            `Cannot ${actionDesc} vehicle with ${activeBookings} active/upcoming bookings. `
            + 'Complete or reassign bookings first or specify force: true.',
            [{ field: 'vehicleId', message: 'Vehicle has active bookings', count: activeBookings }],
          );
        }
      }

      const res = await adminVehicleRepository.updateVehicleStatus(validId, updates, client);

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'vehicles.update',
        action,
        targetResource: 'VEHICLE',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: {
          manualStatus: res.manualStatus,
          offlineReason: res.offlineReason,
          isArchived: res.isArchived,
        },
        metadata: { reason, force, updates },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'vehicles.update',
      action,
      targetResource: 'VEHICLE',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState,
      afterState: {
        manualStatus: updated.manualStatus,
        offlineReason: updated.offlineReason,
        isArchived: updated.isArchived,
      },
      metadata: { reason, force, updates },
    });

    return updated;
  }

  /**
   * POST /api/v1/admin/vehicles/:id/approve
   * Approves vehicle verification with required document validation and audit logging.
   *
   * @param {string} vehicleId
   * @param {object} body
   * @param {object} auditContext
   * @returns {Promise<object>}
   */
  async approveVehicle(vehicleId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(vehicleId);

    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    if (vehicle.isArchived) {
      throw new ValidationError('Cannot verify an archived vehicle');
    }

    const reason = body.reason && typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 500)
      : 'Vehicle verified by admin';

    const beforeState = { verificationStatus: vehicle.verificationStatus };

    const updated = await adminVehicleRepository.withTransaction(async (client) => {
      const lockedVehicle = await adminVehicleRepository.findVehicleByIdForUpdate(validId, client);
      if (!lockedVehicle) {
        throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
      }
      if (lockedVehicle.isArchived) {
        throw new ValidationError('Cannot verify an archived vehicle');
      }

      const res = await adminVehicleRepository.updateVehicleVerification(
        validId,
        'VERIFIED',
        client,
      );

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'vehicles.verify',
        action: 'VEHICLE_APPROVED',
        targetResource: 'VEHICLE',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { verificationStatus: res.verificationStatus },
        metadata: { reason },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'vehicles.verify',
      action: 'VEHICLE_APPROVED',
      targetResource: 'VEHICLE',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState,
      afterState: { verificationStatus: updated.verificationStatus },
      metadata: { reason },
    });

    return updated;
  }

  /**
   * POST /api/v1/admin/vehicles/:id/reject
   * Rejects vehicle verification with required reason and audit logging.
   *
   * @param {string} vehicleId
   * @param {object} body
   * @param {object} auditContext
   * @returns {Promise<object>}
   */
  async rejectVehicle(vehicleId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(vehicleId);

    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const reason = body.reason && typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 500)
      : null;

    if (!reason) {
      throw new ValidationError('Rejection reason is required');
    }

    const beforeState = { verificationStatus: vehicle.verificationStatus };

    const updated = await adminVehicleRepository.withTransaction(async (client) => {
      const lockedVehicle = await adminVehicleRepository.findVehicleByIdForUpdate(validId, client);
      if (!lockedVehicle) {
        throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
      }

      const res = await adminVehicleRepository.updateVehicleVerification(
        validId,
        'REJECTED',
        client,
        reason,
      );

      if (lockedVehicle.partnerId && typeof client.query === 'function') {
        const vehicleLabel = lockedVehicle.brand && lockedVehicle.model
          ? `${lockedVehicle.brand} ${lockedVehicle.model} (${lockedVehicle.registrationNumber || ''})`
          : (lockedVehicle.registrationNumber || 'Vehicle');
        await client.query(`
          INSERT INTO partner_notifications (partner_id, type, title, body, payload, created_at)
          VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [
          lockedVehicle.partnerId,
          'VEHICLE_REJECTED',
          'Vehicle Verification Update',
          `Your vehicle ${vehicleLabel} was rejected by Admin. Reason: ${reason}. Vehicle remains online without Gongo Verified badge. Please update required details or documents to re-submit.`,
          JSON.stringify({ vehicleId: validId, reason, action: 'VEHICLE_REJECTED' }),
        ]).catch(() => {});
      }

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'vehicles.verify',
        action: 'VEHICLE_REJECTED',
        targetResource: 'VEHICLE',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { verificationStatus: res.verificationStatus },
        metadata: { reason },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'vehicles.verify',
      action: 'VEHICLE_REJECTED',
      targetResource: 'VEHICLE',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState,
      afterState: { verificationStatus: updated.verificationStatus },
      metadata: { reason },
    });

    return updated;
  }

  /**
   * PATCH /api/v1/admin/vehicles/:id/block
   */
  async blockVehicle(vehicleId, body = {}, auditContext = {}) {
    return this._applyLifecycleAction('BLOCK', vehicleId, body, auditContext);
  }

  /**
   * Shared, row-locked implementation of the admin BLOCK / ACTIVATE / DEACTIVATE actions.
   *
   * State model (existing columns only):
   *  - BLOCK:      manual_status OFFLINE, is_active false, is_archived false (temporary admin hold;
   *                the Partner AD-2 guard refuses ONLINE while is_active is false).
   *  - DEACTIVATE: manual_status OFFLINE, is_active false, is_archived true (permanent removal;
   *                Partner refuses any status change and Customer excludes archived vehicles).
   *  - ACTIVATE:   clears the admin restriction (is_active true, is_archived false). Only a
   *                VERIFIED/APPROVED vehicle is put ONLINE; REJECTED is refused (409); any other
   *                verification state (PENDING, UNDER_REVIEW, null) is restored as OFFLINE.
   *
   * The vehicle row is locked FOR UPDATE inside a transaction so these transitions serialize
   * with Customer booking creation (which locks the same row) and with each other. Existing
   * bookings are never cancelled. Like PATCH /:id/status, taking a vehicle offline or archiving
   * it is refused while it has active/upcoming bookings unless `force: true` is supplied.
   *
   * @private
   * @param {'BLOCK'|'ACTIVATE'|'DEACTIVATE'} kind
   * @param {string} vehicleId
   * @param {object} body
   * @param {object} auditContext
   * @returns {Promise<{ vehicle: object, message: string }>}
   */
  async _applyLifecycleAction(kind, vehicleId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(vehicleId);
    const safeBody = body && typeof body === 'object' ? body : {};
    const defaultReasons = {
      BLOCK: 'Blocked by admin',
      ACTIVATE: 'Activated by admin',
      DEACTIVATE: 'Deactivated by admin',
    };
    const reason = safeBody.reason && typeof safeBody.reason === 'string' && safeBody.reason.trim()
      ? safeBody.reason.trim().slice(0, 500)
      : defaultReasons[kind];

    let beforeState = null;
    let message = null;
    let auditAction = null;
    let appliedUpdates = null;
    let existingActiveBookings = 0;

    const updated = await adminVehicleRepository.withTransaction(async (client) => {
      const locked = await adminVehicleRepository.findVehicleByIdForUpdate(validId, client);
      if (!locked) {
        throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
      }

      beforeState = {
        manualStatus: locked.manualStatus,
        isActive: locked.isActive !== false,
        isArchived: locked.isArchived === true,
        verificationStatus: locked.verificationStatus || null,
        offlineReason: locked.offlineReason || null,
      };

      const updates = {};
      if (kind === 'BLOCK') {
        // offline_reason column is VARCHAR(100) in the repo schema.
        Object.assign(updates, {
          manualStatus: 'OFFLINE', isActive: false, isArchived: false, offlineReason: reason.slice(0, 100),
        });
        auditAction = 'BLOCK_VEHICLE';
        message = 'Vehicle blocked successfully';
      } else if (kind === 'DEACTIVATE') {
        Object.assign(updates, {
          manualStatus: 'OFFLINE', isActive: false, isArchived: true, offlineReason: reason.slice(0, 100),
        });
        auditAction = 'DEACTIVATE_VEHICLE';
        message = 'Vehicle deactivated successfully';
      } else {
        const verification = String(locked.verificationStatus || '').toUpperCase().trim();
        if (verification === 'REJECTED') {
          throw new ConflictError(
            'Vehicle verification was rejected. It must be re-verified and approved by admin before it can be activated.',
          );
        }
        const isVerified = VERIFIED_STATUSES.has(verification);
        Object.assign(updates, {
          manualStatus: isVerified ? 'ONLINE' : 'OFFLINE',
          isActive: true,
          isArchived: false,
          offlineReason: null,
        });
        auditAction = 'ACTIVATE_VEHICLE';
        message = isVerified
          ? 'Vehicle activated successfully'
          : 'Vehicle restriction lifted. It remains OFFLINE until its verification is approved.';
      }

      // Block/deactivate stop NEW bookings only; existing bookings stay intact (the Admin
      // UI's confirmation promises this, and these endpoints never refused before). The
      // count is reported so operations can follow up with affected customers.
      if (kind === 'BLOCK' || kind === 'DEACTIVATE') {
        existingActiveBookings = await adminVehicleRepository.getActiveBookingCount(validId, client);
      }

      appliedUpdates = updates;
      const res = await adminVehicleRepository.updateVehicleStatus(validId, updates, client);

      await auditService.recordAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'vehicles.update',
        action: auditAction,
        targetResource: 'VEHICLE',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: {
          manualStatus: updates.manualStatus,
          isActive: updates.isActive,
          isArchived: updates.isArchived,
          offlineReason: updates.offlineReason,
        },
        metadata: { reason, existingActiveBookings, updates: appliedUpdates },
      }, client);

      return res;
    });

    return { vehicle: updated, message, existingActiveBookings };
  }

  /**
   * PATCH /api/v1/admin/vehicles/:id/activate
   */
  async activateVehicle(vehicleId, body = {}, auditContext = {}) {
    return this._applyLifecycleAction('ACTIVATE', vehicleId, body, auditContext);
  }

  /**
   * PATCH /api/v1/admin/vehicles/:id/deactivate
   */
  async deactivateVehicle(vehicleId, body = {}, auditContext = {}) {
    return this._applyLifecycleAction('DEACTIVATE', vehicleId, body, auditContext);
  }

  /**
   * PATCH /api/v1/admin/vehicles/:id/verification
   * Updates vehicle verification status directly with validation and audit logging.
   *
   * @param {string} vehicleId
   * @param {object} body
   * @param {object} auditContext
   * @returns {Promise<object>}
   */
  async updateVehicleVerification(vehicleId, body = {}, auditContext = {}) {
    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body is required');
    }

    Object.keys(body).forEach((key) => {
      if (!ALLOWED_VERIFY_FIELDS.has(key)) {
        throw new ValidationError(`Field '${key}' is not allowed in verification update`);
      }
    });

    const status = body.status && typeof body.status === 'string'
      ? body.status.toUpperCase().trim()
      : null;

    if (!status || !ALLOWED_VERIFICATION_STATUSES.has(status)) {
      throw new ValidationError(
        `Invalid status: must be one of ${Array.from(ALLOWED_VERIFICATION_STATUSES).join(', ')}`,
      );
    }

    if (status === 'VERIFIED') {
      return this.approveVehicle(vehicleId, body, auditContext);
    }
    if (status === 'REJECTED') {
      return this.rejectVehicle(vehicleId, body, auditContext);
    }

    const validId = this._assertUuid(vehicleId);
    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const reason = body.reason && typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 500)
      : null;

    const beforeState = { verificationStatus: vehicle.verificationStatus };

    const updated = await adminVehicleRepository.withTransaction(async (client) => {
      const res = await adminVehicleRepository.updateVehicleVerification(validId, status, client);

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'vehicles.verify',
        action: 'VEHICLE_VERIFICATION_CHANGE',
        targetResource: 'VEHICLE',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { verificationStatus: res.verificationStatus },
        metadata: { reason, status },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'vehicles.verify',
      action: 'VEHICLE_VERIFICATION_CHANGE',
      targetResource: 'VEHICLE',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState,
      afterState: { verificationStatus: updated.verificationStatus },
      metadata: { reason, status },
    });

    return updated;
  }

  /**
   * GET /api/v1/admin/vehicles/:id/documents
   */
  async getVehicleDocuments(vehicleId) {
    const validId = this._assertUuid(vehicleId);
    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const rawDocs = await adminVehicleRepository.getVehicleDocuments(validId);
    const documents = await Promise.all(
      (rawDocs || []).map((doc) => this._resolveDocumentDetails(doc))
    );
    return { documents };
  }

  /**
   * GET /api/v1/admin/vehicles/:id/documents/:documentId
   * Strictly enforces server-side vehicle-document ownership validation.
   */
  async getVehicleDocumentDetail(vehicleId, documentId) {
    const validVehicleId = this._assertUuid(vehicleId);
    const validDocId = this._assertUuid(documentId);

    const vehicle = await adminVehicleRepository.findVehicleById(validVehicleId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const rawDoc = await adminVehicleRepository.findVehicleDocumentById(validDocId, validVehicleId);
    if (!rawDoc) {
      throw new NotFoundError('Document not found for this vehicle', ERROR_CODES.NOT_FOUND);
    }

    const document = await this._resolveDocumentDetails(rawDoc);
    return { document };
  }

  /**
   * GET /api/v1/admin/vehicles/:id/images
   */
  async getVehicleImages(vehicleId) {
    const validId = this._assertUuid(vehicleId);
    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const rawImages = await adminVehicleRepository.getVehicleImages(validId);
    const images = await Promise.all(
      (rawImages || []).map(async (img) => {
        let imgUrl = img.imageUrl || img.url;
        const imgKey = img.storageKey || imgUrl;
        if (imgKey && typeof imgKey === 'string' && !imgKey.startsWith('http://') && !imgKey.startsWith('https://')) {
          try {
            const presigned = await s3Provider.createPresignedGetUrl({ key: imgKey, expiresInSeconds: 86400 });
            if (presigned && presigned.downloadUrl) {
              imgUrl = presigned.downloadUrl;
            }
          } catch (err) {
            logger.warn('Failed to presign vehicle gallery image', { error: err.message, key: imgKey });
          }
        }
        return {
          ...img,
          imageUrl: imgUrl,
          url: imgUrl,
        };
      })
    );
    return { images };
  }

  /**
   * GET /api/v1/admin/vehicles/:id/bookings
   */
  async getVehicleBookings(vehicleId, query = {}) {
    const validId = this._assertUuid(vehicleId);
    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 10;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    const { bookings, total } = await adminVehicleRepository.getVehicleBookings(
      validId,
      {
        status: query.status || query.booking_status || null,
        limit,
        offset,
      },
    );

    const resolvedBookings = await Promise.all(
      (bookings || []).map(async (b) => {
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
        limit: Math.min(Math.max(1, limit), 50),
        offset: Math.max(0, offset),
      },
    };
  }

  /**
   * GET /api/v1/admin/vehicles/:id/availability
   */
  async getVehicleAvailability(vehicleId) {
    const validId = this._assertUuid(vehicleId);
    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const blocks = await adminVehicleRepository.getVehicleAvailability(validId);
    return {
      vehicleId: validId,
      rentalStatus: vehicle.rentalStatus,
      manualStatus: vehicle.manualStatus,
      availabilityBlocks: blocks,
    };
  }

  /**
   * GET /api/v1/admin/vehicles/:id/pricing
   */
  async getVehiclePricing(vehicleId) {
    const validId = this._assertUuid(vehicleId);
    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const pricing = await adminVehicleRepository.getVehiclePricing(validId);
    return {
      vehicleId: validId,
      pricing: pricing || {
        pricePerHour: 0,
        pricePer4Hours: 0,
        pricePerDay: 0,
        securityDeposit: 0,
        extraKmCharge: 0,
        currency: 'INR',
        isActive: false,
      },
    };
  }

  /**
   * GET /api/v1/admin/vehicles/:id/earnings
   */
  async getVehicleEarnings(vehicleId) {
    const validId = this._assertUuid(vehicleId);
    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const earnings = await adminVehicleRepository.getVehicleEarnings(validId);
    return {
      vehicleId: validId,
      ...earnings,
    };
  }

  /**
   * GET /api/v1/admin/vehicles/:id/history
   */
  async getVehicleHistory(vehicleId, query = {}) {
    const validId = this._assertUuid(vehicleId);
    const vehicle = await adminVehicleRepository.findVehicleById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 10;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    const { history, total } = await adminVehicleRepository.getVehicleHistory(
      validId,
      { limit, offset },
    );

    return {
      history,
      pagination: {
        total,
        limit: Math.min(Math.max(1, limit), 50),
        offset: Math.max(0, offset),
      },
    };
  }
}

module.exports = new AdminVehicleService();
