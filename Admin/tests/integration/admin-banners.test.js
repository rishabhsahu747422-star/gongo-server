'use strict';

const request = require('supertest');

// Mock logger
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  http: jest.fn(),
}));

const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const userRepository = require('../../src/repositories/user.repository');
const adminBannerRepository = require('../../src/repositories/admin-banner.repository');
const { hashSessionToken } = require('../../src/utils/crypto');
const { createApp } = require('../../src/app');

const app = createApp();

const SUPER_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000001',
  role: 'ADMIN',
  name: 'Super Admin',
  email: 'superadmin@gongo.in',
  is_active: true,
  permissions: ['SUPER_ADMIN'],
};

const NON_ADMIN_CUSTOMER = {
  id: 'c0000001-0000-4000-a000-000000000001',
  role: 'CUSTOMER',
  name: 'Customer User',
  email: 'customer@gmail.com',
  is_active: true,
  permissions: [],
};

const SESSIONS = {
  admin: 'sess_admin_banner_token_001',
  customer: 'sess_customer_banner_token_002',
};

// Valid Magic Byte Buffers
const VALID_JPEG_BUFFER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
const VALID_PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
const VALID_GIF_BUFFER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
const VALID_MP4_BUFFER = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6D, 0x70, 0x34, 0x32]);
const INVALID_FILE_BUFFER = Buffer.from('NOT_A_VALID_IMAGE_OR_VIDEO_FILE');

