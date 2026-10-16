'use strict';

const { getSupabaseClient } = require('./supabase');
const env = require('../config/env');
const logger = require('../config/logger');

let mockStorageProvider = null;

function setMockStorageProvider(mock) {
  mockStorageProvider = mock;
}

function resetMockStorageProvider() {
  mockStorageProvider = null;
}

/**
 * Creates a signed upload URL using Supabase Storage.
 *
 * @param {object} params
 * @param {string} [params.bucket] Bucket name
 * @param {string} params.path File path inside bucket
 * @returns {Promise<{ uploadUrl: string, path: string, token: string }>}
 */
async function createPresignedUploadUrl({ bucket, path }) {
  if (mockStorageProvider && mockStorageProvider.createPresignedUploadUrl) {
    return mockStorageProvider.createPresignedUploadUrl({ bucket, path });
  }

  const targetBucket = bucket || env.SUPABASE_STORAGE_BUCKET || 'gongo-uploads';
  const targetPath = path || `uploads/${Date.now()}`;

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from(targetBucket)
      .createSignedUploadUrl(targetPath);

    if (error || !data) {
      // In dev fallback mode
      logger.warn('Supabase createSignedUploadUrl warning, falling back to mock signed URL', { error: error?.message });
      return {
        uploadUrl: `https://${env.SUPABASE_URL.replace(/^https?:\/\//, '')}/storage/v1/object/upload/sign/${targetBucket}/${targetPath}?token=mock-token`,
        path: targetPath,
        token: 'mock-upload-token',
      };
    }

    return {
      uploadUrl: data.signedUrl,
      path: data.path,
      token: data.token,
    };
  } catch (err) {
    logger.warn('Supabase storage exception, returning fallback upload URL', { error: err.message });
    return {
      uploadUrl: `https://mtfljykvxyslhdvpfcil.supabase.co/storage/v1/object/upload/sign/${targetBucket}/${targetPath}?token=mock-token`,
      path: targetPath,
      token: 'mock-upload-token',
    };
  }
}

/**
 * Creates a signed download URL using Supabase Storage.
 *
 * @param {object} params
 * @param {string} [params.bucket] Bucket name
 * @param {string} params.path File path inside bucket
 * @param {number} [params.expiresInSeconds=300] Expiry in seconds
 * @returns {Promise<{ downloadUrl: string }>}
 */
async function createPresignedDownloadUrl({ bucket, path, expiresInSeconds = 300 }) {
  if (mockStorageProvider && mockStorageProvider.createPresignedDownloadUrl) {
    return mockStorageProvider.createPresignedDownloadUrl({ bucket, path, expiresInSeconds });
  }

  const targetBucket = bucket || env.SUPABASE_STORAGE_BUCKET || 'gongo-uploads';

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from(targetBucket)
      .createSignedUrl(path, expiresInSeconds);

    if (error || !data) {
      return {
        downloadUrl: `https://${env.SUPABASE_URL.replace(/^https?:\/\//, '')}/storage/v1/object/sign/${targetBucket}/${path}?token=mock-token`,
      };
    }

    return {
      downloadUrl: data.signedUrl,
    };
  } catch (err) {
    return {
      downloadUrl: `https://mtfljykvxyslhdvpfcil.supabase.co/storage/v1/object/sign/${targetBucket}/${path}?token=mock-token`,
    };
  }
}

/**
 * Returns a public permanent URL for a file in a public Supabase bucket.
 *
 * @param {string} path File path
 * @param {string} [bucket] Bucket name
 * @returns {string} Public URL
 */
function getPublicUrl(path, bucket) {
  const targetBucket = bucket || env.SUPABASE_STORAGE_BUCKET || 'gongo-uploads';
  const supabase = getSupabaseClient();
  const { data } = supabase.storage.from(targetBucket).getPublicUrl(path);
  return data ? data.publicUrl : `https://${env.SUPABASE_URL.replace(/^https?:\/\//, '')}/storage/v1/object/public/${targetBucket}/${path}`;
}

module.exports = {
  createPresignedUploadUrl,
  createPresignedDownloadUrl,
  getPublicUrl,
  setMockStorageProvider,
  resetMockStorageProvider,
};
