'use strict';

/**
 * Storage Provider.
 * Wraps Supabase Storage operations with backward compatibility aliases.
 */
const supabaseProvider = require('./supabase');

async function resolveSignedUrl(storageKey, expiresInSeconds = 86400) {
  if (!storageKey || typeof storageKey !== 'string') return null;
  if (storageKey.startsWith('http://') || storageKey.startsWith('https://') || storageKey.startsWith('data:')) {
    return storageKey;
  }
  try {
    const res = await supabaseProvider.createPresignedGetUrl({
      key: storageKey,
      expiresInSeconds,
    });
    return res?.downloadUrl || null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  resolveSignedUrl,
  createPresignedPutUrl: supabaseProvider.createPresignedPutUrl,
  createPresignedGetUrl: supabaseProvider.createPresignedGetUrl,
  headObject: supabaseProvider.headObject,
  deleteObject: supabaseProvider.deleteObject,
  getObjectHeaderBytes: supabaseProvider.getObjectHeaderBytes,
  validateMagicBytes: supabaseProvider.validateMagicBytes,
  setMockStorageClient: supabaseProvider.setMockStorageClient,
  setMockPresigner: supabaseProvider.setMockPresigner,
  resetStorageClient: supabaseProvider.resetSupabaseClient,
  // S3 backward compatibility aliases for existing unit/integration tests
  getS3Client: supabaseProvider.getSupabaseAdmin,
  setMockS3Client: supabaseProvider.setMockStorageClient,
  resetS3Client: supabaseProvider.resetSupabaseClient,
  getStorageClient: supabaseProvider.getSupabaseAdmin,
};
