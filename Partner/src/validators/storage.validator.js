'use strict';

const path = require('path');
const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { detectProtectedFields } = require('../middlewares/massAssignment');
const { PROTECTED_SERVER_FIELDS } = require('../constants/fields');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_URL_PROTECTED_FIELDS = PROTECTED_SERVER_FIELDS.filter((f) => f.toLowerCase() !== 'storagekey');

const ALLOWED_ENTITY_TYPES = Object.freeze([
  'PROFILE_IMAGE',
  'KYC_DOCUMENT',
  'VEHICLE_IMAGE',
  'VEHICLE_DOCUMENT',
  'SUPPORT_ATTACHMENT',
]);

const ALLOWED_KYC_DOC_TYPES = Object.freeze([
  'AADHAAR',
  'PAN',
  'GST',
  'SHOP_ESTABLISHMENT',
]);

const ALLOWED_VEHICLE_DOC_TYPES = Object.freeze([
  'RC',
  'Insurance',
  'PUC',
  'Fitness',
  'Other',
  'INSURANCE',
  'FITNESS_CERTIFICATE',
]);

const MIME_CONFIG = {
  PROFILE_IMAGE: {
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
    maxSizeBytes: 5 * 1024 * 1024, // 5 MB
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp'],
  },
  KYC_DOCUMENT: {
    allowedMimes: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 10 * 1024 * 1024, // 10 MB
    allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
  },
  VEHICLE_IMAGE: {
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
    maxSizeBytes: 10 * 1024 * 1024, // 10 MB
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp'],
  },
  VEHICLE_DOCUMENT: {
    allowedMimes: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 10 * 1024 * 1024, // 10 MB
    allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
  },
  SUPPORT_ATTACHMENT: {
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxSizeBytes: 10 * 1024 * 1024, // 10 MB
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.pdf'],
  },
};

const EXTENSION_MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

const EXTRA_PROTECTED_STORAGE_FIELDS = [
  'storageKey',
  'storage_key',
  'bucket',
  'uploadUrl',
  'upload_url',
  'downloadUrl',
  'download_url',
  'partnerId',
  'partner_id',
  'status',
  'expiresAt',
  'expires_at',
  'completedAt',
  'completed_at',
  'actualSizeBytes',
  'actual_size_bytes',
  'verified',
  'isVerified',
  'is_verified',
  'approved',
  'isApproved',
  'is_approved',
  'valid',
  'isValid',
  'is_valid',
  'rejected',
  'isRejected',
  'is_rejected',
  'verificationStatus',
  'verification_status',
  'verifiedAt',
  'verified_at',
  'verifiedBy',
  'verified_by',
  'reviewerId',
  'reviewer_id',
  'adminNotes',
  'admin_notes',
  'approvalTimestamp',
  'approval_timestamp',
  'approvedAt',
  'approved_at',
];

class StorageValidator {
  /**
   * Validate POST /storage/presign request body.
   *
   * @param {object} body
   * @returns {object} Validated presign input
   */
  validatePresignInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    // Detect attempts to manipulate server-controlled fields
    const baseViolations = detectProtectedFields(body);
    const extraViolations = EXTRA_PROTECTED_STORAGE_FIELDS.filter(
      (f) => Object.prototype.hasOwnProperty.call(body, f),
    );
    const allViolations = Array.from(new Set([...baseViolations, ...extraViolations]));

