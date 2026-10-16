'use strict';

const crypto = require('crypto');
const s3Provider = require('./storage/s3.provider');
const { redisClient } = require('../config/redis');
const { CustomerRepository, CustomerDocumentRepository } = require('../repositories');
const {
  STORAGE_ENTITY_TYPE,
  CUSTOMER_DOCUMENT_TYPES,
  MIME_EXTENSION_MAP,
  UPLOAD_SESSION_TTL_SECONDS,
  STORAGE_ERROR_CODES,
} = require('../constants/storage');
const {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} = require('../errors');
const logger = require('../config/logger');
const env = require('../config/env');

class StorageService {
  constructor({
    customerRepo = new CustomerRepository(),
    documentRepo = new CustomerDocumentRepository(),
    redis = redisClient,
    s3 = s3Provider,
  } = {}) {
    this.customerRepository = customerRepo;
    this.documentRepository = documentRepo;
    this.redisClient = redis;
    this.s3Provider = s3;
  }

  /**
   * Helper to format Redis upload session key.
   *
   * @param {string} uploadId
   * @returns {string}
   */
  static getSessionKey(uploadId) {
    return `storage:upload:${uploadId}`;
  }

  /**
   * Helper to resolve file extension from extension or MIME type.
   *
   * @param {string} [fileExtension]
   * @param {string} contentType
   * @param {string} [defaultExt]
   * @returns {string}
   */
  static resolveExtension(fileExtension, contentType, defaultExt = '.bin') {
    const mimeExt = MIME_EXTENSION_MAP[contentType];
    if (fileExtension) {
      const ext = fileExtension.startsWith('.') ? fileExtension.toLowerCase() : `.${fileExtension.toLowerCase()}`;
      if (mimeExt) {
        if (mimeExt === '.jpg' && (ext === '.jpg' || ext === '.jpeg')) {
          return '.jpg';
        }
        if (ext === mimeExt) {
          return ext;
        }
        return mimeExt;
      }
      return ext;
    }
    return mimeExt || defaultExt;
  }

  /**
   * Generates presigned PUT URL for customer KYC document upload.
   *
   * @param {object} params
   * @param {string} params.customerId - Authenticated customer UUID
   * @param {string} params.documentType - Document type (DRIVING_LICENSE)
   * @param {string} params.contentType - File MIME type
   * @param {number} params.fileSize - Maximum allowed size in bytes
   * @param {string} [params.fileExtension] - Optional extension
   * @returns {Promise<object>} Presigned upload details
   */
  async createDocumentUploadUrl({
    customerId,
    documentType,
    contentType,
    fileSize,
    fileExtension,
    side,
  }) {
    // 1. Verify user exists and is active
    const user = await this.customerRepository.findById(customerId);
    if (!user) {
      throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
    }
    if (!user.isActive) {
      throw new ForbiddenError('Account is deactivated', 'AUTH_USER_INACTIVE');
    }

    // 2. Generate backend-owned isolated S3 key
    const fileUuid = crypto.randomUUID();
    const ext = StorageService.resolveExtension(fileExtension, contentType, '.bin');

    const docTypeFolder = documentType.toLowerCase();
    const sidePrefix = (side && (side === 'front' || side === 'back')) ? `${side.toLowerCase()}-` : '';
    const storageKey = `customers/${customerId}/documents/${docTypeFolder}/${sidePrefix}${fileUuid}${ext}`;

    // 3. Generate presigned PUT URL
    const presigned = await this.s3Provider.createPresignedPutUrl({
      key: storageKey,
      contentType,
      expiresInSeconds: UPLOAD_SESSION_TTL_SECONDS,
    });

    // 4. Save session in Redis
    const uploadId = crypto.randomUUID();
    const sessionData = {
      uploadId,
      customerId,
      entityType: STORAGE_ENTITY_TYPE.KYC_DOCUMENT,
      documentType,
      storageKey,
      side: (side && (side === 'front' || side === 'back')) ? side.toLowerCase() : null,
      contentType,
      maxSizeBytes: fileSize,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_SECONDS * 1000).toISOString(),
    };

