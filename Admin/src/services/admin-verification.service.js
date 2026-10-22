'use strict';

const adminVerificationRepository = require('../repositories/admin-verification.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const auditService = require('./audit.service');
const s3Provider = require('../providers/s3');
const { ValidationError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const logger = require('../config/logger');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_KYC_STATUSES = new Set([
  'PENDING',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'UNVERIFIED',
  'ALL',
]);

const ALLOWED_APPROVE_FIELDS = new Set(['reason', 'force', 'notes', 'remarks']);
const ALLOWED_REJECT_FIELDS = new Set(['reason', 'force', 'notes', 'remarks']);

class AdminVerificationService {
  /**
   * Asserts valid RFC 4122 v4 UUID format.
   * @private
   */
  _assertUuid(id, paramName = 'id') {
    if (!id || typeof id !== 'string' || (!UUID_REGEX.test(id.trim()) && !/^(prt|veh|usr|cust|doc|adm|bkg|shp|sub)-[a-zA-Z0-9_-]+$/.test(id.trim()))) {
      throw new ValidationError(`Invalid ${paramName}: must be a valid identifier`, [
        { field: paramName, message: 'Invalid identifier format' },
      ]);
    }
    return id.trim();
  }

  /**
   * Validates and normalizes date range parameters.
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

  // ── Partner Verifications ──────────────────────────────────────────────────

  /**
   * GET /api/v1/admin/verifications/partners
   * Lists partners with verification/KYC status, search, and bounded pagination.
   */
  async listPartnerVerifications(query = {}) {
    const rawSearch = query.search || query.q;
    const search = rawSearch && typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, 100)
      : null;

    let kycStatus = null;
    const rawStatus = query.kycStatus || query.kyc_status || query.status;
    if (rawStatus) {
      const s = String(rawStatus).toUpperCase().trim();
      if (!ALLOWED_KYC_STATUSES.has(s)) {
        throw new ValidationError(
          `Invalid kycStatus: must be one of ${Array.from(ALLOWED_KYC_STATUSES).join(', ')}`,
        );
      }
      kycStatus = s;
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
    const sortBy = rawSortBy && typeof rawSortBy === 'string'
      ? rawSortBy.toLowerCase().trim()
      : 'created_at';

    const rawSortOrder = query.sortOrder || query.order;
    const sortOrder = rawSortOrder && String(rawSortOrder).toUpperCase().trim() === 'ASC'
      ? 'ASC'
      : 'DESC';

    logger.info('Listing partner verifications', {
      search,
      kycStatus,
      city,
      limit: safeLimit,
      offset: safeOffset,
    });

    const unverifiedOnly = Boolean(
      query.unverifiedOnly === true ||
      query.unverifiedOnly === 'true' ||
      kycStatus === 'UNVERIFIED'
    );

    const { partners, total } = await adminVerificationRepository.listPartnerVerifications({
      search,
      kycStatus,
      city,
      startDate,
      endDate,
      limit: safeLimit,
      offset: safeOffset,
      sortBy,
      sortOrder,
      unverifiedOnly,
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
   * GET /api/v1/admin/verifications/partners/:id
   * Retrieves partner verification detail with owner contact and uploaded documents.
   */
  async getPartnerVerificationDetail(partnerId) {
    const validId = this._assertUuid(partnerId, 'partnerId');

    const partner = await adminVerificationRepository.findPartnerVerificationById(validId);
    if (!partner) {
      throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
    }

    return partner;
  }

  /**
   * POST /api/v1/admin/verifications/partners/:id/approve
   * Approves partner KYC verification atomically with audit trail.
   */
  async approvePartner(partnerId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(partnerId, 'partnerId');

    if (body && typeof body === 'object') {
      Object.keys(body).forEach((key) => {
        if (!ALLOWED_APPROVE_FIELDS.has(key)) {
          throw new ValidationError(`Field '${key}' is not allowed in approve payload`);
        }
      });
    }

    const rawReason = body.reason || body.notes || body.remarks;
    const reason = rawReason && typeof rawReason === 'string'
      ? rawReason.trim().slice(0, 500)
      : 'Partner verified by admin';
    const force = Boolean(body.force);

    try {
      const updated = await adminVerificationRepository.withTransaction(async (client) => {
        const current = await adminVerificationRepository.findPartnerByIdForUpdate(validId, client);
        if (!current) {
          throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
        }

        if (current.kycStatus === 'VERIFIED' && !force) {
          return adminVerificationRepository.findPartnerVerificationById(validId, client);
        }

        const beforeState = {
          kycStatus: current.kycStatus,
          status: current.status,
          verificationStatus: current.verificationStatus,
          isActive: current.isActive,
        };

        const res = await adminVerificationRepository.updatePartnerKycStatus(
          validId,
          'VERIFIED',
          client,
          {
            previousStatus: current.kycStatus,
            reason,
            verifiedBy: auditContext.actorId || null,
          },
        );

        await adminActionRepository.createAction({
          actorId: auditContext.actorId || 'system-admin',
          actorRole: auditContext.actorRole || 'ADMIN',
          permission: auditContext.permission || 'kyc.verify',
          action: 'PARTNER_KYC_APPROVED',
          targetResource: 'PARTNER',
          targetResourceId: validId,
          requestId: auditContext.requestId || null,
          ipAddress: auditContext.ipAddress || null,
          userAgent: auditContext.userAgent || null,
          beforeState,
          afterState: {
            kycStatus: 'VERIFIED',
            status: res.status,
            verificationStatus: 'VERIFIED',
          },
          metadata: { reason, force, previousStatus: current.kycStatus },
        }, client);

        return res;
      });

      auditService.logAdminAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'kyc.verify',
        action: 'PARTNER_KYC_APPROVED',
        targetResource: 'PARTNER',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState: { kycStatus: updated.kycStatus === 'VERIFIED' ? 'PENDING' : updated.kycStatus },
        afterState: { kycStatus: 'VERIFIED' },
        metadata: { reason, force },
      });

      logger.info('Partner KYC approved successfully', {
        operation: 'approvePartner',
        partnerId: validId,
        requestId: auditContext.requestId || null,
        actorId: auditContext.actorId || null,
      });

      return updated;
    } catch (err) {
      logger.error('Failed to approve partner KYC', {
        operation: 'approvePartner',
        partnerId: validId,
        requestId: auditContext.requestId || null,
        errorCode: err.code || err.statusCode || 'UNKNOWN_ERROR',
        message: err.message,
      });
      throw err;
    }
  }

  /**
   * POST /api/v1/admin/verifications/partners/:id/reject
   * Rejects partner KYC verification with mandatory reason and audit trail.
   */
  async rejectPartner(partnerId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(partnerId, 'partnerId');

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body is required');
    }

    Object.keys(body).forEach((key) => {
      if (!ALLOWED_REJECT_FIELDS.has(key)) {
        throw new ValidationError(`Field '${key}' is not allowed in reject payload`);
      }
    });

    const rawReason = body.reason || body.notes || body.remarks;
    const reason = rawReason && typeof rawReason === 'string'
      ? rawReason.trim().slice(0, 500)
      : null;

    if (!reason || reason.length < 3) {
      throw new ValidationError(
        'A valid rejection reason (minimum 3 characters) is required',
        [{ field: 'reason', message: 'Rejection reason is mandatory' }],
      );
    }

    const force = Boolean(body.force);

    try {
      const updated = await adminVerificationRepository.withTransaction(async (client) => {
        const current = await adminVerificationRepository.findPartnerByIdForUpdate(validId, client);
        if (!current) {
          throw new NotFoundError('Partner not found', ERROR_CODES.NOT_FOUND);
        }

        if (current.kycStatus === 'REJECTED' && !force) {
          return adminVerificationRepository.findPartnerVerificationById(validId, client);
        }

        const beforeState = {
          kycStatus: current.kycStatus,
          status: current.status,
          verificationStatus: current.verificationStatus,
          isActive: current.isActive,
        };

        const res = await adminVerificationRepository.updatePartnerKycStatus(
          validId,
          'REJECTED',
          client,
          {
            previousStatus: current.kycStatus,
            reason,
            verifiedBy: auditContext.actorId || null,
          },
        );

        await adminActionRepository.createAction({
          actorId: auditContext.actorId || 'system-admin',
          actorRole: auditContext.actorRole || 'ADMIN',
          permission: auditContext.permission || 'kyc.reject',
          action: 'PARTNER_KYC_REJECTED',
          targetResource: 'PARTNER',
          targetResourceId: validId,
          requestId: auditContext.requestId || null,
          ipAddress: auditContext.ipAddress || null,
          userAgent: auditContext.userAgent || null,
          beforeState,
          afterState: {
            kycStatus: 'REJECTED',
            status: res.status,
            verificationStatus: 'REJECTED',
          },
          metadata: { reason, force, previousStatus: current.kycStatus },
        }, client);

        return res;
      });

      auditService.logAdminAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'kyc.reject',
        action: 'PARTNER_KYC_REJECTED',
        targetResource: 'PARTNER',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState: { kycStatus: updated.kycStatus === 'REJECTED' ? 'PENDING' : updated.kycStatus },
        afterState: { kycStatus: 'REJECTED' },
        metadata: { reason, force },
      });

      logger.info('Partner KYC rejected successfully', {
        operation: 'rejectPartner',
        partnerId: validId,
        requestId: auditContext.requestId || null,
        actorId: auditContext.actorId || null,
        reason,
      });

      return updated;
    } catch (err) {
      logger.error('Failed to reject partner KYC', {
        operation: 'rejectPartner',
        partnerId: validId,
        requestId: auditContext.requestId || null,
        errorCode: err.code || err.statusCode || 'UNKNOWN_ERROR',
        message: err.message,
      });
      throw err;
    }
  }

  // ── Vehicle Verifications ──────────────────────────────────────────────────

  /**
   * GET /api/v1/admin/verifications/vehicles
   * Lists vehicles with verification status, search, and bounded pagination.
   */
  async listVehicleVerifications(query = {}) {
    const rawSearch = query.search || query.q;
    const search = rawSearch && typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, 100)
      : null;

    let verificationStatus = null;
    const rawStatus = query.verificationStatus || query.verification_status || query.status;
    if (rawStatus) {
      const s = String(rawStatus).toUpperCase().trim();
      if (!ALLOWED_KYC_STATUSES.has(s)) {
        throw new ValidationError(
          `Invalid verificationStatus: must be one of ${Array.from(ALLOWED_KYC_STATUSES).join(', ')}`,
        );
      }
      verificationStatus = s;
    }

    let partnerId = null;
    if (query.partnerId || query.partner_id) {
      partnerId = this._assertUuid(query.partnerId || query.partner_id, 'partnerId');
    }

    const category = query.category && typeof query.category === 'string'
      ? query.category.toUpperCase().trim()
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
    const sortBy = rawSortBy && typeof rawSortBy === 'string'
      ? rawSortBy.toLowerCase().trim()
      : 'created_at';

    const rawSortOrder = query.sortOrder || query.order;
    const sortOrder = rawSortOrder && String(rawSortOrder).toUpperCase().trim() === 'ASC'
      ? 'ASC'
      : 'DESC';

    logger.info('Listing vehicle verifications', {
      search,
      verificationStatus,
      partnerId,
      limit: safeLimit,
      offset: safeOffset,
    });

    const unverifiedOnly = Boolean(
      query.unverifiedOnly === true ||
      query.unverifiedOnly === 'true' ||
      verificationStatus === 'UNVERIFIED'
    );

    const { vehicles, total } = await adminVerificationRepository.listVehicleVerifications({
      search,
      verificationStatus,
      partnerId,
      category,
      startDate,
      endDate,
      limit: safeLimit,
      offset: safeOffset,
      sortBy,
      sortOrder,
      unverifiedOnly,
    });

    const pages = Math.ceil(total / safeLimit) || 1;

    return {
      vehicles,
      pagination: {
        total,
        limit: safeLimit,
        offset: safeOffset,
        pages,
      },
    };
  }

  /**
   * GET /api/v1/admin/verifications/vehicles/:id
   * Retrieves vehicle verification detail with partner info, documents, and images.
   */
  async getVehicleVerificationDetail(vehicleId) {
    const validId = this._assertUuid(vehicleId, 'vehicleId');

    const vehicle = await adminVerificationRepository.findVehicleVerificationById(validId);
    if (!vehicle) {
      throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
    }

    if (vehicle.images && vehicle.images.length > 0) {
      vehicle.images = await Promise.all(
        vehicle.images.map(async (img) => {
          let url = img.imageUrl;
          const key = img.storageKey || img.imageUrl;
          if (key && !key.startsWith('http://') && !key.startsWith('https://')) {
            try {
              const res = await s3Provider.createPresignedGetUrl({ key, expiresInSeconds: 3600 });
              if (res && res.downloadUrl) {
                url = res.downloadUrl;
              }
            } catch (err) {
              logger.warn('Failed to presign vehicle image', { error: err.message, key });
            }
          }
          return {
            ...img,
            imageUrl: url,
            url,
          };
        })
      );
    }

    if (vehicle.documents && vehicle.documents.length > 0) {
      vehicle.documents = await Promise.all(
        vehicle.documents.map(async (doc) => {
          let downloadUrl = doc.fileUrl || null;
          const key = doc.storageKey || doc.fileUrl;
          if (key && !key.startsWith('http://') && !key.startsWith('https://')) {
            try {
              const res = await s3Provider.createPresignedGetUrl({ key, expiresInSeconds: 3600 });
              if (res && res.downloadUrl) {
                downloadUrl = res.downloadUrl;
              }
            } catch (err) {
              logger.warn('Failed to presign vehicle doc', { error: err.message, key });
            }
          }
          return {
            ...doc,
            fileUrl: downloadUrl,
            downloadUrl,
          };
        })
      );
    }

    return vehicle;
  }

  /**
   * POST /api/v1/admin/verifications/vehicles/:id/approve
   * Approves vehicle verification atomically with audit trail.
   */
  async approveVehicle(vehicleId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(vehicleId, 'vehicleId');

    if (body && typeof body === 'object') {
      Object.keys(body).forEach((key) => {
        if (!ALLOWED_APPROVE_FIELDS.has(key)) {
          throw new ValidationError(`Field '${key}' is not allowed in approve payload`);
        }
      });
    }

    const rawReason = body.reason || body.notes || body.remarks;
    const reason = rawReason && typeof rawReason === 'string'
      ? rawReason.trim().slice(0, 500)
      : 'Vehicle verified by admin';
    const force = Boolean(body.force);

    const updated = await adminVerificationRepository.withTransaction(async (client) => {
      const current = await adminVerificationRepository.findVehicleByIdForUpdate(validId, client);
      if (!current) {
        throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
      }

      if (current.isArchived) {
        throw new ValidationError('Cannot verify an archived vehicle');
      }

      if (current.verificationStatus === 'VERIFIED' && !force) {
        return adminVerificationRepository.findVehicleVerificationById(validId, client);
      }

      const beforeState = { verificationStatus: current.verificationStatus };
      const res = await adminVerificationRepository.updateVehicleVerificationStatus(
        validId,
        'VERIFIED',
        client,
      );

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'kyc.verify',
        action: 'VEHICLE_VERIFIED',
        targetResource: 'VEHICLE',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { verificationStatus: 'VERIFIED' },
        metadata: { reason, force, previousStatus: current.verificationStatus },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'kyc.verify',
      action: 'VEHICLE_VERIFIED',
      targetResource: 'VEHICLE',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState: { verificationStatus: updated.verificationStatus },
      afterState: { verificationStatus: 'VERIFIED' },
      metadata: { reason, force },
    });

    return updated;
  }

  /**
   * POST /api/v1/admin/verifications/vehicles/:id/reject
   * Rejects vehicle verification with mandatory reason and audit trail.
   */
  async rejectVehicle(vehicleId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(vehicleId, 'vehicleId');

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body is required');
    }

    Object.keys(body).forEach((key) => {
      if (!ALLOWED_REJECT_FIELDS.has(key)) {
        throw new ValidationError(`Field '${key}' is not allowed in reject payload`);
      }
    });

    const rawReason = body.reason || body.notes || body.remarks;
    const reason = rawReason && typeof rawReason === 'string'
      ? rawReason.trim().slice(0, 500)
      : null;

    if (!reason || reason.length < 3) {
      throw new ValidationError(
        'A valid rejection reason (minimum 3 characters) is required',
        [{ field: 'reason', message: 'Rejection reason is mandatory' }],
      );
    }

    const force = Boolean(body.force);

    const updated = await adminVerificationRepository.withTransaction(async (client) => {
      const current = await adminVerificationRepository.findVehicleByIdForUpdate(validId, client);
      if (!current) {
        throw new NotFoundError('Vehicle not found', ERROR_CODES.NOT_FOUND);
      }

      if (current.verificationStatus === 'REJECTED' && !force) {
        return adminVerificationRepository.findVehicleVerificationById(validId, client);
      }

      const beforeState = { verificationStatus: current.verificationStatus };
      const res = await adminVerificationRepository.updateVehicleVerificationStatus(
        validId,
        'REJECTED',
        client,
        reason,
      );

      if (current.partnerId && typeof client.query === 'function') {
        const vehicleLabel = current.brand && current.model
          ? `${current.brand} ${current.model} (${current.registrationNumber || ''})`
          : (current.registrationNumber || 'Vehicle');
        await client.query(`
          INSERT INTO partner_notifications (partner_id, type, title, body, payload, created_at)
          VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [
          current.partnerId,
          'VEHICLE_REJECTED',
          'Vehicle Verification Update',
          `Your vehicle ${vehicleLabel} was rejected by Admin. Reason: ${reason}. Vehicle remains online without Gongo Verified badge. Please update required details or documents to re-submit.`,
          JSON.stringify({ vehicleId: validId, reason, action: 'VEHICLE_REJECTED' }),
        ]).catch(() => {});
      }

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'kyc.reject',
        action: 'VEHICLE_REJECTED',
        targetResource: 'VEHICLE',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { verificationStatus: 'REJECTED' },
        metadata: { reason, force, previousStatus: current.verificationStatus },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'kyc.reject',
      action: 'VEHICLE_REJECTED',
      targetResource: 'VEHICLE',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState: { verificationStatus: updated.verificationStatus },
      afterState: { verificationStatus: 'REJECTED' },
      metadata: { reason, force },
    });

    return updated;
  }

  // ── Document Review & Secure S3 Signed URL ─────────────────────────────────

  /**
   * GET /api/v1/admin/verifications/documents/:id
   * Retrieves document metadata from either partner_documents or vehicle_documents.
   */
  async getDocumentDetail(documentId) {
    const validId = this._assertUuid(documentId, 'documentId');

    const result = await adminVerificationRepository.findDocumentById(validId);
    if (!result) {
      throw new NotFoundError('Document not found', ERROR_CODES.NOT_FOUND);
    }

    return result;
  }

  /**
   * GET /api/v1/admin/verifications/documents/:id/url
   * Generates a short-lived presigned GET URL for authorized administrative document preview.
   * Resolves storage key from canonical database; NEVER trusts client-supplied storage keys.
   */
  async getDocumentSignedUrl(documentId) {
    const validId = this._assertUuid(documentId, 'documentId');

    const result = await adminVerificationRepository.findDocumentById(validId);
    if (!result) {
      throw new NotFoundError('Document not found', ERROR_CODES.NOT_FOUND);
    }

    const { document, entityType } = result;

    if (!document.storageKey) {
      throw new ValidationError('Document does not have an attached file');
    }

    const expiresInSeconds = 900; // 15 minutes short-lived URL
    const { downloadUrl } = await s3Provider.createPresignedGetUrl({
      key: document.storageKey,
      expiresInSeconds,
    });

    return {
      documentId: document.id,
      entityType,
      entityId: document.entityId,
      documentType: document.documentType,
      documentNumber: document.documentNumber,
      downloadUrl,
      expiresInSeconds,
    };
  }

  /**
   * POST /api/v1/admin/verifications/documents/:id/approve
   * Approves an individual document (partner or vehicle document) with audit trail.
   */
  async approveDocument(documentId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(documentId, 'documentId');

    if (body && typeof body === 'object') {
      Object.keys(body).forEach((key) => {
        if (!ALLOWED_APPROVE_FIELDS.has(key)) {
          throw new ValidationError(`Field '${key}' is not allowed in approve payload`);
        }
      });
    }

    const rawReason = body.reason || body.notes || body.remarks;
    const reason = rawReason && typeof rawReason === 'string'
      ? rawReason.trim().slice(0, 500)
      : 'Document verified by admin';
    const force = Boolean(body.force);

    const docMeta = await adminVerificationRepository.findDocumentById(validId);
    if (!docMeta) {
      throw new NotFoundError('Document not found', ERROR_CODES.NOT_FOUND);
    }

    const isPartner = docMeta.entityType === 'PARTNER';

    const updated = await adminVerificationRepository.withTransaction(async (client) => {
      let current;
      if (isPartner) {
        current = await adminVerificationRepository.findPartnerDocumentByIdForUpdate(
          validId,
          client,
        );
      } else {
        current = await adminVerificationRepository.findVehicleDocumentByIdForUpdate(
          validId,
          client,
        );
      }

      if (!current) {
        throw new NotFoundError('Document not found', ERROR_CODES.NOT_FOUND);
      }

      if (current.verificationStatus === 'VERIFIED' && !force) {
        return current;
      }

      const beforeState = { verificationStatus: current.verificationStatus };
      let res;

      if (isPartner) {
        res = await adminVerificationRepository.updatePartnerDocumentStatus(
          validId,
          { verificationStatus: 'VERIFIED', rejectionReason: null },
          client,
        );
      } else {
        res = await adminVerificationRepository.updateVehicleDocumentStatus(
          validId,
          { verificationStatus: 'VERIFIED', rejectionReason: null },
          client,
        );
      }

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'kyc.verify',
        action: 'DOCUMENT_APPROVED',
        targetResource: isPartner ? 'PARTNER_DOCUMENT' : 'VEHICLE_DOCUMENT',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { verificationStatus: 'VERIFIED' },
        metadata: {
          reason,
          force,
          entityType: docMeta.entityType,
          entityId: docMeta.document.entityId,
          documentType: current.documentType,
        },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'kyc.verify',
      action: 'DOCUMENT_APPROVED',
      targetResource: isPartner ? 'PARTNER_DOCUMENT' : 'VEHICLE_DOCUMENT',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState: { verificationStatus: updated.verificationStatus },
      afterState: { verificationStatus: 'VERIFIED' },
      metadata: { reason, force },
    });

    return updated;
  }

  /**
   * POST /api/v1/admin/verifications/documents/:id/reject
   * Rejects an individual document with mandatory reason and audit trail.
   */
  async rejectDocument(documentId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(documentId, 'documentId');

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body is required');
    }

    Object.keys(body).forEach((key) => {
      if (!ALLOWED_REJECT_FIELDS.has(key)) {
        throw new ValidationError(`Field '${key}' is not allowed in reject payload`);
      }
    });

    const rawReason = body.reason || body.notes || body.remarks;
    const reason = rawReason && typeof rawReason === 'string'
      ? rawReason.trim().slice(0, 500)
      : null;

    if (!reason || reason.length < 3) {
      throw new ValidationError(
        'A valid rejection reason (minimum 3 characters) is required',
        [{ field: 'reason', message: 'Rejection reason is mandatory' }],
      );
    }

    const force = Boolean(body.force);

    const docMeta = await adminVerificationRepository.findDocumentById(validId);
    if (!docMeta) {
      throw new NotFoundError('Document not found', ERROR_CODES.NOT_FOUND);
    }

    const isPartner = docMeta.entityType === 'PARTNER';

    const updated = await adminVerificationRepository.withTransaction(async (client) => {
      let current;
      if (isPartner) {
        current = await adminVerificationRepository.findPartnerDocumentByIdForUpdate(
          validId,
          client,
        );
      } else {
        current = await adminVerificationRepository.findVehicleDocumentByIdForUpdate(
          validId,
          client,
        );
      }

      if (!current) {
        throw new NotFoundError('Document not found', ERROR_CODES.NOT_FOUND);
      }

      if (current.verificationStatus === 'REJECTED' && !force) {
        return current;
      }

      const beforeState = {
        verificationStatus: current.verificationStatus,
        rejectionReason: current.rejectionReason,
      };

      let res;
      if (isPartner) {
        res = await adminVerificationRepository.updatePartnerDocumentStatus(
          validId,
          { verificationStatus: 'REJECTED', rejectionReason: reason },
          client,
        );
      } else {
        res = await adminVerificationRepository.updateVehicleDocumentStatus(
          validId,
          { verificationStatus: 'REJECTED', rejectionReason: reason },
          client,
        );

        if (docMeta.document?.partnerId && typeof client.query === 'function') {
          // Vehicle remains online, but verification status becomes REJECTED with rejection reason
          await client.query(`
            UPDATE vehicles
            SET verification_status = 'REJECTED', rejection_reason = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
          `, [docMeta.document.entityId, reason]).catch(() => {});

          const docLabel = current.documentType || 'Document';
          const vehicleReg = docMeta.document.entityName || 'Vehicle';
          await client.query(`
            INSERT INTO partner_notifications (partner_id, type, title, body, payload, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
          `, [
            docMeta.document.partnerId,
            'VEHICLE_REJECTED',
            'Vehicle Document Rejected',
            `The ${docLabel} for vehicle ${vehicleReg} was rejected by Admin. Reason: ${reason}. Vehicle remains online without Gongo Verified badge. Please re-upload the document.`,
            JSON.stringify({ vehicleId: docMeta.document.entityId, documentId: validId, documentType: docLabel, reason, action: 'VEHICLE_DOCUMENT_REJECTED' }),
          ]).catch(() => {});
        }
      }

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'kyc.reject',
        action: 'DOCUMENT_REJECTED',
        targetResource: isPartner ? 'PARTNER_DOCUMENT' : 'VEHICLE_DOCUMENT',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { verificationStatus: 'REJECTED', rejectionReason: reason },
        metadata: {
          reason,
          force,
          entityType: docMeta.entityType,
          entityId: docMeta.document.entityId,
          documentType: current.documentType,
        },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'kyc.reject',
      action: 'DOCUMENT_REJECTED',
      targetResource: isPartner ? 'PARTNER_DOCUMENT' : 'VEHICLE_DOCUMENT',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState: { verificationStatus: updated.verificationStatus },
      afterState: { verificationStatus: 'REJECTED' },
      metadata: { reason, force },
    });

    return updated;
  }

  // ── Vehicle Image Review & Secure Signed URL (Step 11) ──────────────────────

  /**
   * GET /api/v1/admin/verifications/vehicle-images/:id
   * Retrieves vehicle image metadata including verification status and vehicle relationship.
   */
  async getVehicleImageDetail(imageId) {
    const validId = this._assertUuid(imageId, 'imageId');

    const image = await adminVerificationRepository.findVehicleImageById(validId);
    if (!image) {
      throw new NotFoundError('Vehicle image not found', ERROR_CODES.NOT_FOUND);
    }

    return image;
  }

  /**
   * GET /api/v1/admin/verifications/vehicle-images/:id/url
   * Generates a short-lived presigned GET URL for authorized administrative vehicle image preview.
   * Resolves storage key from canonical database; NEVER trusts client-supplied storage keys.
   */
  async getVehicleImageSignedUrl(imageId) {
    const validId = this._assertUuid(imageId, 'imageId');

    const image = await adminVerificationRepository.findVehicleImageById(validId);
    if (!image) {
      throw new NotFoundError('Vehicle image not found', ERROR_CODES.NOT_FOUND);
    }

    if (!image.storageKey) {
      throw new ValidationError('Vehicle image does not have an attached file');
    }

    const expiresInSeconds = 900; // 15 minutes short-lived URL
    const { downloadUrl } = await s3Provider.createPresignedGetUrl({
      key: image.storageKey,
      expiresInSeconds,
    });

    return {
      imageId: image.id,
      vehicleId: image.vehicleId,
      entityName: image.entityName,
      storageKey: image.storageKey,
      downloadUrl,
      expiresInSeconds,
    };
  }

  /**
   * POST /api/v1/admin/verifications/vehicle-images/:id/approve
   * Approves an individual vehicle image with audit trail.
   */
  async approveVehicleImage(imageId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(imageId, 'imageId');

    if (body && typeof body === 'object') {
      Object.keys(body).forEach((key) => {
        if (!ALLOWED_APPROVE_FIELDS.has(key)) {
          throw new ValidationError(`Field '${key}' is not allowed in approve payload`);
        }
      });
    }

    const rawReason = body.reason || body.notes || body.remarks;
    const reason = rawReason && typeof rawReason === 'string'
      ? rawReason.trim().slice(0, 500)
      : 'Vehicle photo verified by admin';
    const force = Boolean(body.force);

    const imageMeta = await adminVerificationRepository.findVehicleImageById(validId);
    if (!imageMeta) {
      throw new NotFoundError('Vehicle image not found', ERROR_CODES.NOT_FOUND);
    }

    const updated = await adminVerificationRepository.withTransaction(async (client) => {
      const current = await adminVerificationRepository.findVehicleImageByIdForUpdate(
        validId,
        client,
      );
      if (!current) {
        throw new NotFoundError('Vehicle image not found', ERROR_CODES.NOT_FOUND);
      }

      if (current.verificationStatus === 'VERIFIED' && !force) {
        return current;
      }

      const beforeState = { verificationStatus: current.verificationStatus };

      const res = await adminVerificationRepository.updateVehicleImageStatus(
        validId,
        {
          verificationStatus: 'VERIFIED',
          rejectionReason: null,
          adminId: auditContext.actorId,
        },
        client,
      );

      // Synchronize vehicle primary image reference
      if (client && typeof client.query === 'function') {
        const syncSql = `
          UPDATE vehicles
          SET primary_image_url = (
            SELECT storage_key FROM vehicle_images
            WHERE vehicle_id = $1 AND is_active = true
            ORDER BY
              (verification_status IN ('VERIFIED', 'APPROVED') AND is_cover = true) DESC,
              (verification_status IN ('VERIFIED', 'APPROVED')) DESC,
              (verification_status = 'PENDING' AND is_cover = true) DESC,
              (verification_status = 'PENDING') DESC,
              sort_order ASC, created_at ASC
            LIMIT 1
          ), updated_at = CURRENT_TIMESTAMP
          WHERE id = $1;
        `;
        await client.query(syncSql, [current.vehicleId]);
      }

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'vehicles.verify',
        action: 'VEHICLE_IMAGE_APPROVED',
        targetResource: 'VEHICLE_IMAGE',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { verificationStatus: 'VERIFIED' },
        metadata: {
          reason,
          force,
          vehicleId: current.vehicleId,
          partnerId: current.partnerId,
          version: current.version,
        },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'vehicles.verify',
      action: 'VEHICLE_IMAGE_APPROVED',
      targetResource: 'VEHICLE_IMAGE',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState: { verificationStatus: updated.verificationStatus },
      afterState: { verificationStatus: 'VERIFIED' },
      metadata: { reason, force },
    });

    return updated;
  }

  /**
   * POST /api/v1/admin/verifications/vehicle-images/:id/reject
   * Rejects an individual vehicle image with mandatory rejection reason and audit trail.
   * Atomically cascades vehicle verification_status to REJECTED and manual_status to OFFLINE.
   */
  async rejectVehicleImage(imageId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(imageId, 'imageId');

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body is required');
    }

    Object.keys(body).forEach((key) => {
      if (!ALLOWED_REJECT_FIELDS.has(key)) {
        throw new ValidationError(`Field '${key}' is not allowed in reject payload`);
      }
    });

    const rawReason = body.reason || body.notes || body.remarks;
    const reason = rawReason && typeof rawReason === 'string'
      ? rawReason.trim().slice(0, 500)
      : null;

    if (!reason || reason.length < 3) {
      throw new ValidationError(
        'A valid rejection reason (minimum 3 characters) is required',
        [{ field: 'reason', message: 'Rejection reason is mandatory' }],
      );
    }

    const force = Boolean(body.force);

    const imageMeta = await adminVerificationRepository.findVehicleImageById(validId);
    if (!imageMeta) {
      throw new NotFoundError('Vehicle image not found', ERROR_CODES.NOT_FOUND);
    }

    const updated = await adminVerificationRepository.withTransaction(async (client) => {
      const current = await adminVerificationRepository.findVehicleImageByIdForUpdate(
        validId,
        client,
      );
      if (!current) {
        throw new NotFoundError('Vehicle image not found', ERROR_CODES.NOT_FOUND);
      }

      if (current.verificationStatus === 'REJECTED' && !force && current.rejectionReason === reason) {
        return current;
      }

      const beforeState = {
        verificationStatus: current.verificationStatus,
        rejectionReason: current.rejectionReason,
      };

      const res = await adminVerificationRepository.updateVehicleImageStatus(
        validId,
        {
          verificationStatus: 'REJECTED',
          rejectionReason: reason,
          adminId: auditContext.actorId,
        },
        client,
      );

      // Vehicle remains online without Gongo Verified badge, primary image resynchronized
      const vSql = `
        UPDATE vehicles
        SET verification_status = 'REJECTED', rejection_reason = $2,
            primary_image_url = (
              SELECT storage_key FROM vehicle_images
              WHERE vehicle_id = $1 AND is_active = true AND verification_status != 'REJECTED'
              ORDER BY
                (verification_status IN ('VERIFIED', 'APPROVED') AND is_cover = true) DESC,
                (verification_status IN ('VERIFIED', 'APPROVED')) DESC,
                (verification_status = 'PENDING' AND is_cover = true) DESC,
                (verification_status = 'PENDING') DESC,
                sort_order ASC, created_at ASC
              LIMIT 1
            ),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1;
      `;
      if (typeof client.query === 'function') {
        await client.query(vSql, [current.vehicleId, reason]);
        if (current.partnerId) {
          await client.query(`
            INSERT INTO partner_notifications (partner_id, type, title, body, payload, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
          `, [
            current.partnerId,
            'VEHICLE_REJECTED',
            'Vehicle Image Rejected',
            `An image for your vehicle was rejected by Admin. Reason: ${reason}. Vehicle remains online without Gongo Verified badge. Please upload a new image.`,
            JSON.stringify({ vehicleId: current.vehicleId, imageId: validId, reason, action: 'VEHICLE_IMAGE_REJECTED' }),
          ]).catch(() => {});
        }
      }

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'vehicles.verify',
        action: 'VEHICLE_IMAGE_REJECTED',
        targetResource: 'VEHICLE_IMAGE',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { verificationStatus: 'REJECTED', rejectionReason: reason },
        metadata: {
          reason,
          force,
          vehicleId: current.vehicleId,
          partnerId: current.partnerId,
          version: current.version,
        },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'vehicles.verify',
      action: 'VEHICLE_IMAGE_REJECTED',
      targetResource: 'VEHICLE_IMAGE',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState: { verificationStatus: updated.verificationStatus },
      afterState: { verificationStatus: 'REJECTED' },
      metadata: { reason, force },
    });

    return updated;
  }

  // ── Unified KYC Listing ────────────────────────────────────────────────────

  /**
   * GET /api/v1/admin/verifications/kyc
   * Unified KYC queue across partners and vehicles with filters and pagination.
   */
  async listKyc(query = {}) {
    const rawSearch = query.search || query.q;
    const search = rawSearch && typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, 100)
      : null;

    let status = null;
    const rawStatus = query.status || query.kycStatus;
    if (rawStatus) {
      const s = String(rawStatus).toUpperCase().trim();
      if (!ALLOWED_KYC_STATUSES.has(s)) {
        throw new ValidationError(
          `Invalid status: must be one of ${Array.from(ALLOWED_KYC_STATUSES).join(', ')}`,
        );
      }
      status = s;
    }

    let entityType = null;
    if (query.entityType || query.entity_type) {
      const et = String(query.entityType || query.entity_type).toUpperCase().trim();
      if (!['PARTNER', 'VEHICLE'].includes(et)) {
        throw new ValidationError("entityType must be either 'PARTNER' or 'VEHICLE'");
      }
      entityType = et;
    }

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

    const { items, total } = await adminVerificationRepository.listKycVerifications({
      search,
      status,
      entityType,
      startDate,
      endDate,
      limit: safeLimit,
      offset: safeOffset,
    });

    const pages = Math.ceil(total / safeLimit) || 1;

    return {
      items,
      pagination: {
        total,
        limit: safeLimit,
        offset: safeOffset,
        pages,
      },
    };
  }
}

module.exports = new AdminVerificationService();
