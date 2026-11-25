'use strict';

/**
 * GONGO Centralized Storage Service
 *
 * Implements strict separation of:
 * - Bucket A: Public Assets ('gongo-uploads' / 'gongouploads')
 *   - Vehicle listing and gallery images
 *   - Vehicle thumbnails and display images
 *   - Public shop images
 *   - Marketing & hero banners
 * - Bucket B: Private Documents ('gongo-partner-documents')
 *   - Partner KYC documents (Aadhaar, PAN, GST, Shop Establishment)
 *   - Partner identity and address proof
 *   - Vehicle RC documents
 *   - Vehicle insurance documents
 *   - PUC certificates
 *   - Fitness certificates
 *   - Other sensitive verification documents
 * - Bucket C: Private Customer Data ('gongo-customers')
 *   - Customer profile photos, Aadhaar XML, driving licence
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');

// Canonical bucket identifiers
const PUBLIC_BUCKET_NAME = process.env.PUBLIC_STORAGE_BUCKET
  || process.env.SUPABASE_PUBLIC_STORAGE_BUCKET
  || 'gongo-uploads';

const PRIVATE_PARTNER_BUCKET_NAME = process.env.PRIVATE_STORAGE_BUCKET
  || process.env.SUPABASE_PRIVATE_STORAGE_BUCKET
  || 'gongo-partner-documents';

const PRIVATE_CUSTOMER_BUCKET_NAME = process.env.CUSTOMER_STORAGE_BUCKET
  || 'gongo-customers';

// Allowed MIME types
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_DOC_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DOC_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 900; // 15 minutes

let supabaseAdminClient = null;

function getSupabaseAdmin() {
  if (supabaseAdminClient) return supabaseAdminClient;
  const url = process.env.SUPABASE_URL || 'https://mtfljykvxyslhdvpfcil.supabase.co';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'mock-service-role-key';
  supabaseAdminClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseAdminClient;
}

function setMockSupabaseClient(mock) {
  supabaseAdminClient = mock;
}

function resetMockSupabaseClient() {
  supabaseAdminClient = null;
}

/**
 * Checks if a storage path represents a private document.
 *
 * @param {string} storagePath
 * @returns {boolean}
 */