    if (this.redisClient && typeof this.redisClient.set === 'function') {
      await this.redisClient.set(
        StorageService.getSessionKey(uploadId),
        JSON.stringify(sessionData),
        'EX',
        UPLOAD_SESSION_TTL_SECONDS,
      );
    }

    const bucket = env.SUPABASE_STORAGE_BUCKET || env.AWS_S3_BUCKET || 'gongo-uploads';
    const region = env.AWS_REGION || 'ap-south-1';
    logger.info('[KYC_BACKEND_TRACE] Generated presigned document upload URL', {
      endpoint: 'POST /api/v1/customers/me/documents/upload-url',
      customerId,
      uploadId,
      documentType,
      storageKey,
      bucket,
      region,
      uploadMethod: 'PUT',
      contentType,
      expiresInSeconds: presigned.expiresInSeconds,
    });

    return {
      uploadId,
      uploadUrl: presigned.uploadUrl,
      storageKey,
      headers: presigned.headers,
      expiresInSeconds: presigned.expiresInSeconds,
      maxSizeBytes: fileSize,
      side: sessionData.side || undefined,
    };
  }

  /**
   * Confirms customer KYC document upload or document number verification,
   * verifies S3 object & magic bytes when uploadId is present,
   * preserves front and back documents separately without overwriting,
   * and commits document record to PostgreSQL.
   *
   * @param {object} params
   * @param {string} params.customerId - Authenticated customer UUID
   * @param {string} [params.uploadId] - Upload session UUID
   * @param {string} [params.frontUploadId] - Optional front upload session UUID
   * @param {string} [params.backUploadId] - Optional back upload session UUID
   * @param {string} [params.documentType] - Document type ('AADHAAR' or 'DRIVING_LICENSE')
   * @param {string} [params.documentNumber] - Document number (e.g. 12-digit Aadhaar)
   * @param {string} [params.side] - 'front' or 'back'
   * @returns {Promise<object>} Safe customer document DTO
   */
  async completeDocumentUpload({
    customerId,
    uploadId,
    frontUploadId,
    backUploadId,
    documentType,
    documentNumber,
    side,
  }) {
    const rawDocType = String(documentType || '').trim().toUpperCase();
    const normalizedType = rawDocType === 'AADHAR' ? CUSTOMER_DOCUMENT_TYPES.AADHAAR : (rawDocType || CUSTOMER_DOCUMENT_TYPES.AADHAAR);
    const isAadhaar = normalizedType === CUSTOMER_DOCUMENT_TYPES.AADHAAR;

    // Helper to process and commit a single image upload session
    const processUploadSession = async (uId, sideHint) => {
      const sessionKey = StorageService.getSessionKey(uId);
      let sessionRaw = null;
      if (this.redisClient && typeof this.redisClient.get === 'function') {
        sessionRaw = await this.redisClient.get(sessionKey);
      }

      if (!sessionRaw) {
        throw new BadRequestError(
          'Upload session not found or has expired. Please request a new upload URL.',
          STORAGE_ERROR_CODES.UPLOAD_SESSION_EXPIRED,
        );
      }

      const session = JSON.parse(sessionRaw);

      if (session.customerId !== customerId) {
        throw new ForbiddenError(
          'You are not authorized to complete this upload session.',
          STORAGE_ERROR_CODES.UNAUTHORIZED_UPLOAD_ACCESS,
        );
      }

      if (session.entityType !== STORAGE_ENTITY_TYPE.KYC_DOCUMENT) {
        throw new BadRequestError(
          'Upload session type mismatch.',
          STORAGE_ERROR_CODES.INVALID_DOCUMENT_TYPE,
        );
      }

      // Verify S3 binary existence
      let headData;
      try {
        headData = await this.s3Provider.headObject({ key: session.storageKey });
      } catch (err) {
        if (err.notFound || err.code === 'S3_OBJECT_NOT_FOUND') {
          throw new BadRequestError(
            'File was not uploaded to storage. Please complete the direct upload to S3 before confirming.',
            STORAGE_ERROR_CODES.S3_OBJECT_MISSING,
          );
        }
        throw err;
      }

      // Verify size limits
      if (session.maxSizeBytes && headData.contentLength > Number(session.maxSizeBytes)) {
        await this.s3Provider.deleteObject({ key: session.storageKey }).catch((delErr) => {
          logger.error('Failed to remove oversized S3 document', { key: session.storageKey, error: delErr.message });
        });
        throw new BadRequestError(
          `Uploaded file size (${headData.contentLength} bytes) exceeds maximum permitted size of ${session.maxSizeBytes} bytes`,
          STORAGE_ERROR_CODES.FILE_TOO_LARGE,
        );
      }

      // Binary magic-byte validation
      let headerBytes;
      try {
        headerBytes = await this.s3Provider.getObjectHeaderBytes({
          key: session.storageKey,
          maxBytes: 16,
        });
      } catch (err) {
        logger.error('Failed to read document header bytes from S3', { key: session.storageKey, error: err.message });
        throw new BadRequestError('Could not verify uploaded document header');
      }

      const isMagicValid = this.s3Provider.validateMagicBytes(headerBytes, session.contentType);
      if (!isMagicValid) {
        await this.s3Provider.deleteObject({ key: session.storageKey }).catch((delErr) => {
          logger.error('Failed to remove invalid signature S3 object', { key: session.storageKey, error: delErr.message });
        });
        throw new BadRequestError(
          'Uploaded file binary signature does not match declared content type.',
          STORAGE_ERROR_CODES.INVALID_FILE_SIGNATURE,
        );
      }

      const targetSide = session.side || sideHint || (session.storageKey.includes('/front-') ? 'front' : session.storageKey.includes('/back-') ? 'back' : null);
      const metadata = {
        contentType: session.contentType,
        sizeBytes: headData.contentLength,
        completedAt: new Date().toISOString(),
        side: targetSide,
      };

      // Retrieve existing documents for customer and documentType
      let existingDocs = [];
      if (typeof this.documentRepository.findByUserAndType === 'function') {
        existingDocs = await this.documentRepository.findByUserAndType(
          customerId,
          session.documentType,
        );
      } else if (typeof this.documentRepository.findLatestByUserAndType === 'function') {
        const latest = await this.documentRepository.findLatestByUserAndType(
          customerId,
          session.documentType,
        );
        if (latest) existingDocs = [latest];
      }

      // Match specifically by side if targetSide is present
      const matchedDoc = targetSide
        ? existingDocs.find((d) => d.side === targetSide || (d.fileName && d.fileName.includes(targetSide)))
        : (existingDocs.length > 0 ? existingDocs[0] : null);

      let saved;
      if (matchedDoc && matchedDoc.status === 'PENDING') {
        // Clean up previous unverified S3 object only if different
        if (matchedDoc.storageKey && matchedDoc.storageKey !== session.storageKey) {
          await this.s3Provider.deleteObject({ key: matchedDoc.storageKey }).catch((delErr) => {
            logger.warn('Failed to delete replaced unverified document S3 object', {
              oldKey: matchedDoc.storageKey,
              error: delErr.message,
            });
          });
        }
        saved = await this.documentRepository.updateDocument(matchedDoc.id, {
          storageKey: session.storageKey,
          status: 'PENDING',
          metadata,
        });
      } else {
        const docLower = session.documentType.toLowerCase();
        const fileName = targetSide ? `${docLower}_${targetSide}.jpg` : `${docLower}.jpg`;
        saved = await this.documentRepository.create({
          userId: customerId,
          customerId,
          documentType: session.documentType,
          status: 'PENDING',
          storageKey: session.storageKey,
          fileName,
          side: targetSide,
          metadata,
        });
      }

      // Cleanup Redis session
      if (this.redisClient && typeof this.redisClient.del === 'function') {
        await this.redisClient.del(sessionKey);
      }

      logger.info('[KYC_BACKEND_TRACE] Customer KYC document uploaded successfully', {
        endpoint: 'POST /api/v1/customers/me/documents',
        customerId,
        documentId: saved.id,
        documentType: session.documentType,
        side: targetSide,
        storageKey: session.storageKey,
        status: saved.status,
      });

      return saved;
    };

    let lastSavedDoc = null;
    if (frontUploadId) {
      lastSavedDoc = await processUploadSession(frontUploadId, 'front');
    }
    if (backUploadId) {
      lastSavedDoc = await processUploadSession(backUploadId, 'back');
    }
    if (uploadId) {
      lastSavedDoc = await processUploadSession(uploadId, side || null);
    }

    // PATH: Document number verification (Aadhaar or Driving License)
    if (documentNumber) {
      const cleanNum = String(documentNumber).trim().replace(/\s+/g, '');
      if (isAadhaar) {
        if (!/^\d{12}$/.test(cleanNum) || /^(\d)\1{11}$/.test(cleanNum)) {
          throw new BadRequestError(
            'Invalid Aadhaar number. Must be exactly 12 numeric digits.',
            'INVALID_AADHAAR_NUMBER',
          );
        }
      }

      let existingDocs = [];
      if (typeof this.documentRepository.findByUserAndType === 'function') {
        existingDocs = await this.documentRepository.findByUserAndType(
          customerId,
          normalizedType,
        );
      } else if (typeof this.documentRepository.findLatestByUserAndType === 'function') {
        const latest = await this.documentRepository.findLatestByUserAndType(
          customerId,
          normalizedType,
        );
        if (latest) existingDocs = [latest];
      }

      if (!existingDocs || existingDocs.length === 0) {
        throw new BadRequestError(
          'Both front and back document photos must be uploaded before completing verification.',
          'DOCUMENTS_REQUIRED',
        );
      }

      const targetStatus = isAadhaar ? 'VERIFIED' : 'PENDING';
      const verifiedAt = isAadhaar ? new Date() : null;

      if (typeof this.documentRepository.updateAllByUserAndType === 'function') {
        await this.documentRepository.updateAllByUserAndType(customerId, normalizedType, {
          status: targetStatus,
          documentNumber: cleanNum,
          verifiedAt,
        });
      } else {
        for (const doc of existingDocs) {
          await this.documentRepository.updateDocument(doc.id, {
            status: targetStatus,
            documentNumber: cleanNum,
            verifiedAt,
          });
        }
      }

      let updatedDocs = [];
      if (typeof this.documentRepository.findByUserAndType === 'function') {
        updatedDocs = await this.documentRepository.findByUserAndType(
          customerId,
          normalizedType,
        );
      } else if (typeof this.documentRepository.findLatestByUserAndType === 'function') {
        const latest = await this.documentRepository.findLatestByUserAndType(
          customerId,
          normalizedType,
        );
        if (latest) updatedDocs = [latest];
      }
      const primaryDoc = updatedDocs[0] || lastSavedDoc || existingDocs[0];

      const last4 = cleanNum.slice(-4);
      logger.info('[KYC_BACKEND_TRACE] Customer document verified successfully', {
        endpoint: 'POST /api/v1/customers/me/documents',
        customerId,
        documentType: normalizedType,
        maskedNumber: `XXXX XXXX ${last4}`,
        status: targetStatus,
      });

      return CustomerDocumentRepository.toSafeDto(primaryDoc);
    }

    if (lastSavedDoc) {
      return CustomerDocumentRepository.toSafeDto(lastSavedDoc);
    }

    throw new BadRequestError('Upload session not found or documentNumber missing.', STORAGE_ERROR_CODES.UPLOAD_NOT_FOUND);
  }

  /**
   * Generates presigned PUT URL for customer profile avatar upload.
   *
   * @param {object} params
   * @param {string} params.customerId - Authenticated customer UUID
   * @param {string} params.contentType - Image MIME type
   * @param {number} params.fileSize - Maximum allowed size in bytes
   * @param {string} [params.fileExtension] - Optional extension
   * @returns {Promise<object>} Presigned upload details
   */
  async createAvatarUploadUrl({
    customerId,
    contentType,
    fileSize,
    fileExtension,
  }) {
    const user = await this.customerRepository.findById(customerId);
    if (!user) {
      throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
    }
    if (!user.isActive) {
      throw new ForbiddenError('Account is deactivated', 'AUTH_USER_INACTIVE');
    }

    const ext = StorageService.resolveExtension(fileExtension, contentType, '.jpg');

    const storageKey = `customers/${customerId}/photo/profile${ext}`;

    const presigned = await this.s3Provider.createPresignedPutUrl({
      key: storageKey,
      contentType,
      expiresInSeconds: UPLOAD_SESSION_TTL_SECONDS,
    });

    const uploadId = crypto.randomUUID();
    const sessionData = {
      uploadId,
      customerId,
      entityType: STORAGE_ENTITY_TYPE.AVATAR,
      storageKey,
      contentType,
      maxSizeBytes: fileSize,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_SECONDS * 1000).toISOString(),
    };

    if (this.redisClient && typeof this.redisClient.set === 'function') {
      await this.redisClient.set(
        StorageService.getSessionKey(uploadId),
        JSON.stringify(sessionData),
        'EX',
        UPLOAD_SESSION_TTL_SECONDS,
      );
    }

    logger.info('Generated presigned avatar upload URL', { customerId, uploadId });

    return {
      uploadId,
      uploadUrl: presigned.uploadUrl,
      storageKey,
      headers: presigned.headers,
      expiresInSeconds: presigned.expiresInSeconds,
      maxSizeBytes: fileSize,
    };
  }

  /**
   * Confirms customer avatar upload, verifies S3 binary, cleans up old avatar,
   * and updates user profile in database.
   *
   * @param {object} params
   * @param {string} params.customerId - Authenticated customer UUID
   * @param {string} params.uploadId - Upload session UUID
   * @returns {Promise<object>} Updated customer profile representation
   */
  async completeAvatarUpload({ customerId, uploadId }) {
    // 1. Retrieve upload session from Redis
    const sessionKey = StorageService.getSessionKey(uploadId);
    let sessionRaw = null;
    if (this.redisClient && typeof this.redisClient.get === 'function') {
      sessionRaw = await this.redisClient.get(sessionKey);
    }

    if (!sessionRaw) {
      throw new BadRequestError(
        'Upload session not found or has expired. Please request a new upload URL.',
        STORAGE_ERROR_CODES.UPLOAD_SESSION_EXPIRED,
      );
    }

    const session = JSON.parse(sessionRaw);

    // 2. Enforce BOLA / IDOR protection
    if (session.customerId !== customerId) {
      throw new ForbiddenError(
        'You are not authorized to complete this upload session.',
        STORAGE_ERROR_CODES.UNAUTHORIZED_UPLOAD_ACCESS,
      );
    }

    if (session.entityType !== STORAGE_ENTITY_TYPE.AVATAR) {
      throw new BadRequestError('Upload session type mismatch.');
    }

    // 3. Verify S3 binary existence
    let headData;
    try {
      headData = await this.s3Provider.headObject({ key: session.storageKey });
    } catch (err) {
      if (err.notFound || err.code === 'S3_OBJECT_NOT_FOUND') {
        throw new BadRequestError(
          'File was not uploaded to storage. Please complete the direct upload to S3 before confirming.',
          STORAGE_ERROR_CODES.S3_OBJECT_MISSING,
        );
      }
      throw err;
    }

    // 4. Verify size limits
    if (session.maxSizeBytes && headData.contentLength > Number(session.maxSizeBytes)) {
      await this.s3Provider.deleteObject({ key: session.storageKey }).catch((delErr) => {
        logger.error('Failed to remove oversized avatar', { key: session.storageKey, error: delErr.message });
      });
      throw new BadRequestError(
        `Uploaded file size (${headData.contentLength} bytes) exceeds maximum permitted size of ${session.maxSizeBytes} bytes`,
        STORAGE_ERROR_CODES.FILE_TOO_LARGE,
      );
    }

    // 5. Binary magic-byte validation
    let headerBytes;
    try {
      headerBytes = await this.s3Provider.getObjectHeaderBytes({
        key: session.storageKey,
        maxBytes: 16,
      });
    } catch (err) {
      logger.error('Failed to read avatar header bytes from S3', { key: session.storageKey, error: err.message });
      throw new BadRequestError('Could not verify uploaded avatar image header');
    }

    const isMagicValid = this.s3Provider.validateMagicBytes(headerBytes, session.contentType);
    if (!isMagicValid) {
      await this.s3Provider.deleteObject({ key: session.storageKey }).catch((delErr) => {
        logger.error('Failed to remove invalid signature avatar S3 object', { key: session.storageKey, error: delErr.message });
      });
      throw new BadRequestError(
        'Uploaded file binary signature does not match declared content type.',
        STORAGE_ERROR_CODES.INVALID_FILE_SIGNATURE,
      );
    }

    // 6. Fetch user to check existing avatar
    const currentUser = await this.customerRepository.findById(customerId);
    const oldAvatarKey = currentUser ? currentUser.avatarStorageKey : null;

    // 7. Update database reference
    const updatedUser = await this.customerRepository.updateAvatarStorageKey(
      customerId,
      session.storageKey,
    );

    // 8. Safely cleanup old S3 avatar object if different
    if (oldAvatarKey && oldAvatarKey !== session.storageKey) {
      this.s3Provider.deleteObject({ key: oldAvatarKey }).catch((delErr) => {
        logger.warn('Failed to delete previous avatar S3 object', {
          oldKey: oldAvatarKey,
          error: delErr.message,
        });
      });
    }

    // 9. Cleanup Redis session
    if (this.redisClient && typeof this.redisClient.del === 'function') {
      await this.redisClient.del(sessionKey);
    }

    logger.info('Customer avatar updated successfully', { customerId });

    // 10. Generate presigned download URL for private avatar
    let avatarUrl = null;
    try {
      const presignedGet = await this.s3Provider.createPresignedGetUrl({
        key: session.storageKey,
        expiresInSeconds: 3600,
      });
      avatarUrl = presignedGet.downloadUrl;
      if (avatarUrl && updatedUser?.updatedAt) {
        avatarUrl += (avatarUrl.includes('?') ? '&' : '?') + `v=${new Date(updatedUser.updatedAt).getTime()}`;
      }
    } catch (_getErr) {
      avatarUrl = null;
    }

    const dlDoc = await this.documentRepository.findLatestByUserAndType(
      customerId,
      CUSTOMER_DOCUMENT_TYPES.DRIVING_LICENSE,
    );
    const drivingLicenseStatus = dlDoc ? dlDoc.status : 'NOT_SUBMITTED';
    const isProfileComplete = Boolean(updatedUser.name && updatedUser.email && updatedUser.phone);

    return {
      id: updatedUser.id,
      role: updatedUser.role,
      name: updatedUser.name,
      countryCode: updatedUser.countryCode,
      phone: updatedUser.phone,
      email: updatedUser.email,
      avatarUrl,
      profileImage: avatarUrl,
      profilePhoto: avatarUrl,
      verificationStatus: {
        isProfileComplete,
        drivingLicenseStatus,
      },
      createdAt: updatedUser.createdAt,
      updatedAt: updatedUser.updatedAt,
    };
  }
}

module.exports = new StorageService();