    if (allViolations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${allViolations.join(', ')}] cannot be provided`,
        allViolations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    const errors = [];

    // 1. entityType
    if (!body.entityType) {
      errors.push({ field: 'entityType', message: 'entityType is required' });
    } else if (!ALLOWED_ENTITY_TYPES.includes(body.entityType)) {
      errors.push({
        field: 'entityType',
        message: `entityType must be one of: [${ALLOWED_ENTITY_TYPES.join(', ')}]`,
      });
    }

    const { entityType } = body;
    const config = MIME_CONFIG[entityType];

    // 2. fileName
    let ext = '';
    if (!body.fileName || typeof body.fileName !== 'string' || !body.fileName.trim()) {
      errors.push({ field: 'fileName', message: 'fileName is required and must be a non-empty string' });
    } else {
      const trimmedFileName = body.fileName.trim();
      if (trimmedFileName.length > 255) {
        errors.push({ field: 'fileName', message: 'fileName cannot exceed 255 characters' });
      } else if (trimmedFileName.includes('..') || trimmedFileName.includes('/') || trimmedFileName.includes('\\')) {
        errors.push({ field: 'fileName', message: 'fileName contains forbidden path traversal characters' });
      } else {
        ext = path.extname(trimmedFileName).toLowerCase();
        if (!ext) {
          errors.push({ field: 'fileName', message: 'fileName must have a valid file extension' });
        } else if (config && !config.allowedExtensions.includes(ext)) {
          errors.push({
            field: 'fileName',
            message: `File extension '${ext}' is not allowed for ${entityType}. Allowed extensions: [${config.allowedExtensions.join(', ')}]`,
          });
        }
      }
    }

    // 3. contentType
    let contentType = '';
    if (!body.contentType || typeof body.contentType !== 'string' || !body.contentType.trim()) {
      errors.push({ field: 'contentType', message: 'contentType is required and must be a valid MIME type' });
    } else {
      let rawType = body.contentType.trim().toLowerCase();
      if (rawType === 'application/x-pdf' || (ext === '.pdf' && (rawType === 'application/octet-stream' || rawType.includes('pdf')))) {
        rawType = 'application/pdf';
      }
      contentType = rawType;
      if (config && !config.allowedMimes.includes(contentType)) {
        errors.push({
          field: 'contentType',
          message: `MIME type '${contentType}' is not permitted for ${entityType}. Allowed types: [${config.allowedMimes.join(', ')}]`,
        });
      } else if (ext && EXTENSION_MIME_MAP[ext] && EXTENSION_MIME_MAP[ext] !== contentType) {
        // Special case: .jpg and .jpeg both map to image/jpeg
        errors.push({
          field: 'contentType',
          message: `File extension '${ext}' does not match contentType '${contentType}'`,
        });
      }
    }

    // 3b. fileSizeBytes validation (if supplied by client)
    const clientFileSize = body.fileSizeBytes !== undefined && body.fileSizeBytes !== null
      ? body.fileSizeBytes
      : (body.fileSize !== undefined && body.fileSize !== null ? body.fileSize : undefined);

    if (clientFileSize !== undefined) {
      if (typeof clientFileSize !== 'number' || Number.isNaN(clientFileSize) || clientFileSize <= 0) {
        errors.push({ field: 'fileSizeBytes', message: 'fileSizeBytes must be a positive number' });
      } else if (config && clientFileSize > config.maxSizeBytes) {
        errors.push({
          field: 'fileSizeBytes',
          message: `Declared file size (${clientFileSize} bytes) exceeds maximum allowed size (${config.maxSizeBytes} bytes) for ${entityType}`,
        });
      }
    }

    // 4. entity-specific fields
    let documentType = null;
    let documentNumber = null;
    let documentName = null;
    let validTill = null;
    let vehicleId = null;
    let isCover = false;
    let replacesImageId = null;

    if (entityType === 'KYC_DOCUMENT') {
      if (!body.documentType) {
        errors.push({ field: 'documentType', message: 'documentType is required for KYC_DOCUMENT' });
      } else {
        const normDocType = String(body.documentType).trim().toUpperCase();
        if (!ALLOWED_KYC_DOC_TYPES.includes(normDocType)) {
          errors.push({
            field: 'documentType',
            message: `documentType must be one of: [${ALLOWED_KYC_DOC_TYPES.join(', ')}]`,
          });
        } else {
          documentType = normDocType;
        }
      }

      if (body.documentNumber !== undefined && body.documentNumber !== null) {
        if (typeof body.documentNumber !== 'string' || body.documentNumber.trim().length > 100) {
          errors.push({ field: 'documentNumber', message: 'documentNumber must be a string up to 100 characters' });
        } else {
          documentNumber = body.documentNumber.trim();
        }
      }
    } else if (entityType === 'VEHICLE_IMAGE') {
      if (!body.vehicleId) {
        errors.push({ field: 'vehicleId', message: 'vehicleId is required for VEHICLE_IMAGE' });
      } else if (typeof body.vehicleId !== 'string' || !UUID_REGEX.test(body.vehicleId)) {
        errors.push({ field: 'vehicleId', message: 'vehicleId must be a valid UUID' });
      } else {
        vehicleId = body.vehicleId.trim();
      }

      if (body.isCover !== undefined && typeof body.isCover !== 'boolean') {
        errors.push({ field: 'isCover', message: 'isCover must be a boolean' });
      } else if (typeof body.isCover === 'boolean') {
        isCover = body.isCover;
      }

      if (body.replacesImageId !== undefined && body.replacesImageId !== null) {
        if (typeof body.replacesImageId !== 'string' || !UUID_REGEX.test(body.replacesImageId)) {
          errors.push({ field: 'replacesImageId', message: 'replacesImageId must be a valid UUID' });
        } else {
          replacesImageId = body.replacesImageId.trim();
        }
      }
    } else if (entityType === 'VEHICLE_DOCUMENT') {
      if (!body.vehicleId) {
        errors.push({ field: 'vehicleId', message: 'vehicleId is required for VEHICLE_DOCUMENT' });
      } else if (typeof body.vehicleId !== 'string' || !UUID_REGEX.test(body.vehicleId)) {
        errors.push({ field: 'vehicleId', message: 'vehicleId must be a valid UUID' });
      } else {
        vehicleId = body.vehicleId.trim();
      }

      if (!body.documentType) {
        errors.push({ field: 'documentType', message: 'documentType is required for VEHICLE_DOCUMENT' });
      } else {
        const foundDocType = ALLOWED_VEHICLE_DOC_TYPES.find(
          (t) => t.toUpperCase() === String(body.documentType).trim().toUpperCase(),
        );
        if (!foundDocType) {
          errors.push({
            field: 'documentType',
            message: `documentType must be one of: [${ALLOWED_VEHICLE_DOC_TYPES.join(', ')}]`,
          });
        } else {
          // Normalize to canonical DB schema types ('RC', 'Insurance', 'PUC', 'Fitness', 'Other')
          if (foundDocType === 'FITNESS_CERTIFICATE') {
            documentType = 'Fitness';
          } else if (foundDocType === 'INSURANCE') {
            documentType = 'Insurance';
          } else {
            documentType = foundDocType;
          }
        }
      }

      if (body.documentNumber !== undefined && body.documentNumber !== null) {
        if (typeof body.documentNumber !== 'string' || body.documentNumber.trim().length > 100) {
          errors.push({ field: 'documentNumber', message: 'documentNumber must be a string up to 100 characters' });
        } else {
          documentNumber = body.documentNumber.trim();
        }
      }

      const rawDocName = body.documentName || body.document_name || body.name;
      if (rawDocName !== undefined && rawDocName !== null) {
        if (typeof rawDocName !== 'string' || rawDocName.trim().length > 150) {
          errors.push({ field: 'documentName', message: 'documentName must be a string up to 150 characters' });
        } else {
          documentName = rawDocName.trim() || null;
        }
      }

      const rawValidTill = body.validTill || body.valid_till;
      if (rawValidTill !== undefined && rawValidTill !== null && rawValidTill !== '') {
        const parsedDate = new Date(rawValidTill);
        if (Number.isNaN(parsedDate.getTime())) {
          errors.push({ field: 'validTill', message: 'validTill must be a valid date' });
        } else {
          validTill = rawValidTill;
        }
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(errors[0].message, errors);
    }

    return {
      entityType,
      fileName: body.fileName.trim(),
      contentType,
      fileExtension: ext,
      maxSizeBytes: config.maxSizeBytes,
      documentType,
      documentNumber,
      documentName,
      validTill,
      vehicleId,
      isCover,
      replacesImageId,
    };
  }

  /**
   * Validate POST /storage/complete request body.
   *
   * @param {object} body
   * @returns {object} Validated completion input
   */
  validateCompleteInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    const violations = detectProtectedFields(body);
    if (violations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${violations.join(', ')}] cannot be provided`,
        violations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    const errors = [];

