'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const env = require('../config/env');
const logger = require('../config/logger');

let s3ClientInstance = null;
let presignerFn = getSignedUrl;

function getS3Client() {
  if (s3ClientInstance) {
    return s3ClientInstance;
  }

  const clientConfig = {
    region: env.AWS_REGION || 'ap-south-1',
  };

  if (env.SUPABASE_S3_ENDPOINT) {
    clientConfig.endpoint = env.SUPABASE_S3_ENDPOINT;
    clientConfig.forcePathStyle = true;
  }

  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    clientConfig.credentials = {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    };
  }

  s3ClientInstance = new S3Client(clientConfig);
  return s3ClientInstance;
}

function setMockS3Client(mockClient) {
  s3ClientInstance = mockClient;
}

function setMockPresigner(mockPresigner) {
  presignerFn = mockPresigner;
}

function resetS3Client() {
  s3ClientInstance = null;
  presignerFn = getSignedUrl;
}

async function createPresignedPutUrl({ key, contentType, expiresInSeconds }) {
  const client = getS3Client();
  const bucket = env.AWS_S3_BUCKET;
  const expiry = expiresInSeconds || env.AWS_S3_PRESIGN_UPLOAD_EXPIRES_SECONDS;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    ServerSideEncryption: 'AES256',
  });

  const uploadUrl = await presignerFn(client, command, { expiresIn: expiry });

  return {
    uploadUrl,
    key,
    expiresInSeconds: expiry,
    headers: {
      'Content-Type': contentType,
      'x-amz-server-side-encryption': 'AES256',
    },
  };
}

async function createPresignedGetUrl({ key, expiresInSeconds, responseContentDisposition = null }) {
  // If a mock presigner is explicitly configured (e.g. in unit tests), use it directly
  if (presignerFn !== getSignedUrl) {
    const client = getS3Client();
    const bucket = env.AWS_S3_BUCKET;
    const expiry = expiresInSeconds || env.AWS_S3_PRESIGN_DOWNLOAD_EXPIRES_SECONDS;

    const commandParams = {
      Bucket: bucket,
      Key: key,
    };

    if (responseContentDisposition) {
      commandParams.ResponseContentDisposition = responseContentDisposition;
    }

    const command = new GetObjectCommand(commandParams);
    const downloadUrl = await presignerFn(client, command, { expiresIn: expiry });

    return {
      downloadUrl,
      key,
      expiresInSeconds: expiry,
    };
  }

  // Check Supabase Storage where partner & vehicle media files reside
  try {
    const { getSupabase } = require('../config/supabase');
    const supabase = getSupabase();
    if (supabase && supabase.storage) {
      const bucket = (key && (key.startsWith('partners/') || key.startsWith('partner/')))
        ? 'gongo-partner-documents'
        : (env.SUPABASE_STORAGE_BUCKET || 'gongo-uploads');

      const expiry = expiresInSeconds || 3600;
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(key, expiry);
      if (!error && data && data.signedUrl) {
        return {
          downloadUrl: data.signedUrl,
          key,
          expiresInSeconds: expiry,
        };
      }

      // If not in primary bucket, check alternate bucket
      const altBucket = bucket === 'gongo-partner-documents' ? 'gongo-uploads' : 'gongo-partner-documents';
      const altRes = await supabase.storage.from(altBucket).createSignedUrl(key, expiry);
      if (!altRes.error && altRes.data && altRes.data.signedUrl) {
        return {
          downloadUrl: altRes.data.signedUrl,
          key,
          expiresInSeconds: expiry,
        };
      }
    }
  } catch (err) {
    logger.warn('Supabase storage createSignedUrl failed, falling back to S3', { error: err.message, key });
  }

  // Fallback to AWS S3
  const client = getS3Client();
  const bucket = env.AWS_S3_BUCKET;
  const expiry = expiresInSeconds || env.AWS_S3_PRESIGN_DOWNLOAD_EXPIRES_SECONDS;

  const commandParams = {
    Bucket: bucket,
    Key: key,
  };

  if (responseContentDisposition) {
    commandParams.ResponseContentDisposition = responseContentDisposition;
  }

  const command = new GetObjectCommand(commandParams);
  const downloadUrl = await presignerFn(client, command, { expiresIn: expiry });

  return {
    downloadUrl,
    key,
    expiresInSeconds: expiry,
  };
}

async function headObject({ key }) {
  const client = getS3Client();
  const command = new HeadObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
  });

  try {
    const res = await client.send(command);
    return {
      contentLength: res.ContentLength,
      contentType: res.ContentType,
      lastModified: res.LastModified,
      etag: res.ETag,
    };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

async function deleteObject({ key }) {
  const client = getS3Client();
  const command = new DeleteObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
  });

  await client.send(command);
  logger.info('S3 object deleted successfully', { key });
}

module.exports = {
  getS3Client,
  setMockS3Client,
  setMockPresigner,
  resetS3Client,
  createPresignedPutUrl,
  createPresignedGetUrl,
  headObject,
  deleteObject,
};