function isPrivateDocumentPath(storagePath) {
  if (!storagePath || typeof storagePath !== 'string') return false;
  const normalized = storagePath.toLowerCase();
  if (normalized.includes('/kyc/')) return true;
  if (normalized.includes('/documents/')) return true;
  if (normalized.includes('customers/') || normalized.includes('/aadhaar/')) return true;
  if (/\/(rc|insurance|puc|fitness|pan|gst|shop_establishment)\//.test(normalized)) return true;
  return false;
}

/**
 * Resolves the correct bucket for a given storage path or entity.
 *
 * @param {string} storagePath
 * @param {string} [entityType]
 * @returns {string} Bucket name
 */
function resolveBucketForPath(storagePath, entityType) {
  if (entityType === 'KYC_DOCUMENT' || entityType === 'VEHICLE_DOCUMENT' || entityType === 'PARTNER_DOCUMENT') {
    return PRIVATE_PARTNER_BUCKET_NAME;
  }
  if (entityType === 'CUSTOMER_DOCUMENT' || entityType === 'CUSTOMER_KYC') {
    return PRIVATE_CUSTOMER_BUCKET_NAME;
  }
  if (entityType === 'VEHICLE_IMAGE' || entityType === 'PROFILE_IMAGE' || entityType === 'BANNER' || entityType === 'HERO_BANNER') {
    return PUBLIC_BUCKET_NAME;
  }

  if (!storagePath || typeof storagePath !== 'string') return PUBLIC_BUCKET_NAME;

  if (storagePath.startsWith('customers/')) {
    return PRIVATE_CUSTOMER_BUCKET_NAME;
  }
  if (isPrivateDocumentPath(storagePath)) {
    return PRIVATE_PARTNER_BUCKET_NAME;
  }
  return PUBLIC_BUCKET_NAME;
}

/**
 * Canonicalizes bucket name (handling 'gongouploads' alias -> 'gongo-uploads').
 *
 * @param {string} bucket
 * @returns {string}
 */
function canonicalizeBucketName(bucket) {
  if (!bucket) return PUBLIC_BUCKET_NAME;
  if (bucket.toLowerCase() === 'gongouploads' || bucket.toLowerCase() === 'gongo-uploads') {
    return PUBLIC_BUCKET_NAME;
  }
  if (bucket.toLowerCase() === 'gongo-partner-documents' || bucket.toLowerCase() === 'gongopartnerdocuments') {
    return PRIVATE_PARTNER_BUCKET_NAME;
  }
  if (bucket.toLowerCase() === 'gongo-customers' || bucket.toLowerCase() === 'gongocustomers') {
    return PRIVATE_CUSTOMER_BUCKET_NAME;
  }
  return bucket;
}

/**
 * Uploads a public image to the public bucket ('gongo-uploads').
 *
 * @param {object} params
 * @param {Buffer|Blob|string} params.file - File binary data
 * @param {string} params.path - Target storage path
 * @param {string} [params.contentType='image/jpeg'] - MIME type
 * @returns {Promise<{ storageKey: string, publicUrl: string, bucket: string }>}
 */
async function uploadPublicImage({ file, path: storagePath, contentType = 'image/jpeg' }) {
  if (isPrivateDocumentPath(storagePath)) {
    throw new Error('SECURITY VIOLATION: Refusing to upload sensitive document to public bucket');
  }

  if (contentType && !ALLOWED_IMAGE_MIMES.has(contentType.toLowerCase())) {
    throw new Error(`Invalid file type for public image. Allowed: ${Array.from(ALLOWED_IMAGE_MIMES).join(', ')}`);
  }

  const supabase = getSupabaseAdmin();
  const bucket = PUBLIC_BUCKET_NAME;

  const { data, error } = await supabase.storage.from(bucket).upload(storagePath, file, {
    contentType,
    upsert: true,
  });

  if (error) {
    throw new Error(`Failed to upload public image: ${error.message}`);
  }

  const publicUrl = getPublicImageUrl(storagePath, bucket);

  return {
    storageKey: storagePath,
    publicUrl,
    bucket,
  };
}

/**
 * Deletes a public image from the public bucket.
 *
 * @param {object} params
 * @param {string} params.path - Storage key
 * @returns {Promise<{ success: boolean }>}
 */
async function deletePublicImage({ path: storagePath }) {
  const supabase = getSupabaseAdmin();
  const bucket = PUBLIC_BUCKET_NAME;

  const { error } = await supabase.storage.from(bucket).remove([storagePath]);
  if (error) {
    throw new Error(`Failed to delete public image: ${error.message}`);
  }
  return { success: true };
}

/**
 * Returns the permanent public URL for a file in the public bucket.
 * Throws if the path is sensitive.
 *
 * @param {string} storagePath - Relative path in public bucket
 * @param {string} [bucket] - Bucket name
 * @returns {string} Public URL
 */
function getPublicImageUrl(storagePath, bucket = PUBLIC_BUCKET_NAME) {
  if (isPrivateDocumentPath(storagePath)) {
    throw new Error('SECURITY VIOLATION: Cannot generate public URL for private document');
  }

  const canonicalBucket = canonicalizeBucketName(bucket);
  if (canonicalBucket !== PUBLIC_BUCKET_NAME && canonicalBucket !== 'gongouploads' && canonicalBucket !== 'gongo-uploads') {
    throw new Error('SECURITY VIOLATION: Cannot generate public URL for non-public bucket');
  }

  const supabase = getSupabaseAdmin();
  const { data } = supabase.storage.from(canonicalBucket).getPublicUrl(storagePath);
  if (data?.publicUrl) return data.publicUrl;

  const baseUrl = (process.env.SUPABASE_URL || 'https://mtfljykvxyslhdvpfcil.supabase.co').replace(/\/+$/, '');
  return `${baseUrl}/storage/v1/object/public/${canonicalBucket}/${storagePath.replace(/^\/+/, '')}`;
}

/**
 * Uploads a private document to the private bucket ('gongo-partner-documents').
 *
 * @param {object} params
 * @param {Buffer|Blob|string} params.file - File binary
 * @param {string} params.path - Target storage path
 * @param {string} [params.contentType='application/pdf'] - MIME type
 * @param {string} [params.documentType] - Document classification
 * @returns {Promise<{ storageKey: string, bucket: string }>}
 */
async function uploadPrivateDocument({ file, path: storagePath, contentType = 'application/pdf', documentType }) {
  if (contentType && !ALLOWED_DOC_MIMES.has(contentType.toLowerCase())) {
    throw new Error(`Invalid file type for private document. Allowed: ${Array.from(ALLOWED_DOC_MIMES).join(', ')}`);
  }

  const supabase = getSupabaseAdmin();
  const bucket = PRIVATE_PARTNER_BUCKET_NAME;

  const { data, error } = await supabase.storage.from(bucket).upload(storagePath, file, {
    contentType,
    upsert: true,
  });

  if (error) {
    throw new Error(`Failed to upload private document: ${error.message}`);
  }

  return {
    storageKey: storagePath,
    bucket,
  };
}

/**
 * Generates an authorized, short-lived presigned GET URL for viewing private documents.
 * Never generates or falls back to public URLs.
 *
 * @param {object} params
 * @param {string} params.path - Storage key
 * @param {number} [params.expiresInSeconds=900] - URL validity in seconds
 * @param {string} [params.bucket] - Target bucket (defaults to private bucket)
 * @returns {Promise<{ downloadUrl: string, expiresInSeconds: number, storageKey: string, bucket: string }>}
 */
async function getPrivateDocumentAccessUrl({
  path: storagePath,
  expiresInSeconds = DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  bucket,
}) {
  const targetBucket = bucket ? canonicalizeBucketName(bucket) : resolveBucketForPath(storagePath);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage
    .from(targetBucket)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    if (process.env.NODE_ENV !== 'production') {
      const baseUrl = (process.env.SUPABASE_URL || 'https://mtfljykvxyslhdvpfcil.supabase.co').replace(/\/+$/, '');
      return {
        downloadUrl: `${baseUrl}/storage/v1/object/sign/${targetBucket}/${storagePath}?token=mock-signed-token`,
        expiresInSeconds,
        storageKey: storagePath,
        bucket: targetBucket,
      };
    }
    throw new Error(`Failed to generate signed document access URL: ${error?.message || 'Storage error'}`);
  }

  let downloadUrl = data.signedUrl;
  if (!downloadUrl.startsWith('http')) {
    const baseUrl = (process.env.SUPABASE_URL || 'https://mtfljykvxyslhdvpfcil.supabase.co').replace(/\/+$/, '');
    downloadUrl = `${baseUrl}/storage/v1${downloadUrl.startsWith('/') ? '' : '/'}${downloadUrl}`;
  }

  return {
    downloadUrl,
    expiresInSeconds,
    storageKey: storagePath,
    bucket: targetBucket,
  };
}

