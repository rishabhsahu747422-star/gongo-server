'use strict';

const storageProvider = require('../providers/storage');
const storageUploadRepository = require('../repositories/storageUpload.repository');
const logger = require('../config/logger');

class StorageCleanupService {
  /**
   * Scans and marks expired pending uploads, cleaning up any orphan S3 objects.
   *
   * @param {number} [limit=100]
   * @returns {Promise<{ cleanedCount: number, errors: Array<object> }>}
   */
  async cleanupExpiredUploads(limit = 100) {
    const expiredUploads = await storageUploadRepository.findExpiredPendingUploads(limit);
    let cleanedCount = 0;
    const errors = [];

    await Promise.allSettled(
      expiredUploads.map(async (upload) => {
        try {
          // Attempt to clean up any partial object that might have been uploaded to storage
          await storageProvider.deleteObject({ key: upload.storage_key }).catch(() => {
            // It is expected that uncompleted uploads may not exist in S3
          });

          // Mark as EXPIRED in DB
          await storageUploadRepository.markStatus({
            id: upload.id,
            partnerId: upload.partner_id,
            status: 'EXPIRED',
          });

          cleanedCount += 1;
        } catch (err) {
          logger.error('Failed to cleanup expired upload session', {
            uploadId: upload.id,
            error: err.message,
          });
          errors.push({ uploadId: upload.id, error: err.message });
        }
      }),
    );

    return { cleanedCount, errors };
  }
}

module.exports = new StorageCleanupService();
