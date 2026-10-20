'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const adminOfferRepo = require('../../Admin/src/repositories/admin-offer.repository');
const adminOfferService = require('../../Admin/src/services/admin-offer.service');
const customerOfferRepo = require('../../Customer/src/repositories/offer.repository');
const customerOfferService = require('../../Customer/src/services/offer.service');

describe('GONGO Dynamic Offers — End-to-End System Integration', () => {
  let app;
  let testOfferId = null;

  beforeAll(async () => {
    app = createApp();
  });

  afterAll(async () => {
    if (testOfferId) {
      try {
        await adminOfferRepo.deleteOffer(testOfferId);
      } catch (_) {}
    }
  });

  describe('Customer Offers Public Gateway & Endpoint Verification', () => {
    it('GET /api/v1/offers/active returns 200 with structured items and revision', async () => {
      const res = await request(app).get('/api/v1/offers/active');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.offers)).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(typeof res.body.data.revision).toBe('string');
      expect(res.headers.etag).toBeDefined();
      expect(res.headers['cache-control']).toContain('max-age=300');
    });

    it('GET /api/v1/customer/offers/active returns identical contract', async () => {
      const res = await request(app).get('/api/v1/customer/offers/active');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.offers)).toBe(true);
      expect(typeof res.body.data.revision).toBe('string');
    });

    it('returns 304 Not Modified when client provides exact revision ETag', async () => {
      const firstRes = await request(app).get('/api/v1/offers/active');
      expect(firstRes.status).toBe(200);
      const etag = firstRes.headers.etag;
      expect(etag).toBeDefined();

      const cachedRes = await request(app)
        .get('/api/v1/offers/active')
        .set('If-None-Match', etag);

      expect(cachedRes.status).toBe(304);
    });
  });

  describe('Database Lifecycle & Admin Management of Offers', () => {
    it('Admin can create a dynamic offer with all metadata and priority', async () => {
      const payload = {
        name: 'Automated Test Offer Monsoon 2026',
        description: 'Enjoy 20% discount on SUVs for testing',
        code: 'TESTMONSOON20',
        offer_type: 'discount',
        discount_type: 'percentage',
        discount_value: 20,
        max_discount_amount: 500,
        min_booking_amount: 1000,
        display_order: 1,
        cta_label: 'Book SUV',
        cta_destination: '/vehicles',
        valid_from: new Date(Date.now() - 3600000).toISOString(),
        valid_until: new Date(Date.now() + 86400000 * 30).toISOString(),
        is_active: true,
      };

      const result = await adminOfferService.createOffer(payload, {
        actorId: '00000000-0000-0000-0000-000000000001',
        actorRole: 'ADMIN',
      });

      expect(result.offer).toBeDefined();
      expect(result.offer.id).toBeDefined();
      expect(result.offer.name).toBe(payload.name);
      expect(result.offer.code).toBe(payload.code);
      expect(Number(result.offer.discount_value)).toBe(20);
      expect(Number(result.offer.min_booking_amount)).toBe(1000);
      expect(result.offer.is_active).toBe(true);

      testOfferId = result.offer.id;
    });

    it('Customer service reflects newly created offer dynamically without app release', async () => {
      const activeData = await customerOfferService.getActiveOffers();
      expect(Array.isArray(activeData.offers)).toBe(true);

      const found = activeData.offers.find((o) => o.id === testOfferId);
      expect(found).toBeDefined();
      expect(found.name).toBe('Automated Test Offer Monsoon 2026');
      expect(found.code).toBe('TESTMONSOON20');
      expect(found.discountValue).toBe(20);
      expect(found.minBookingAmount).toBe(1000);
      expect(found.displayOrder).toBe(1);
      // Ensure internal admin fields are NOT leaked
      expect(found.created_by).toBeUndefined();
      expect(found.storage_path).toBeUndefined();
    });

    it('Admin can toggle status to deactivated and Customer endpoint immediately excludes it', async () => {
      await adminOfferService.updateStatus(testOfferId, false, {
        actorId: '00000000-0000-0000-0000-000000000001',
        actorRole: 'ADMIN',
      });

      const activeData = await customerOfferService.getActiveOffers();
      const found = activeData.offers.find((o) => o.id === testOfferId);
      expect(found).toBeUndefined();
    });

    it('Admin can reactivate the offer and Customer endpoint immediately includes it again', async () => {
      await adminOfferService.updateStatus(testOfferId, true, {
        actorId: '00000000-0000-0000-0000-000000000001',
        actorRole: 'ADMIN',
      });

      const activeData = await customerOfferService.getActiveOffers();
      const found = activeData.offers.find((o) => o.id === testOfferId);
      expect(found).toBeDefined();
    });

    it('Admin can reorder offers display priority atomically', async () => {
      const reordered = await adminOfferService.reorderOffers([testOfferId]);
      expect(Array.isArray(reordered)).toBe(true);
      expect(reordered.length).toBe(1);
      expect(reordered[0].id).toBe(testOfferId);
      expect(reordered[0].display_order).toBe(0);
    });

    it('Admin can safely delete the offer', async () => {
      const res = await adminOfferService.deleteOffer(testOfferId, {
        actorId: '00000000-0000-0000-0000-000000000001',
        actorRole: 'ADMIN',
      });
      expect(res).toBeDefined();

      const activeData = await customerOfferService.getActiveOffers();
      const found = activeData.offers.find((o) => o.id === testOfferId);
      expect(found).toBeUndefined();
      testOfferId = null;
    });
  });
});
