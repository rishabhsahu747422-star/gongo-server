'use strict';

const storageService = require('../services/storage.service');
const { sendSuccess } = require('../utils/response');

class StorageController {
  /**
   * POST /api/v1/storage/presign
   * Generate a presigned S3 PUT URL for direct frontend client upload.
   */
  async presign(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await storageService.presignUpload({
        partnerId,
        input: req.body,
      });
      sendSuccess(res, result, 201);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/storage/complete
   * Verify S3 object existence via HeadObject and link to database entities.
   */
  async complete(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await storageService.completeUpload({
        partnerId,
        input: req.body,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/storage/access-url
   * Generate short-lived presigned GET URL for viewing private S3 files.
   */
  async accessUrl(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await storageService.getAccessUrl({
        partnerId,
        input: req.body,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new StorageController();
