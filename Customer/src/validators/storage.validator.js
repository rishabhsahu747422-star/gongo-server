'use strict';

const { BadRequestError } = require('../errors');
const {
  CUSTOMER_DOCUMENT_TYPES,
  ALLOWED_DOCUMENT_MIMES,
  ALLOWED_AVATAR_MIMES,
  MAX_DOCUMENT_SIZE_BYTES,
  MAX_AVATAR_SIZE_BYTES,
  STORAGE_ERROR_CODES,
} = require('../constants/storage');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Forbidden fields that clients must never inject
const FORBIDDEN_CLIENT_FIELDS = [
  'customerId',
  'userId',
  'role',
  'storageKey',
  's3Key',
  'bucket',
  'path',
  'status',
  'verificationStatus',
  'rejectionReason',
  'verifiedAt',
  'createdAt',
  'updatedAt',
];

function checkForbiddenFields(body) {
  FORBIDDEN_CLIENT_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      throw new BadRequestError(
        `Field '${field}' is not permitted in request payload`,
        'FORBIDDEN_PAYLOAD_FIELD',
      );
    }
  });
}

/**
 * Validates request to generate presigned upload URL for customer KYC document.
 */
function validateDocumentUploadUrl(req, res, next) {
  try {
    const { body } = req;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestError('Request body must be a valid JSON object', 'INVALID_PAYLOAD');
    }

    checkForbiddenFields(body);

    const rawDocType = String(body.documentType || body.type || '').trim().toUpperCase();
    const documentType = rawDocType === 'AADHAR' ? 'AADHAAR' : rawDocType;
    if (!documentType) {
      throw new BadRequestError('documentType is required', 'MISSING_DOCUMENT_TYPE');
    }

    const allowedTypes = Object.values(CUSTOMER_DOCUMENT_TYPES);
    if (!allowedTypes.includes(documentType)) {
      throw new BadRequestError(
        `Unsupported document type '${rawDocType}'. Allowed types: ${allowedTypes.join(', ')}.`,
        STORAGE_ERROR_CODES.INVALID_DOCUMENT_TYPE,
      );
    }

    const contentType = (body.contentType || body.mimeType || '').trim().toLowerCase();
    if (!contentType) {
      throw new BadRequestError('contentType is required', 'MISSING_CONTENT_TYPE');
    }

    if (!ALLOWED_DOCUMENT_MIMES.includes(contentType)) {
      throw new BadRequestError(
        `Unsupported MIME type '${contentType}'. Allowed types: ${ALLOWED_DOCUMENT_MIMES.join(', ')}`,
        STORAGE_ERROR_CODES.UNSUPPORTED_MIME_TYPE,
      );
    }

    const fileSize = body.fileSize !== undefined ? Number(body.fileSize) : undefined;
    if (fileSize !== undefined) {
      if (Number.isNaN(fileSize) || fileSize <= 0) {
        throw new BadRequestError('fileSize must be a positive number of bytes', 'INVALID_FILE_SIZE');
      }
      if (fileSize > MAX_DOCUMENT_SIZE_BYTES) {
        throw new BadRequestError(
          `Document file size exceeds maximum limit of ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)} MB`,
          STORAGE_ERROR_CODES.FILE_TOO_LARGE,
        );
      }
    }

    const rawSide = String(body.side || body.documentSide || '').trim().toLowerCase();
    const side = (rawSide === 'front' || rawSide === 'back') ? rawSide : undefined;

    req.validatedBody = {
      documentType,
      contentType,
      fileSize: fileSize || MAX_DOCUMENT_SIZE_BYTES,
      fileExtension: body.fileExtension,
      side,
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Validates request to confirm KYC document upload completion.
 */
const AADHAAR_REGEX = /^\d{12}$/;

function validateDocumentCompletion(req, res, next) {
  try {
    const { body } = req;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestError('Request body must be a valid JSON object', 'INVALID_PAYLOAD');
    }

    checkForbiddenFields(body);

    const uploadId = body.uploadId || body.upload_id;
    if (uploadId && !UUID_REGEX.test(uploadId)) {
      throw new BadRequestError('Valid uploadId UUID is required', 'INVALID_UPLOAD_ID');
    }

    const frontUploadId = body.frontUploadId || body.front_upload_id;
    if (frontUploadId && !UUID_REGEX.test(frontUploadId)) {
      throw new BadRequestError('Valid frontUploadId UUID is required', 'INVALID_UPLOAD_ID');
    }

    const backUploadId = body.backUploadId || body.back_upload_id;
    if (backUploadId && !UUID_REGEX.test(backUploadId)) {
      throw new BadRequestError('Valid backUploadId UUID is required', 'INVALID_UPLOAD_ID');
    }

    const rawSide = String(body.side || body.documentSide || '').trim().toLowerCase();
    const side = (rawSide === 'front' || rawSide === 'back') ? rawSide : undefined;

    const rawDocType = (body.documentType || body.type)
      ? String(body.documentType || body.type).trim().toUpperCase()
      : null;
    const documentType = rawDocType === 'AADHAR' ? CUSTOMER_DOCUMENT_TYPES.AADHAAR : rawDocType;
    const allowedTypes = Object.values(CUSTOMER_DOCUMENT_TYPES);
    if (documentType && !allowedTypes.includes(documentType)) {
      throw new BadRequestError(
        `Unsupported document type '${documentType}'. Allowed types: ${allowedTypes.join(', ')}.`,
        STORAGE_ERROR_CODES.INVALID_DOCUMENT_TYPE,
      );
    }

    const rawDocNumber = body.documentNumber || body.document_number || body.number;
    let cleanDocNumber = null;

    if (rawDocNumber !== undefined && rawDocNumber !== null) {
      const numStr = String(rawDocNumber).trim().replace(/\s+/g, '');
      if (documentType === CUSTOMER_DOCUMENT_TYPES.AADHAAR) {
        if (!AADHAAR_REGEX.test(numStr) || /^(\d)\1{11}$/.test(numStr)) {
          throw new BadRequestError(
            'Invalid Aadhaar number. Must be exactly 12 numeric digits.',
            'INVALID_AADHAAR_NUMBER',
          );
        }
      } else if (numStr.length < 4 || numStr.length > 30) {
        throw new BadRequestError(
          'Invalid document number length.',
          'INVALID_DOCUMENT_NUMBER',
        );
      }
      cleanDocNumber = numStr;
    }

    // Must have either uploadId, front/backUploadId, or documentNumber
    if (!uploadId && !frontUploadId && !backUploadId && !cleanDocNumber) {
      throw new BadRequestError(
        'Document verification requires documentNumber or uploadId',
        'MISSING_DOCUMENT_PAYLOAD',
      );
    }

    req.validatedBody = {
      uploadId: uploadId || undefined,
      frontUploadId: frontUploadId || undefined,
      backUploadId: backUploadId || undefined,
      documentType: documentType || (cleanDocNumber ? CUSTOMER_DOCUMENT_TYPES.AADHAAR : undefined),
      documentNumber: cleanDocNumber || undefined,
      side,
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Validates request to generate presigned upload URL for customer avatar.
 */
function validateAvatarUploadUrl(req, res, next) {
  try {
    const { body } = req;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestError('Request body must be a valid JSON object', 'INVALID_PAYLOAD');
    }

    checkForbiddenFields(body);

    const contentType = (body.contentType || body.mimeType || '').trim().toLowerCase();
    if (!contentType) {
      throw new BadRequestError('contentType is required', 'MISSING_CONTENT_TYPE');
    }

    if (!ALLOWED_AVATAR_MIMES.includes(contentType)) {
      throw new BadRequestError(
        `Unsupported avatar MIME type '${contentType}'. Allowed types: ${ALLOWED_AVATAR_MIMES.join(', ')}`,
        STORAGE_ERROR_CODES.UNSUPPORTED_MIME_TYPE,
      );
    }

    const fileSize = body.fileSize !== undefined ? Number(body.fileSize) : undefined;
    if (fileSize !== undefined) {
      if (Number.isNaN(fileSize) || fileSize <= 0) {
        throw new BadRequestError('fileSize must be a positive number of bytes', 'INVALID_FILE_SIZE');
      }
      if (fileSize > MAX_AVATAR_SIZE_BYTES) {
        throw new BadRequestError(
          `Avatar file size exceeds maximum limit of ${MAX_AVATAR_SIZE_BYTES / (1024 * 1024)} MB`,
          STORAGE_ERROR_CODES.FILE_TOO_LARGE,
        );
      }
    }

    req.validatedBody = {
      contentType,
      fileSize: fileSize || MAX_AVATAR_SIZE_BYTES,
      fileExtension: body.fileExtension,
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Validates request to confirm customer avatar upload completion.
 */
function validateAvatarCompletion(req, res, next) {
  try {
    const { body } = req;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestError('Request body must be a valid JSON object', 'INVALID_PAYLOAD');
    }

    checkForbiddenFields(body);

    const uploadId = body.uploadId || body.upload_id;
    if (!uploadId || !UUID_REGEX.test(uploadId)) {
      throw new BadRequestError('Valid uploadId UUID is required', 'INVALID_UPLOAD_ID');
    }

    req.validatedBody = {
      uploadId,
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  validateDocumentUploadUrl,
  validateDocumentCompletion,
  validateAvatarUploadUrl,
  validateAvatarCompletion,
};
