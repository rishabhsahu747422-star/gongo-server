'use strict';

/**
 * Storage and Upload Constants for Customer Backend.
 */
const STORAGE_ENTITY_TYPE = Object.freeze({
  KYC_DOCUMENT: 'KYC_DOCUMENT',
  AVATAR: 'AVATAR',
});

const CUSTOMER_DOCUMENT_TYPES = Object.freeze({
  AADHAAR: 'AADHAAR',
  DRIVING_LICENSE: 'DRIVING_LICENSE',
});

const ALLOWED_DOCUMENT_MIMES = Object.freeze([
  'image/jpeg',
  'image/png',
  'application/pdf',
]);

const ALLOWED_AVATAR_MIMES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const MIME_EXTENSION_MAP = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
});

// Maximum file size limits
const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// Presigned upload session expiry
const UPLOAD_SESSION_TTL_SECONDS = 900; // 15 minutes

const STORAGE_ERROR_CODES = Object.freeze({
  INVALID_DOCUMENT_TYPE: 'INVALID_DOCUMENT_TYPE',
  UNSUPPORTED_MIME_TYPE: 'UNSUPPORTED_MIME_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UPLOAD_SESSION_EXPIRED: 'UPLOAD_SESSION_EXPIRED',
  UPLOAD_NOT_FOUND: 'UPLOAD_NOT_FOUND',
  S3_OBJECT_MISSING: 'S3_OBJECT_MISSING',
  INVALID_FILE_SIGNATURE: 'INVALID_FILE_SIGNATURE',
  UNAUTHORIZED_UPLOAD_ACCESS: 'UNAUTHORIZED_UPLOAD_ACCESS',
});

module.exports = {
  STORAGE_ENTITY_TYPE,
  CUSTOMER_DOCUMENT_TYPES,
  ALLOWED_DOCUMENT_MIMES,
  ALLOWED_AVATAR_MIMES,
  MIME_EXTENSION_MAP,
  MAX_DOCUMENT_SIZE_BYTES,
  MAX_AVATAR_SIZE_BYTES,
  UPLOAD_SESSION_TTL_SECONDS,
  STORAGE_ERROR_CODES,
};
