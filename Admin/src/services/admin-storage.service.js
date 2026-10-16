'use strict';

const { validate: uuidValidate } = require('uuid');
const adminStorageRepository = require('../repositories/admin-storage.repository');
const s3Provider = require('../providers/s3');
const auditService = require('./audit.service');
const { BadRequestError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_WINDOW_DAYS = 90;
const PRESIGNED_URL_EXPIRES_SECONDS = 900; // 15 minutes canonical convention

function assertUuid(id, fieldName = 'ID') {
  if (!id || typeof id !== 'string' || (!uuidValidate(id) && !UUID_REGEX.test(id))) {
    throw new BadRequestError(
      `Invalid ${fieldName}: must be a valid RFC 4122 UUID v4`,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  return id;
}

class AdminStorageService {
  constructor(
    storageRepo = adminStorageRepository,
    s3 = s3Provider,
    audit = auditService,
  ) {
    this.storageRepo = storageRepo;
    this.s3 = s3;
    this.audit = audit;
  }

  /**
   * Lists administrative documents across partner, vehicle, and customer domains.
   *
   * @param {object} [query={}]
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async listDocuments(query = {}) {
    const {
      ownerId, entityId, partnerId, vehicleId, customerId,
      startDate, endDate, from, to,
    } = query;

    if (ownerId || entityId) {
      assertUuid(ownerId || entityId, 'ownerId');
    }
    if (partnerId) {
      assertUuid(partnerId, 'partnerId');
    }
    if (vehicleId) {
      assertUuid(vehicleId, 'vehicleId');
    }
    if (customerId) {
      assertUuid(customerId, 'customerId');
    }

    const { start, end } = this._validateDateRange(startDate || from, endDate || to);

    return this.storageRepo.listDocuments({
      ...query,
      startDate: start ? start.toISOString() : undefined,
      endDate: end ? end.toISOString() : undefined,
    });
  }

  /**
   * Retrieves single document detail with safe metadata and object verification.
   *
   * @param {string} id
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async getDocumentDetail(id, context = {}) {
    const validId = assertUuid(id, 'documentId');
    const document = await this.storageRepo.findDocumentById(validId);

    if (!document) {
      throw new NotFoundError(`Document '${validId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    let fileMetadata = null;
    if (document.storageKey) {
      try {
        const head = await this.s3.headObject({ key: document.storageKey });
        if (head) {
          fileMetadata = {
            contentLength: head.contentLength,
            contentType: head.contentType,
            lastModified: head.lastModified,
            exists: true,
          };
        } else {
          fileMetadata = { exists: false };
        }
      } catch (_) {
        fileMetadata = { exists: false };
      }
    }

    this._recordDocumentAudit({
      action: 'DOCUMENT_VIEWED',
      document,
      context,
    });

    return {
      ...document,
      fileMetadata,
    };
  }

  /**
   * Generates a short-lived presigned GET URL for administrative document access.
   * Resolves storage key exclusively from the canonical database record.
   *
   * @param {string} id
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async getDocumentSignedUrl(id, context = {}) {
    const validId = assertUuid(id, 'documentId');
    const document = await this.storageRepo.findDocumentById(validId);

    if (!document) {
      throw new NotFoundError(`Document '${validId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    if (!document.storageKey) {
      throw new BadRequestError('Document does not have an attached file', ERROR_CODES.VALIDATION_ERROR);
    }

    let head = null;
    try {
      head = await this.s3.headObject({ key: document.storageKey });
    } catch (err) {
      throw new BadRequestError('Failed to inspect storage object', ERROR_CODES.STORAGE_ERROR);
    }

    if (!head) {
      throw new NotFoundError('Storage object not found in repository', ERROR_CODES.NOT_FOUND);
    }

    let downloadUrl;
    try {
      const res = await this.s3.createPresignedGetUrl({
        key: document.storageKey,
        expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
      });
      downloadUrl = res.downloadUrl;
    } catch (_) {
      const supabaseStorage = require('../providers/supabase-storage');
      const res = await supabaseStorage.createPresignedDownloadUrl({
        path: document.storageKey,
        expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
      });
      downloadUrl = res.downloadUrl;
    }

    this._recordDocumentAudit({
      action: 'DOCUMENT_SIGNED_URL_GENERATED',
      document,
      context,
    });

    return {
      documentId: document.id,
      ownerType: document.ownerType,
      ownerId: document.ownerId,
      documentType: document.documentType,
      downloadUrl,
      expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
      fileSize: head?.contentLength || null,
      mimeType: head?.contentType || null,
    };
  }

  /**
   * Generates a temporary presigned URL for inline document preview.
   *
   * @param {string} id
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async previewDocument(id, context = {}) {
    const validId = assertUuid(id, 'documentId');
    const document = await this.storageRepo.findDocumentById(validId);

    if (!document) {
      throw new NotFoundError(`Document '${validId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    if (!document.storageKey) {
      throw new BadRequestError('Document does not have an attached file', ERROR_CODES.VALIDATION_ERROR);
    }

    let head = null;
    try {
      head = await this.s3.headObject({ key: document.storageKey });
    } catch (err) {
      throw new BadRequestError('Failed to inspect storage object', ERROR_CODES.STORAGE_ERROR);
    }

    if (!head) {
      throw new NotFoundError('Storage object not found in repository', ERROR_CODES.NOT_FOUND);
    }

    let previewUrl;
    try {
      const res = await this.s3.createPresignedGetUrl({
        key: document.storageKey,
        expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
        responseContentDisposition: 'inline',
      });
      previewUrl = res.downloadUrl;
    } catch (_) {
      const supabaseStorage = require('../providers/supabase-storage');
      const res = await supabaseStorage.createPresignedDownloadUrl({
        path: document.storageKey,
        expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
      });
      previewUrl = res.downloadUrl;
    }

    this._recordDocumentAudit({
      action: 'DOCUMENT_PREVIEWED',
      document,
      context,
    });

    return {
      previewUrl,
      documentId: document.id,
      ownerType: document.ownerType,
      ownerId: document.ownerId,
      documentType: document.documentType,
      expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
      contentType: head?.contentType || null,
      fileSize: head?.contentLength || null,
    };
  }

  /**
   * Generates a temporary presigned download URL with safe Content-Disposition attachment.
   *
   * @param {string} id
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async downloadDocument(id, context = {}) {
    const validId = assertUuid(id, 'documentId');
    const document = await this.storageRepo.findDocumentById(validId);

    if (!document) {
      throw new NotFoundError(`Document '${validId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    if (!document.storageKey) {
      throw new BadRequestError('Document does not have an attached file', ERROR_CODES.VALIDATION_ERROR);
    }

    let head = null;
    try {
      head = await this.s3.headObject({ key: document.storageKey });
    } catch (err) {
      throw new BadRequestError('Failed to inspect storage object', ERROR_CODES.STORAGE_ERROR);
    }

    if (!head) {
      throw new NotFoundError('Storage object not found in repository', ERROR_CODES.NOT_FOUND);
    }

    const ext = this._resolveFileExtension(document.storageKey, head?.contentType);
    const docType = (document.documentType || 'document').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const filename = `${docType}_${document.id.slice(0, 8)}.${ext}`;

    let downloadUrl;
    try {
      const res = await this.s3.createPresignedGetUrl({
        key: document.storageKey,
        expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
        responseContentDisposition: `attachment; filename="${filename}"`,
      });
      downloadUrl = res.downloadUrl;
    } catch (_) {
      const supabaseStorage = require('../providers/supabase-storage');
      const res = await supabaseStorage.createPresignedDownloadUrl({
        path: document.storageKey,
        expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
      });
      downloadUrl = res.downloadUrl;
    }

    this._recordDocumentAudit({
      action: 'DOCUMENT_DOWNLOADED',
      document,
      context,
      metadata: { filename },
    });

    return {
      downloadUrl,
      filename,
      documentId: document.id,
      ownerType: document.ownerType,
      ownerId: document.ownerId,
      documentType: document.documentType,
      expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
      contentType: head?.contentType || null,
      fileSize: head?.contentLength || null,
    };
  }

  /**
   * Generates a presigned upload URL for direct storage uploads (Supabase / S3).
   *
   * @param {object} params
   * @param {string} [params.bucket]
   * @param {string} [params.path]
   * @param {string} [params.fileName]
   * @param {string} [params.contentType]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async createUploadUrl({ bucket, path, fileName, contentType = 'application/octet-stream' } = {}, context = {}) {
    const now = new Date();
    const targetPath = path || (fileName
      ? `documents/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${fileName}`
      : `uploads/${Date.now()}`);
    const targetBucket = bucket || require('../config/env').SUPABASE_STORAGE_BUCKET || 'gongo-uploads';

    let result;
    try {
      const supabaseStorage = require('../providers/supabase-storage');
      result = await supabaseStorage.createPresignedUploadUrl({ bucket: targetBucket, path: targetPath });
    } catch (_) {
      result = await this.s3.createPresignedPutUrl({
        key: targetPath,
        contentType,
        expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
      });
    }

    try {
      this.audit.logAdminAction({
        actorId: context.actorId || null,
        actorRole: context.actorRole || 'ADMIN',
        permission: context.permission || 'storage.document.upload',
        action: 'STORAGE_UPLOAD_URL_GENERATED',
        targetResource: 'STORAGE_BUCKET',
        targetResourceId: targetBucket,
        requestId: context.requestId || null,
        ipAddress: context.ipAddress || null,
        userAgent: context.userAgent || null,
        metadata: { path: targetPath, bucket: targetBucket },
      });
    } catch (_) {}

    return {
      uploadUrl: result.uploadUrl,
      path: targetPath,
      expiresIn: result.expiresIn || PRESIGNED_URL_EXPIRES_SECONDS,
      token: result.token || null,
    };
  }

  /**
   * Generates a temporary presigned download URL for direct storage access.
   *
   * @param {object} params
   * @param {string} params.path
   * @param {string} [params.bucket]
   * @param {number} [params.expiresIn=3600]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async createDownloadUrl({ bucket, path, expiresIn = 3600 } = {}, context = {}) {
    if (!path) {
      throw new BadRequestError('path is required to generate download URL', ERROR_CODES.VALIDATION_ERROR);
    }
    const targetBucket = bucket || require('../config/env').SUPABASE_STORAGE_BUCKET || 'gongo-uploads';
    const supabaseStorage = require('../providers/supabase-storage');
    const result = await supabaseStorage.createPresignedDownloadUrl({
      bucket: targetBucket,
      path,
      expiresInSeconds: expiresIn,
    });

    try {
      this.audit.logAdminAction({
        actorId: context.actorId || null,
        actorRole: context.actorRole || 'ADMIN',
        permission: context.permission || 'storage.document.access',
        action: 'STORAGE_DOWNLOAD_URL_GENERATED',
        targetResource: 'STORAGE_OBJECT',
        targetResourceId: path,
        requestId: context.requestId || null,
        ipAddress: context.ipAddress || null,
        userAgent: context.userAgent || null,
        metadata: { path, bucket: targetBucket, expiresIn },
      });
    } catch (_) {}

    return {
      downloadUrl: result.downloadUrl,
      expiresIn,
    };
  }

  /**
   * Retrieves chronological administrative history for a document.
   *
   * @param {string} id
   * @returns {Promise<object[]>}
   */
  async getDocumentHistory(id) {
    const validId = assertUuid(id, 'documentId');
    const document = await this.storageRepo.findDocumentById(validId);

    if (!document) {
      throw new NotFoundError(`Document '${validId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    return this.storageRepo.findDocumentHistory(validId);
  }

  /**
   * Retrieves documents belonging to a specific partner.
   *
   * @param {string} partnerId
   * @param {object} [query={}]
   * @returns {Promise<{ partner: object, documents: object[] }>}
   */
  async getPartnerDocuments(partnerId, query = {}) {
    const cleanPartnerId = assertUuid(partnerId, 'partnerId');
    const result = await this.storageRepo.findDocumentsByPartner(cleanPartnerId, query);

    if (!result) {
      throw new NotFoundError(`Partner '${cleanPartnerId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    return result;
  }

  /**
   * Retrieves documents belonging to a specific vehicle.
   *
   * @param {string} vehicleId
   * @param {object} [query={}]
   * @returns {Promise<{ vehicle: object, documents: object[] }>}
   */
  async getVehicleDocuments(vehicleId, query = {}) {
    const cleanVehicleId = assertUuid(vehicleId, 'vehicleId');
    const result = await this.storageRepo.findDocumentsByVehicle(cleanVehicleId, query);

    if (!result) {
      throw new NotFoundError(`Vehicle '${cleanVehicleId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    return result;
  }

  /**
   * Retrieves documents belonging to a specific customer.
   *
   * @param {string} customerId
   * @param {object} [query={}]
   * @returns {Promise<{ customer: object, documents: object[] }>}
   */
  async getCustomerDocuments(customerId, query = {}) {
    const cleanCustomerId = assertUuid(customerId, 'customerId');
    const result = await this.storageRepo.findDocumentsByCustomer(cleanCustomerId, query);

    if (!result) {
      throw new NotFoundError(`Customer '${cleanCustomerId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    return result;
  }

  /**
   * Safe file extension resolver.
   * @private
   */
  _resolveFileExtension(storageKey, contentType) {
    if (storageKey && storageKey.includes('.')) {
      const parts = storageKey.split('.');
      const candidate = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
      if (candidate.length >= 2 && candidate.length <= 4) {
        return candidate;
      }
    }

    if (contentType) {
      const mime = contentType.toLowerCase();
      if (mime.includes('pdf')) return 'pdf';
      if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
      if (mime.includes('png')) return 'png';
      if (mime.includes('webp')) return 'webp';
    }

    return 'pdf';
  }

  /**
   * Emits audit event for document operation.
   * NEVER logs raw signed URLs, secrets, or AWS credentials.
   * @private
   */
  _recordDocumentAudit({ action, document, context = {}, metadata = {} }) {
    try {
      this.audit.logAdminAction({
        actorId: context.actorId || null,
        actorRole: context.actorRole || 'ADMIN',
        permission: context.permission || 'storage.read',
        action,
        targetResource: `${document.ownerType}_DOCUMENT`,
        targetResourceId: document.id,
        requestId: context.requestId || null,
        ipAddress: context.ipAddress || null,
        userAgent: context.userAgent || null,
        metadata: {
          documentId: document.id,
          ownerType: document.ownerType,
          ownerId: document.ownerId,
          documentType: document.documentType,
          ...metadata,
        },
      });
    } catch (_) {
      // Non-blocking audit failure
    }
  }

  /**
   * Validates date range parameters.
   * @private
   */
  _validateDateRange(startDate, endDate) {
    let start = null;
    let end = null;

    if (startDate) {
      start = new Date(startDate);
      if (Number.isNaN(start.getTime())) {
        throw new BadRequestError(`Invalid startDate: '${startDate}'`, ERROR_CODES.VALIDATION_ERROR);
      }
    }

    if (endDate) {
      end = new Date(endDate);
      if (Number.isNaN(end.getTime())) {
        throw new BadRequestError(`Invalid endDate: '${endDate}'`, ERROR_CODES.VALIDATION_ERROR);
      }
    }

    if (start && end) {
      if (start > end) {
        throw new BadRequestError(
          'startDate must be before or equal to endDate',
          ERROR_CODES.VALIDATION_ERROR,
        );
      }

      const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
      if (diffDays > MAX_QUERY_WINDOW_DAYS) {
        throw new BadRequestError(
          `Date query window exceeds maximum allowed ${MAX_QUERY_WINDOW_DAYS} days`,
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
    }

    return { start, end };
  }
}

const instance = new AdminStorageService();
instance.AdminStorageService = AdminStorageService;

module.exports = instance;
