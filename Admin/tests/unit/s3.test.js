'use strict';

const s3Provider = require('../../src/providers/s3');

describe('Unit: S3 Storage Provider Foundation', () => {
  beforeEach(() => {
    s3Provider.resetS3Client();
  });

  afterAll(() => {
    s3Provider.resetS3Client();
  });

  it('generates presigned PUT URL with AES256 encryption header', async () => {
    const mockPresigner = jest.fn().mockResolvedValue('https://s3.amazonaws.com/test-bucket/test-key?signature=abc');
    s3Provider.setMockPresigner(mockPresigner);

    const result = await s3Provider.createPresignedPutUrl({
      key: 'documents/test.pdf',
      contentType: 'application/pdf',
      expiresInSeconds: 600,
    });

    expect(result.uploadUrl).toBe('https://s3.amazonaws.com/test-bucket/test-key?signature=abc');
    expect(result.key).toBe('documents/test.pdf');
    expect(result.expiresInSeconds).toBe(600);
    expect(result.headers['x-amz-server-side-encryption']).toBe('AES256');
  });

  it('generates presigned GET download URL', async () => {
    const mockPresigner = jest.fn().mockResolvedValue('https://s3.amazonaws.com/test-bucket/test-key?download=true');
    s3Provider.setMockPresigner(mockPresigner);

    const result = await s3Provider.createPresignedGetUrl({
      key: 'documents/test.pdf',
      expiresInSeconds: 300,
    });

    expect(result.downloadUrl).toBe('https://s3.amazonaws.com/test-bucket/test-key?download=true');
    expect(result.key).toBe('documents/test.pdf');
    expect(result.expiresInSeconds).toBe(300);
  });

  it('performs headObject and returns object metadata', async () => {
    const mockSend = jest.fn().mockResolvedValue({
      ContentLength: 1024,
      ContentType: 'application/pdf',
      LastModified: new Date('2026-01-01'),
      ETag: '"etag-123"',
    });
    s3Provider.setMockS3Client({ send: mockSend });

    const metadata = await s3Provider.headObject({ key: 'documents/test.pdf' });

    expect(metadata.contentLength).toBe(1024);
    expect(metadata.contentType).toBe('application/pdf');
    expect(metadata.etag).toBe('"etag-123"');
  });

  it('returns null on headObject when object is not found (404)', async () => {
    const notFoundError = new Error('NoSuchKey');
    notFoundError.name = 'NotFound';
    notFoundError.$metadata = { httpStatusCode: 404 };

    const mockSend = jest.fn().mockRejectedValue(notFoundError);
    s3Provider.setMockS3Client({ send: mockSend });

    const metadata = await s3Provider.headObject({ key: 'documents/missing.pdf' });

    expect(metadata).toBeNull();
  });

  it('deletes object from S3', async () => {
    const mockSend = jest.fn().mockResolvedValue({});
    s3Provider.setMockS3Client({ send: mockSend });

    await expect(s3Provider.deleteObject({ key: 'documents/test.pdf' })).resolves.not.toThrow();
    expect(mockSend).toHaveBeenCalled();
  });
});