describe('Admin Banner Management System Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (tokenHash) => {
      const match = Object.entries(SESSIONS).find(
        ([, rawToken]) => hashSessionToken(rawToken) === tokenHash,
      );
      if (!match) return null;
      const key = match[0];

      if (key === 'admin') {
        return {
          id: 'sess-id-admin',
          user_id: SUPER_ADMIN.id,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          is_active: true,
        };
      }
      if (key === 'customer') {
        return {
          id: 'sess-id-cust',
          user_id: NON_ADMIN_CUSTOMER.id,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          is_active: true,
        };
      }
      return null;
    });

    jest.spyOn(userRepository, 'findById').mockImplementation(async (userId) => {
      if (userId === SUPER_ADMIN.id) return SUPER_ADMIN;
      if (userId === NON_ADMIN_CUSTOMER.id) return NON_ADMIN_CUSTOMER;
      return null;
    });
  });

  describe('Authorization & Security', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/v1/admin/banners');
      expect(res.status).toBe(401);
    });

    it('rejects non-admin customer accounts with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/banners')
        .set('x-admin-session', SESSIONS.customer);
      expect(res.status).toBe(403);
    });
  });

  describe('Asset Upload & Magic Byte Validation', () => {
    it('accepts and verifies valid JPEG image upload', async () => {
      const res = await request(app)
        .post('/api/v1/admin/banners/upload')
        .set('x-admin-session', SESSIONS.admin)
        .send({
          fileBase64: VALID_JPEG_BUFFER.toString('base64'),
          filename: 'banner1.jpg',
          assetType: 'IMAGE',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.assetType).toBe('IMAGE');
      expect(res.body.data.storagePath).toContain('banners/');
      expect(res.body.data.contentHash).toBeTruthy();
    });

    it('accepts and verifies valid animated GIF upload', async () => {
      const res = await request(app)
        .post('/api/v1/admin/banners/upload')
        .set('x-admin-session', SESSIONS.admin)
        .send({
          fileBase64: VALID_GIF_BUFFER.toString('base64'),
          filename: 'animated_hero.gif',
          assetType: 'GIF',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.assetType).toBe('GIF');
      expect(res.body.data.mimeType).toBe('image/gif');
      expect(res.body.data.storagePath).toContain('animated_hero.gif');
    });

    it('accepts and verifies valid MP4 video upload', async () => {
      const res = await request(app)
        .post('/api/v1/admin/banners/upload')
        .set('x-admin-session', SESSIONS.admin)
        .send({
          fileBase64: VALID_MP4_BUFFER.toString('base64'),
          filename: 'promo_video.mp4',
          assetType: 'VIDEO',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.assetType).toBe('VIDEO');
      expect(res.body.data.mimeType).toBe('video/mp4');
    });

    it('rejects unsupported or spoofed file content with 400', async () => {
      const res = await request(app)
        .post('/api/v1/admin/banners/upload')
        .set('x-admin-session', SESSIONS.admin)
        .send({
          fileBase64: INVALID_FILE_BUFFER.toString('base64'),
          filename: 'fake_image.jpg',
          assetType: 'IMAGE',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Unsupported file format');
    });
  });

  describe('Remote URL Input & SSRF Protection', () => {
    it('accepts a valid secure HTTPS remote URL', async () => {
      jest.spyOn(adminBannerRepository, 'createBanner').mockImplementation(async (data) => ({
        id: 'b0000001-0000-4000-a000-000000000001',
        ...data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const res = await request(app)
        .post('/api/v1/admin/banners')
        .set('x-admin-session', SESSIONS.admin)
        .send({
          title: 'Remote Ride Banner',
          subtitle: 'Valid remote URL',
          tag: 'REMOTE TEST',
          assetType: 'IMAGE',
          assetUrl: 'https://cdn.example.com/banners/hero.webp',
          isActive: true,
          displayOrder: 1,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.asset_url).toBe('https://cdn.example.com/banners/hero.webp');
    });

    it('rejects unsafe protocols such as javascript: or file: with 400', async () => {
      const res = await request(app)
        .post('/api/v1/admin/banners')
        .set('x-admin-session', SESSIONS.admin)
        .send({
          title: 'Unsafe Banner',
          assetType: 'IMAGE',
          assetUrl: 'javascript:alert(1)',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid|Disallowed|protocol/i);
    });

    it('rejects SSRF targeting cloud metadata or localhost', async () => {
      const res = await request(app)
        .post('/api/v1/admin/banners')
        .set('x-admin-session', SESSIONS.admin)
        .send({
          title: 'SSRF Attack',
          assetType: 'IMAGE',
          assetUrl: 'http://169.254.169.254/latest/meta-data/',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('Banner CRUD & Ordering', () => {
    it('lists banners with deterministic ordering and status', async () => {
      const mockList = [
        {
          id: 'b0000001-0000-4000-a000-000000000001',
          title: 'Slide 1',
          asset_type: 'IMAGE',
          asset_url: 'https://cdn.gongo.in/1.jpg',
          is_active: true,
          display_order: 0,
          version: '1',
        },
        {
          id: 'b0000001-0000-4000-a000-000000000002',
          title: 'Slide 2',
          asset_type: 'GIF',
          asset_url: 'https://cdn.gongo.in/2.gif',
          is_active: false,
          display_order: 1,
          version: '1',
        },
      ];

      jest.spyOn(adminBannerRepository, 'listBanners').mockResolvedValue({
        items: mockList,
        pagination: { page: 1, limit: 50, total: 2, totalPages: 1 },
      });

      const res = await request(app)
        .get('/api/v1/admin/banners')
        .set('x-admin-session', SESSIONS.admin);

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(2);
      expect(res.body.data.items[0].asset_type).toBe('IMAGE');
      expect(res.body.data.items[1].asset_type).toBe('GIF');
    });

    it('updates banner status between active and inactive', async () => {
      jest.spyOn(adminBannerRepository, 'findBannerById').mockResolvedValue({
        id: 'b0000001-0000-4000-a000-000000000001',
        is_active: true,
      });

      jest.spyOn(adminBannerRepository, 'updateBanner').mockResolvedValue({
        id: 'b0000001-0000-4000-a000-000000000001',
        is_active: false,
      });

      const res = await request(app)
        .patch('/api/v1/admin/banners/b0000001-0000-4000-a000-000000000001/status')
        .set('x-admin-session', SESSIONS.admin)
        .send({ isActive: false });

      expect(res.status).toBe(200);
      expect(res.body.data.is_active).toBe(false);
    });

    it('safely deletes banner and handles unreferenced storage file', async () => {
      jest.spyOn(adminBannerRepository, 'findBannerById').mockResolvedValue({
        id: 'b0000001-0000-4000-a000-000000000001',
        storage_path: 'banners/asset.jpg',
      });
      jest.spyOn(adminBannerRepository, 'deleteBanner').mockResolvedValue({
        id: 'b0000001-0000-4000-a000-000000000001',
      });
      jest.spyOn(adminBannerRepository, 'isStoragePathInUse').mockResolvedValue(false);

      const res = await request(app)
        .delete('/api/v1/admin/banners/b0000001-0000-4000-a000-000000000001')
        .set('x-admin-session', SESSIONS.admin);

      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(true);
    });

    it('reorders banners deterministically', async () => {
      const orderedIds = [
        'b0000001-0000-4000-a000-000000000002',
        'b0000001-0000-4000-a000-000000000001',
      ];
      jest.spyOn(adminBannerRepository, 'reorderBanners').mockResolvedValue([
        { id: orderedIds[0], display_order: 0 },
        { id: orderedIds[1], display_order: 1 },
      ]);

      const res = await request(app)
        .put('/api/v1/admin/banners/reorder')
        .set('x-admin-session', SESSIONS.admin)
        .send({ orderedIds });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
    });
  });
});
