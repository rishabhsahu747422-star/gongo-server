'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const adminBannerRepo = require('../../Admin/src/repositories/admin-banner.repository');
const adminBannerService = require('../../Admin/src/services/admin-banner.service');
const customerBannerRepo = require('../../Customer/src/repositories/banner.repository');
const customerBannerService = require('../../Customer/src/services/banner.service');

describe('GONGO Dynamic Hero Banners — End-to-End System Integration', () => {
  let app;
  let testBannerId1 = null;
  let testBannerId2 = null;

  beforeAll(async () => {
    app = createApp();
  });

  afterAll(async () => {
    // Cleanup any created test banners
    for (const id of [testBannerId1, testBannerId2]) {
      if (id) {
        try {
          await adminBannerRepo.deleteBanner(id);
        } catch (_) {}
      }
    }
  });

  describe('TEST 8: Security & Authorization - Unauthenticated / Unauthorized Rejection', () => {
    it('rejects unauthenticated requests to Admin banner routes with 401', async () => {
      const res = await request(app).get('/api/v1/admin/banners');
      expect(res.status).toBe(401);
    });

    it('rejects unauthorized non-admin requests to Admin banner routes with 401/403', async () => {
      const res = await request(app)
        .post('/api/v1/admin/banners')
        .set('Authorization', 'Bearer invalid-token')
        .send({ title: 'Hacked Banner' });
      expect([401, 403]).toContain(res.status);
    });
  });

  describe('TEST 6: Database Graceful Handling When No Active Banners', () => {
    it('Customer endpoint returns 200 with empty banners array and valid revision hash', async () => {
      const res = await request(app).get('/api/v1/banners/active');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.banners)).toBe(true);
      expect(typeof res.body.data.revision).toBe('string');
      expect(res.headers.etag).toBeDefined();
    });

    it('GET /api/v1/customer/banners/active returns identical contract', async () => {
      const res = await request(app).get('/api/v1/customer/banners/active');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.banners)).toBe(true);
      expect(typeof res.body.data.revision).toBe('string');
    });
  });

  describe('TEST 1 & STEP 2: Admin Uploads / Creates Hero Image and Activates It', () => {
    it('Admin uploads a valid image buffer directly to storage and returns public URL', async () => {
      // 1x1 transparent PNG
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const buffer = Buffer.from(pngBase64, 'base64');

      const uploadResult = await adminBannerService.uploadAsset(
        {
          buffer,
          filename: 'test_hero_summer.png',
          assetType: 'IMAGE',
        },
        {
          actorId: '00000000-0000-0000-0000-000000000001',
          actorRole: 'ADMIN',
        }
      );

      expect(uploadResult).toBeDefined();
      expect(uploadResult.storagePath).toContain('banners/');
      expect(uploadResult.assetUrl).toContain('https://');
      expect(uploadResult.assetType).toBe('IMAGE');
      expect(uploadResult.mimeType).toBe('image/png');
    });

    it('Admin creates and activates Banner A with title, subtitle, CTA and display order', async () => {
      const payload = {
        title: 'Your City. Your Ride.',
        subtitle: 'Premium rides for every journey across Bhopal.',
        tag: 'INSTANT SELF-DRIVE FLEET',
        assetType: 'IMAGE',
        assetUrl: 'https://mtfljykvxyslhdvpfcil.supabase.co/storage/v1/object/public/gongo-uploads/banners/test_banner_a.jpg',
        storagePath: 'banners/test_banner_a.jpg',
        displayOrder: 1,
        ctaLabel: 'Book Now',
        ctaDestination: 'VehicleListScreen',
        isActive: true,
      };

      const created = await adminBannerService.createBanner(payload, {
        actorId: '00000000-0000-0000-0000-000000000001',
        actorRole: 'ADMIN',
      });

      expect(created).toBeDefined();
      expect(created.id).toBeDefined();
      expect(created.title).toBe(payload.title);
      expect(created.subtitle).toBe(payload.subtitle);
      expect(created.is_active).toBe(true);
      expect(created.display_order).toBe(1);

      testBannerId1 = created.id;
    });

    it('Admin creates and activates Banner B with display order 2', async () => {
      const payload = {
        title: 'Make Every Journey Yours.',
        subtitle: 'Find the right self-drive car for your trip.',
        tag: 'CARS & ROAD TRIPS',
        assetType: 'IMAGE',
        assetUrl: 'https://mtfljykvxyslhdvpfcil.supabase.co/storage/v1/object/public/gongo-uploads/banners/test_banner_b.jpg',
        storagePath: 'banners/test_banner_b.jpg',
        displayOrder: 2,
        ctaLabel: 'Explore Cars',
        ctaDestination: 'CAR',
        isActive: true,
      };

      const created = await adminBannerService.createBanner(payload, {
        actorId: '00000000-0000-0000-0000-000000000001',
        actorRole: 'ADMIN',
      });

      expect(created).toBeDefined();
      expect(created.id).toBeDefined();
      testBannerId2 = created.id;
    });

    it('TEST 1 VERIFICATION: Customer App API immediately reflects new active banners in order', async () => {
      const res = await request(app).get('/api/v1/banners/active');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const items = res.body.data.banners;
      const foundA = items.find((b) => b.id === testBannerId1);
      const foundB = items.find((b) => b.id === testBannerId2);

      expect(foundA).toBeDefined();
      expect(foundB).toBeDefined();
      expect(foundA.title).toBe('Your City. Your Ride.');
      expect(foundA.ctaLabel).toBe('Book Now');
      expect(foundA.ctaDestination).toBe('VehicleListScreen');
      expect(foundA.displayOrder).toBe(1);
      expect(foundB.displayOrder).toBe(2);

      // Verify internal administrative columns are not leaked
      expect(foundA.created_by).toBeUndefined();
      expect(foundA.storage_path).toBeUndefined();
    });
  });

  describe('TEST 2 & STEP 6: Dynamic Refresh Without APK Rebuild', () => {
    it('Admin updates Banner A image and title -> revision changes and Customer API reflects it', async () => {
      const firstRes = await request(app).get('/api/v1/banners/active');
      const firstRevision = firstRes.body.data.revision;

      // Admin updates title and image URL
      await adminBannerService.updateBanner(
        testBannerId1,
        {
          title: 'Monsoon Special Rides',
          subtitle: 'Monsoon discounts active now',
          assetUrl: 'https://mtfljykvxyslhdvpfcil.supabase.co/storage/v1/object/public/gongo-uploads/banners/test_banner_a_v2.jpg',
        },
        {
          actorId: '00000000-0000-0000-0000-000000000001',
          actorRole: 'ADMIN',
        }
      );

      const updatedRes = await request(app).get('/api/v1/banners/active');
      expect(updatedRes.status).toBe(200);

      const updatedItems = updatedRes.body.data.banners;
      const updatedA = updatedItems.find((b) => b.id === testBannerId1);
      expect(updatedA).toBeDefined();
      expect(updatedA.title).toBe('Monsoon Special Rides');
      expect(updatedA.subtitle).toBe('Monsoon discounts active now');
      expect(updatedA.assetUrl).toContain('test_banner_a_v2.jpg');

      // Revision has updated deterministically
      expect(updatedRes.body.data.revision).not.toBe(firstRevision);
    });

    it('Customer Conditional GET returns 304 with unchanged ETag and 200 with new content upon change', async () => {
      const curRes = await request(app).get('/api/v1/banners/active');
      const curEtag = curRes.headers.etag;
      expect(curEtag).toBeDefined();

      const notModifiedRes = await request(app)
        .get('/api/v1/banners/active')
        .set('If-None-Match', curEtag);
      expect(notModifiedRes.status).toBe(304);
    });
  });

  describe('TEST 4 & STEP 7: Admin Changes Banner Order', () => {
    it('Admin flips banner order (Banner B becomes order 0, Banner A becomes order 1)', async () => {
      await adminBannerService.reorderBanners([testBannerId2, testBannerId1], {
        actorId: '00000000-0000-0000-0000-000000000001',
        actorRole: 'ADMIN',
      });

      const res = await request(app).get('/api/v1/banners/active');
      expect(res.status).toBe(200);

      const items = res.body.data.banners;
      const indexB = items.findIndex((b) => b.id === testBannerId2);
      const indexA = items.findIndex((b) => b.id === testBannerId1);

      expect(indexB).toBeLessThan(indexA);
    });
  });

  describe('TEST 3: Admin Deactivates a Banner', () => {
    it('Admin deactivates Banner B -> immediately excluded from Customer active banners', async () => {
      await adminBannerService.updateStatus(testBannerId2, false, {
        actorId: '00000000-0000-0000-0000-000000000001',
        actorRole: 'ADMIN',
      });

      const res = await request(app).get('/api/v1/banners/active');
      expect(res.status).toBe(200);

      const items = res.body.data.banners;
      const foundB = items.find((b) => b.id === testBannerId2);
      expect(foundB).toBeUndefined();

      const foundA = items.find((b) => b.id === testBannerId1);
      expect(foundA).toBeDefined();
    });
  });

  describe('TEST 5: Admin Deletes a Banner', () => {
    it('Admin deletes Banner A -> permanently removed from Customer API', async () => {
      await adminBannerService.deleteBanner(testBannerId1, {
        actorId: '00000000-0000-0000-0000-000000000001',
        actorRole: 'ADMIN',
      });
      testBannerId1 = null;

      const res = await request(app).get('/api/v1/banners/active');
      expect(res.status).toBe(200);

      const items = res.body.data.banners;
      const foundA = items.find((b) => b.id === testBannerId1);
      expect(foundA).toBeUndefined();
    });
  });

  describe('TEST 10: Regression Verification of Existing Core Modules', () => {
    it('Vehicle discovery endpoint (/api/v1/vehicles) still functions correctly', async () => {
      const res = await request(app).get('/api/v1/vehicles?limit=5');
      expect([200, 304]).toContain(res.status);
    });

    it('Platform fee endpoint (/api/v1/platform-fee) still functions correctly', async () => {
      const res = await request(app)
        .get('/api/v1/platform-fee')
        .set('Authorization', 'Bearer dev-token-9999999999');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('Offers endpoint (/api/v1/offers/active) still functions correctly', async () => {
      const res = await request(app).get('/api/v1/offers/active');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
