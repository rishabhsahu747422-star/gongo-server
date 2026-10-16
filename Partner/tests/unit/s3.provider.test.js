'use strict';

const s3Provider = require('../../src/providers/s3');
const env = require('../../src/config/env');

describe('Unit: S3 Provider', () => {
  let mockS3Client;

  beforeEach(() => {
    mockS3Client = {
      send: jest.fn(),
    };
    s3Provider.setMockS3Client(mockS3Client);
    s3Provider.setMockPresigner(jest.fn().mockResolvedValue('https://s3.ap-south-1.amazonaws.com/test-bucket/test-url'));
  });

  afterEach(() => {
    s3Provider.resetS3Client();
  });

  describe('createPresignedPutUrl', () => {
    it('generates presigned PUT URL with AES256 server-side encryption header', async () => {
      const result = await s3Provider.createPresignedPutUrl({
        key: 'partners/partner-1/profile/avatar.jpg',
        contentType: 'image/jpeg',
        expiresInSeconds: 900,
      });

      expect(result).toHaveProperty('uploadUrl');
      expect(typeof result.uploadUrl).toBe('string');
      expect(result.key).toBe('partners/partner-1/profile/avatar.jpg');
      expect(result.expiresInSeconds).toBe(900);
      expect(result.headers).toEqual({
        'Content-Type': 'image/jpeg',
        'x-amz-server-side-encryption': 'AES256',
      });
    });

    it('falls back to default env expiry if not specified', async () => {
      const result = await s3Provider.createPresignedPutUrl({
        key: 'partners/partner-1/profile/avatar.jpg',
        contentType: 'image/jpeg',
      });

      expect(result.expiresInSeconds).toBe(env.AWS_S3_PRESIGN_UPLOAD_EXPIRES_SECONDS);
    });
  });

  describe('createPresignedGetUrl', () => {
    it('generates presigned GET URL with configured expiry', async () => {
      const result = await s3Provider.createPresignedGetUrl({
        key: 'partners/partner-1/kyc/aadhaar/doc.pdf',
        expiresInSeconds: 300,
      });

      expect(result).toHaveProperty('downloadUrl');
      expect(typeof result.downloadUrl).toBe('string');
      expect(result.expiresInSeconds).toBe(300);
    });
  });

  describe('headObject', () => {
    it('returns object metadata when object exists in S3', async () => {
      const mockDate = new Date();
      mockS3Client.send.mockResolvedValueOnce({
        ContentLength: 1048576,
        ContentType: 'image/jpeg',
        ETag: '"etag-12345"',
        LastModified: mockDate,
        ServerSideEncryption: 'AES256',
      });

      const meta = await s3Provider.headObject({
        key: 'partners/partner-1/profile/avatar.jpg',
      });

      expect(meta.contentLength).toBe(1048576);
      expect(meta.contentType).toBe('image/jpeg');
      expect(meta.eTag).toBe('"etag-12345"');
      expect(meta.serverSideEncryption).toBe('AES256');
    });

    it('throws structured notFound error when object does not exist (404)', async () => {
      const notFoundErr = new Error('NotFound');
      notFoundErr.name = 'NotFound';
      notFoundErr.$metadata = { httpStatusCode: 404 };
      mockS3Client.send.mockRejectedValueOnce(notFoundErr);

      await expect(
        s3Provider.headObject({ key: 'partners/partner-1/nonexistent.jpg' }),
      ).rejects.toMatchObject({
        notFound: true,
        code: 'S3_OBJECT_NOT_FOUND',
      });
    });

    it('propagates other unexpected S3 errors', async () => {
      const accessDeniedErr = new Error('AccessDenied');
      accessDeniedErr.name = 'AccessDenied';
      mockS3Client.send.mockRejectedValueOnce(accessDeniedErr);

      await expect(
        s3Provider.headObject({ key: 'partners/partner-1/forbidden.jpg' }),
      ).rejects.toThrow('AccessDenied');
    });
  });

  describe('deleteObject', () => {
    it('successfully deletes object from S3', async () => {
      mockS3Client.send.mockResolvedValueOnce({});

      const result = await s3Provider.deleteObject({
        key: 'partners/partner-1/temp.jpg',
      });

      expect(result).toEqual({ success: true });
      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
    });

    it('propagates delete errors', async () => {
      mockS3Client.send.mockRejectedValueOnce(new Error('S3 delete failure'));

      await expect(
        s3Provider.deleteObject({ key: 'partners/partner-1/fail.jpg' }),
      ).rejects.toThrow('S3 delete failure');
    });
  });

  describe('getObjectHeaderBytes', () => {
    it('reads header bytes from S3 object via Range request', async () => {
      const mockBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
      mockS3Client.send.mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () => mockBytes,
        },
      });

      const bytes = await s3Provider.getObjectHeaderBytes({
        key: 'partners/p1/profile/avatar.jpg',
        maxBytes: 8,
      });

      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect(bytes).toEqual(mockBytes);
    });

    it('throws structured notFound error on S3 404', async () => {
      const notFoundErr = new Error('NotFound');
      notFoundErr.name = 'NotFound';
      mockS3Client.send.mockRejectedValueOnce(notFoundErr);

      await expect(
        s3Provider.getObjectHeaderBytes({ key: 'partners/p1/missing.jpg' }),
      ).rejects.toMatchObject({
        notFound: true,
        code: 'S3_OBJECT_NOT_FOUND',
      });
    });
  });

  describe('validateMagicBytes', () => {
    it('validates JPEG signatures correctly', () => {
      const validJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
      const invalidJpeg = Buffer.from([0x00, 0x00, 0x00, 0x00]);

      expect(s3Provider.validateMagicBytes(validJpeg, 'image/jpeg')).toBe(true);
      expect(s3Provider.validateMagicBytes(validJpeg, 'image/jpg')).toBe(true);
      expect(s3Provider.validateMagicBytes(invalidJpeg, 'image/jpeg')).toBe(false);
    });

    it('validates PNG signatures correctly', () => {
      const validPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const invalidPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x00, 0x00, 0x00]);

      expect(s3Provider.validateMagicBytes(validPng, 'image/png')).toBe(true);
      expect(s3Provider.validateMagicBytes(invalidPng, 'image/png')).toBe(false);
    });

    it('validates WebP signatures correctly', () => {
      const validWebp = Buffer.from('RIFF\x20\x00\x00\x00WEBPVP8 \x14\x00\x00\x00', 'binary');
      const invalidWebp = Buffer.from('RIFF\x20\x00\x00\x00TESTVP8 \x14\x00\x00\x00', 'binary');

      expect(s3Provider.validateMagicBytes(validWebp, 'image/webp')).toBe(true);
      expect(s3Provider.validateMagicBytes(invalidWebp, 'image/webp')).toBe(false);
    });

    it('validates PDF signatures correctly', () => {
      const validPdf = Buffer.from('%PDF-1.7\n');
      const invalidPdf = Buffer.from('%NOT-1.7\n');

      expect(s3Provider.validateMagicBytes(validPdf, 'application/pdf')).toBe(true);
      expect(s3Provider.validateMagicBytes(invalidPdf, 'application/pdf')).toBe(false);
    });

    it('rejects unsupported MIME types or malformed buffers', () => {
      expect(s3Provider.validateMagicBytes(Buffer.from([0x00]), 'image/jpeg')).toBe(false);
      expect(s3Provider.validateMagicBytes(null, 'image/jpeg')).toBe(false);
      expect(s3Provider.validateMagicBytes(Buffer.from('hello world'), 'text/plain')).toBe(false);
    });
  });
});
