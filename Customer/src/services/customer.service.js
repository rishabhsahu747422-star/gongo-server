'use strict';

const { CustomerRepository, CustomerDocumentRepository } = require('../repositories');
const { NotFoundError, ForbiddenError, ConflictError } = require('../errors');
const { logger } = require('../config');
const s3Provider = require('./storage/s3.provider');
const storageService = require('./storage.service');

/**
 * CustomerService manages business logic for customer profile operations
 * and document status inquiries.
 */
class CustomerService {
  constructor({
    customerRepo = new CustomerRepository(),
    documentRepo = new CustomerDocumentRepository(),
    storage = storageService,
    s3 = s3Provider,
  } = {}) {
    this.customerRepository = customerRepo;
    this.documentRepository = documentRepo;
    this.storageService = storage;
    this.s3Provider = s3;
  }

  /**
   * Helper to format a safe customer profile response.
   *
   * @param {object} user - Domain user entity
   * @param {object|null} drivingLicenseDoc - Driving license document entity if exists
   * @param {string|null} [avatarUrl=null] - Presigned avatar URL
   * @returns {object} Safe client-facing profile DTO
   */
  static formatProfileDto(user, drivingLicenseDoc = null, avatarUrl = null) {
    const drivingLicenseStatus = drivingLicenseDoc ? drivingLicenseDoc.status : 'NOT_SUBMITTED';
    const isProfileComplete = Boolean(user.name && user.email && user.phone);

    return {
      id: user.id,
      customerReference: user.customerReference || user.customer_reference || null,
      role: user.role,
      name: user.name,
      countryCode: user.countryCode,
      phone: user.phone,
      email: user.email,
      avatarUrl: avatarUrl || null,
      profileImage: avatarUrl || null,
      profilePhoto: avatarUrl || null,
      verificationStatus: {
        isProfileComplete,
        drivingLicenseStatus,
      },
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * Retrieves the authenticated customer's profile and document verification status.
   *
   * @param {string} userId - User UUID derived from authenticated token
   * @returns {Promise<object>} Customer profile DTO
   */
  async getProfile(userId) {
    const user = await this.customerRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('Customer profile not found', 'CUSTOMER_NOT_FOUND');
    }

    if (!user.isActive) {
      throw new ForbiddenError(
        'Your account has been deactivated. Please contact support.',
        'AUTH_USER_INACTIVE',
      );
    }

    let avatarUrl = null;
    if (user.avatarStorageKey) {
      try {
        const presigned = await this.s3Provider.createPresignedGetUrl({
          key: user.avatarStorageKey,
        });
        avatarUrl = presigned.downloadUrl;
        if (avatarUrl && user.updatedAt) {
          avatarUrl += (avatarUrl.includes('?') ? '&' : '?') + `v=${new Date(user.updatedAt).getTime()}`;
        }
      } catch (_err) {
        avatarUrl = null;
      }
    }

    const dlDoc = await this.documentRepository.findLatestByUserAndType(userId, 'DRIVING_LICENSE');
    return CustomerService.formatProfileDto(user, dlDoc, avatarUrl);
  }

  /**
   * Updates allowlisted fields of the authenticated customer's profile.
   *
   * @param {string} userId - User UUID derived from authenticated token
   * @param {object} updates - Validated update fields ({ name, email })
   * @returns {Promise<object>} Updated customer profile DTO
   */
  async updateProfile(userId, { name, email }) {
    // 1. Verify user exists and is active
    const user = await this.customerRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('Customer profile not found', 'CUSTOMER_NOT_FOUND');
    }

    if (!user.isActive) {
      throw new ForbiddenError(
        'Your account has been deactivated. Please contact support.',
        'AUTH_USER_INACTIVE',
      );
    }

    // 2. Prepare allowlisted updates
    const safeUpdates = {};
    if (name !== undefined) {
      safeUpdates.name = name.trim();
    }
    if (email !== undefined) {
      safeUpdates.email = email.trim().toLowerCase();
    }

    // 3. Execute update with conflict handling
    let updatedUser;
    try {
      updatedUser = await this.customerRepository.updateProfile(userId, safeUpdates);
    } catch (err) {
      // Map unique email conflict to safe client error
      if (err.code === 'DUPLICATE_RESOURCE' || err instanceof ConflictError) {
        throw new ConflictError(
          'The provided email address is already associated with an account',
          'EMAIL_ALREADY_IN_USE',
        );
      }
      throw err;
    }

    logger.info('Customer profile updated successfully', { userId });

    let avatarUrl = null;
    if (updatedUser.avatarStorageKey) {
      try {
        const presigned = await this.s3Provider.createPresignedGetUrl({
          key: updatedUser.avatarStorageKey,
        });
        avatarUrl = presigned.downloadUrl;
        if (avatarUrl && updatedUser.updatedAt) {
          avatarUrl += (avatarUrl.includes('?') ? '&' : '?') + `v=${new Date(updatedUser.updatedAt).getTime()}`;
        }
      } catch (_err) {
        avatarUrl = null;
      }
    }

    // 4. Retrieve document status and return safe profile DTO
    const dlDoc = await this.documentRepository.findLatestByUserAndType(userId, 'DRIVING_LICENSE');
    return CustomerService.formatProfileDto(updatedUser, dlDoc, avatarUrl);
  }

  /**
   * Retrieves all document records belonging to the authenticated customer.
   * Returns safe metadata only — never returns storage credentials or raw contents.
   *
   * @param {string} userId - User UUID derived from authenticated token
   * @returns {Promise<Array<object>>} List of safe document DTOs
   */
  async getDocuments(userId) {
    const user = await this.customerRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('Customer profile not found', 'CUSTOMER_NOT_FOUND');
    }

    if (!user.isActive) {
      throw new ForbiddenError(
        'Your account has been deactivated. Please contact support.',
        'AUTH_USER_INACTIVE',
      );
    }

    const documents = await this.documentRepository.findByUserId(userId);
    return documents.map(CustomerDocumentRepository.toSafeDto);
  }

  /**
   * Generates a presigned PUT URL for customer KYC document upload.
   */
  async getDocumentUploadUrl(userId, input) {
    return this.storageService.createDocumentUploadUrl({
      customerId: userId,
      documentType: input.documentType,
      contentType: input.contentType,
      fileSize: input.fileSize,
      fileExtension: input.fileExtension,
      side: input.side,
    });
  }

  /**
   * Confirms customer KYC document upload.
   */
  async completeDocumentUpload(userId, input) {
    return this.storageService.completeDocumentUpload({
      customerId: userId,
      uploadId: input.uploadId,
      frontUploadId: input.frontUploadId,
      backUploadId: input.backUploadId,
      documentType: input.documentType,
      documentNumber: input.documentNumber,
      side: input.side,
    });
  }

  /**
   * Generates a presigned PUT URL for customer profile avatar upload.
   */
  async getAvatarUploadUrl(userId, input) {
    return this.storageService.createAvatarUploadUrl({
      customerId: userId,
      contentType: input.contentType,
      fileSize: input.fileSize,
      fileExtension: input.fileExtension,
    });
  }

  /**
   * Confirms customer profile avatar upload.
   */
  async completeAvatarUpload(userId, input) {
    return this.storageService.completeAvatarUpload({
      customerId: userId,
      uploadId: input.uploadId,
    });
  }
}

module.exports = new CustomerService();