/**
 * Deletes a private document from the private bucket.
 *
 * @param {object} params
 * @param {string} params.path - Storage key
 * @param {string} [params.bucket] - Target bucket
 * @returns {Promise<{ success: boolean }>}
 */
async function deletePrivateDocument({ path: storagePath, bucket }) {
  const targetBucket = bucket ? canonicalizeBucketName(bucket) : resolveBucketForPath(storagePath);
  const supabase = getSupabaseAdmin();

  const { error } = await supabase.storage.from(targetBucket).remove([storagePath]);
  if (error) {
    throw new Error(`Failed to delete private document: ${error.message}`);
  }
  return { success: true };
}

module.exports = {
  PUBLIC_BUCKET_NAME,
  PRIVATE_PARTNER_BUCKET_NAME,
  PRIVATE_CUSTOMER_BUCKET_NAME,
  ALLOWED_IMAGE_MIMES,
  ALLOWED_DOC_MIMES,
  MAX_IMAGE_SIZE_BYTES,
  MAX_DOC_SIZE_BYTES,
  DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  isPrivateDocumentPath,
  resolveBucketForPath,
  canonicalizeBucketName,
  uploadPublicImage,
  deletePublicImage,
  getPublicImageUrl,
  uploadPrivateDocument,
  getPrivateDocumentAccessUrl,
  deletePrivateDocument,
  getSupabaseAdmin,
  setMockSupabaseClient,
  resetMockSupabaseClient,
};