    if (!body.uploadId) {
      errors.push({ field: 'uploadId', message: 'uploadId is required' });
    } else if (typeof body.uploadId !== 'string' || !UUID_REGEX.test(body.uploadId)) {
      errors.push({ field: 'uploadId', message: 'uploadId must be a valid UUID' });
    }

    if (errors.length > 0) {
      throw new ValidationError(errors[0].message, errors);
    }

    return {
      uploadId: body.uploadId.trim(),
    };
  }

  /**
   * Validate POST /storage/access-url request body.
   *
   * @param {object} body
   * @returns {object} Validated access URL input
   */
  validateAccessUrlInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    const violations = detectProtectedFields(body, ACCESS_URL_PROTECTED_FIELDS);
    if (violations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${violations.join(', ')}] cannot be provided`,
        violations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    const errors = [];

    if (!body.storageKey || typeof body.storageKey !== 'string' || !body.storageKey.trim()) {
      errors.push({ field: 'storageKey', message: 'storageKey is required and must be a non-empty string' });
    } else {
      const key = body.storageKey.trim();
      if (key.length > 500) {
        errors.push({ field: 'storageKey', message: 'storageKey cannot exceed 500 characters' });
      } else if (key.includes('..') || key.startsWith('/') || key.startsWith('\\')) {
        errors.push({ field: 'storageKey', message: 'storageKey contains invalid or traversal characters' });
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(errors[0].message, errors);
    }

    return {
      storageKey: body.storageKey.trim(),
    };
  }
}

module.exports = new StorageValidator();
