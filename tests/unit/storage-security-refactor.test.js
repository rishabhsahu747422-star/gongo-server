'use strict';

const storageService = require('../../src/shared/storage');
const partnerStorage = require('../../Partner/src/providers/storage');
const adminStorage = require('../../Admin/src/providers/supabase-storage');

describe('Storage Security Refactor - Public Images vs Private Documents', () => {
  let mockSupabase;

  beforeEach(() => {
    mockSupabase = {
      storage: {
        from: jest.fn().mockImplementation((bucketName) => ({
          upload: jest.fn().mockImplementation(async (path, file, options) => ({
            data: { path, id: 'mock-upload-id' },
            error: null,
          })),
          remove: jest.fn().mockImplementation(async (paths) => ({
            data: paths.map((p) => ({ name: p })),
            error: null,
          })),
          getPublicUrl: jest.fn().mockImplementation((path) => ({
            data: {
              publicUrl: `https://mtfljykvxyslhdvpfcil.supabase.co/storage/v1/object/public/${bucketName}/${path}`,
            },
          })),
          createSignedUrl: jest.fn().mockImplementation(async (path, expiresIn) => ({
            data: {
              signedUrl: `https://mtfljykvxyslhdvpfcil.supabase.co/storage/v1/object/sign/${bucketName}/${path}?token=mock-jwt-token`,
            },
            error: null,
          })),
        })),
      },
    };

    storageService.setMockSupabaseClient(mockSupabase);
  });

  afterEach(() => {
    storageService.resetMockSupabaseClient();
    jest.restoreAllMocks();
  });

  describe('Path and Bucket Classification', () => {
    it('correctly identifies private document paths', () => {
      const privatePaths = [
        'partners/1111/kyc/aadhaar/doc.pdf',
        'partners/1111/kyc/pan/doc.jpg',
        'partners/1111/vehicles/2222/documents/rc/rc.pdf',
        'partners/1111/vehicles/2222/documents/insurance/policy.jpg',
        'partners/1111/vehicles/2222/documents/puc/puc.pdf',
        'partners/1111/vehicles/2222/documents/fitness/cert.pdf',
        'customers/3333/aadhaar/ekyc.xml',
        'customers/3333/documents/driving_licence.pdf',
      ];

      for (const p of privatePaths) {
        expect(storageService.isPrivateDocumentPath(p)).toBe(true);
      }
    });

    it('correctly identifies public image paths as non-private', () => {
      const publicPaths = [
        'partners/1111/profile/avatar.jpg',
        'partners/1111/vehicles/2222/images/exterior-front.jpg',
        'partners/1111/vehicles/2222/images/interior-dashboard.webp',
        'banners/hero-promo-2026.png',
        'shops/1111/facade.jpg',
      ];

      for (const p of publicPaths) {
        expect(storageService.isPrivateDocumentPath(p)).toBe(false);
      }
    });

    it('resolves correct target bucket based on entity type and storage key', () => {
      expect(storageService.resolveBucketForPath('arbitrary/path.pdf', 'KYC_DOCUMENT')).toBe(
        'gongo-partner-documents',
      );
      expect(storageService.resolveBucketForPath('arbitrary/path.pdf', 'VEHICLE_DOCUMENT')).toBe(
        'gongo-partner-documents',
      );
      expect(storageService.resolveBucketForPath('arbitrary/path.jpg', 'VEHICLE_IMAGE')).toBe(
        'gongo-uploads',
      );
      expect(storageService.resolveBucketForPath('arbitrary/path.jpg', 'PROFILE_IMAGE')).toBe(
        'gongo-uploads',
      );
      expect(storageService.resolveBucketForPath('arbitrary/path.png', 'BANNER')).toBe(
        'gongo-uploads',
      );
      expect(storageService.resolveBucketForPath('customers/cust-1/doc.pdf')).toBe(
        'gongo-customers',
      );
      expect(storageService.resolveBucketForPath('partners/p1/vehicles/v1/documents/rc/doc.pdf')).toBe(
        'gongo-partner-documents',
      );
      expect(storageService.resolveBucketForPath('partners/p1/vehicles/v1/images/front.jpg')).toBe(
        'gongo-uploads',
      );
    });

    it('canonicalizes bucket aliases correctly', () => {
      expect(storageService.canonicalizeBucketName('gongouploads')).toBe('gongo-uploads');
      expect(storageService.canonicalizeBucketName('gongo-uploads')).toBe('gongo-uploads');
      expect(storageService.canonicalizeBucketName('gongo-partner-documents')).toBe('gongo-partner-documents');
      expect(storageService.canonicalizeBucketName('gongopartnerdocuments')).toBe('gongo-partner-documents');
      expect(storageService.canonicalizeBucketName('gongo-customers')).toBe('gongo-customers');
    });
  });

  describe('Public Image Operations', () => {
    it('uploads image to public bucket (gongo-uploads)', async () => {
      const result = await storageService.uploadPublicImage({
        file: Buffer.from('fake-image-bytes'),
        path: 'partners/p1/vehicles/v1/images/front.jpg',
        contentType: 'image/jpeg',
      });

      expect(result.bucket).toBe('gongo-uploads');
      expect(result.storageKey).toBe('partners/p1/vehicles/v1/images/front.jpg');
      expect(result.publicUrl).toContain('/storage/v1/object/public/gongo-uploads/partners/p1/vehicles/v1/images/front.jpg');
      expect(mockSupabase.storage.from).toHaveBeenCalledWith('gongo-uploads');
    });

    it('refuses to upload sensitive document to public bucket with SECURITY VIOLATION', async () => {
      await expect(
        storageService.uploadPublicImage({
          file: Buffer.from('fake-rc-bytes'),
          path: 'partners/p1/vehicles/v1/documents/rc/rc.pdf',
          contentType: 'application/pdf',
        }),
      ).rejects.toThrow(/SECURITY VIOLATION/);
    });

    it('rejects unallowed MIME types for public images', async () => {
      await expect(
        storageService.uploadPublicImage({
          file: Buffer.from('fake-script'),
          path: 'partners/p1/profile/exploit.html',
          contentType: 'text/html',
        }),
      ).rejects.toThrow(/Invalid file type for public image/);
    });

    it('generates public URL for legitimate public image', () => {
      const url = storageService.getPublicImageUrl(
        'partners/p1/vehicles/v1/images/front.jpg',
        'gongo-uploads',
      );
      expect(url).toBe(
        'https://mtfljykvxyslhdvpfcil.supabase.co/storage/v1/object/public/gongo-uploads/partners/p1/vehicles/v1/images/front.jpg',
      );
    });

    it('throws SECURITY VIOLATION when attempting to generate public URL for private document', () => {
      expect(() => {
        storageService.getPublicImageUrl('partners/p1/kyc/aadhaar/doc.pdf', 'gongo-uploads');
      }).toThrow(/SECURITY VIOLATION: Cannot generate public URL for private document/);

      expect(() => {
        storageService.getPublicImageUrl('partners/p1/vehicles/v1/documents/rc/doc.png');
      }).toThrow(/SECURITY VIOLATION: Cannot generate public URL for private document/);
    });

    it('throws SECURITY VIOLATION when attempting to generate public URL for private bucket', () => {
      expect(() => {
        storageService.getPublicImageUrl('random/image.jpg', 'gongo-partner-documents');
      }).toThrow(/SECURITY VIOLATION: Cannot generate public URL for non-public bucket/);
    });

    it('deletes public image from gongo-uploads', async () => {
      const res = await storageService.deletePublicImage({
        path: 'partners/p1/vehicles/v1/images/front.jpg',
      });
      expect(res.success).toBe(true);
      expect(mockSupabase.storage.from).toHaveBeenCalledWith('gongo-uploads');
    });
  });

  describe('Private Document Operations', () => {
    it('uploads sensitive document exclusively to gongo-partner-documents', async () => {
      const result = await storageService.uploadPrivateDocument({
        file: Buffer.from('fake-pan-bytes'),
        path: 'partners/p1/kyc/pan/pan.pdf',
        contentType: 'application/pdf',
        documentType: 'PAN',
      });

      expect(result.bucket).toBe('gongo-partner-documents');
      expect(result.storageKey).toBe('partners/p1/kyc/pan/pan.pdf');
      expect(mockSupabase.storage.from).toHaveBeenCalledWith('gongo-partner-documents');
    });

    it('rejects invalid MIME types for private documents', async () => {
      await expect(
        storageService.uploadPrivateDocument({
          file: Buffer.from('fake-video'),
          path: 'partners/p1/kyc/video.mp4',
          contentType: 'video/mp4',
        }),
      ).rejects.toThrow(/Invalid file type for private document/);
    });

    it('generates short-lived signed access URL for private document', async () => {
      const result = await storageService.getPrivateDocumentAccessUrl({
        path: 'partners/p1/vehicles/v1/documents/rc/rc.pdf',
        expiresInSeconds: 600,
      });

      expect(result.bucket).toBe('gongo-partner-documents');
      expect(result.storageKey).toBe('partners/p1/vehicles/v1/documents/rc/rc.pdf');
      expect(result.expiresInSeconds).toBe(600);
      expect(result.downloadUrl).toContain('/storage/v1/object/sign/gongo-partner-documents/');
      expect(result.downloadUrl).toContain('token=mock-jwt-token');
      expect(mockSupabase.storage.from).toHaveBeenCalledWith('gongo-partner-documents');
    });

    it('deletes private document from gongo-partner-documents', async () => {
      const res = await storageService.deletePrivateDocument({
        path: 'partners/p1/kyc/aadhaar/old.pdf',
      });
      expect(res.success).toBe(true);
      expect(mockSupabase.storage.from).toHaveBeenCalledWith('gongo-partner-documents');
    });
  });

  describe('Admin and Partner Provider Hardening', () => {
    it('Admin supabase-storage getPublicUrl refuses private document paths', () => {
      expect(() => {
        adminStorage.getPublicUrl('partners/p1/vehicles/v1/documents/rc/rc.pdf');
      }).toThrow(/Cannot generate public URL for private partner document/);
    });

    it('Admin supabase-storage getPublicUrl permits public vehicle images', () => {
      const url = adminStorage.getPublicUrl('partners/p1/vehicles/v1/images/front.jpg');
      expect(url).toContain('gongo-uploads');
    });

    it('Partner storage provider resolveBucket directs documents to private bucket', () => {
      const docBucket = partnerStorage.resolveBucket('partners/p1/vehicles/v1/documents/rc/rc.pdf');
      expect(docBucket).toBe('gongo-partner-documents');

      const imgBucket = partnerStorage.resolveBucket('partners/p1/vehicles/v1/images/front.jpg');
      expect(imgBucket).toBe('gongo-uploads');
    });
  });
});
