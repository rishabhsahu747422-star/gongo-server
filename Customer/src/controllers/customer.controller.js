'use strict';

const customerService = require('../services/customer.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * CustomerController handles HTTP requests for customer profile and documents.
 * Keeps controller thin by delegating all business logic to CustomerService.
 */
class CustomerController {
  /**
   * GET /api/v1/customers/me
   */
  async getMe(req, res, next) {
    try {
      const profile = await customerService.getProfile(req.user.id);
      return sendSuccess(res, profile, 'Customer profile retrieved', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/customers/me
   */
  async updateMe(req, res, next) {
    try {
      const updatedProfile = await customerService.updateProfile(req.user.id, req.body);
      return sendSuccess(res, updatedProfile, 'Customer profile updated successfully', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/documents
   */
  async getDocuments(req, res, next) {
    try {
      const documents = await customerService.getDocuments(req.user.id);
      return sendSuccess(res, documents, 'Customer documents retrieved', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/customers/me/documents/upload-url
   */
  async getDocumentUploadUrl(req, res, next) {
    try {
      const payload = req.validatedBody || req.body;
      const data = await customerService.getDocumentUploadUrl(req.user.id, payload);
      return sendSuccess(res, data, 'Presigned document upload URL generated', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/customers/me/documents
   */
  async completeDocumentUpload(req, res, next) {
    try {
      const payload = req.validatedBody || req.body;
      const data = await customerService.completeDocumentUpload(req.user.id, payload);
      return sendSuccess(
        res,
        data,
        'Customer document uploaded successfully and pending verification',
        HTTP_STATUS.CREATED,
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/customers/me/avatar/upload-url
   */
  async getAvatarUploadUrl(req, res, next) {
    try {
      const payload = req.validatedBody || req.body;
      const data = await customerService.getAvatarUploadUrl(req.user.id, payload);
      return sendSuccess(res, data, 'Presigned avatar upload URL generated', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/customers/me/avatar
   */
  async completeAvatarUpload(req, res, next) {
    try {
      const payload = req.validatedBody || req.body;
      const data = await customerService.completeAvatarUpload(req.user.id, payload);
      return sendSuccess(res, data, 'Customer avatar updated successfully', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new CustomerController();
