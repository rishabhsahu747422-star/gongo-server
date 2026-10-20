'use strict';

const request = require('supertest');

// Mock pg pool before requiring app
const mockDbRows = [];
jest.mock('pg', () => {
  const mClient = {
    query: jest.fn().mockImplementation((queryText, params) => {
      return Promise.resolve({ rows: mockDbRows });
    }),
    release: jest.fn(),
  };
  const mPool = {
    connect: jest.fn().mockResolvedValue(mClient),
    query: jest.fn().mockImplementation((queryText, params) => {
      return Promise.resolve({ rows: mockDbRows });
    }),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };
  return { Pool: jest.fn(() => mPool) };
});

const { createApp } = require('../../src/app');

describe('Customer Banners API Integration Tests', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    mockDbRows.length = 0;
  });

  describe('GET /api/v1/customer/banners/active', () => {
    it('returns empty banners list with null revision when no banners are active', async () => {
      const res = await request(app).get('/api/v1/customer/banners/active');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.banners).toEqual([]);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.revision).toBeDefined();
      expect(res.headers['cache-control']).toContain('public, max-age=300');
    });

    it('returns sanitized active banners ordered deterministically with revision and ETag', async () => {
      const sampleBanners = [
        {
          id: 'b1111111-1111-4111-8111-111111111111',
          title: 'GONGO Summer Ride',
          subtitle: 'Up to 30% Off on Self-Drive',
          tag: 'FEATURED',
          asset_type: 'IMAGE',
          asset_url: 'https://cdn.example.com/banners/summer.jpg',
          storage_path: 'banners/summer.jpg',
          version: 2,
          content_hash: 'hash-abc-123',
          display_order: 1,
          cta_label: 'Book Now',
          cta_destination: 'Vehicles',
          metadata: { theme: 'summer' },
          is_active: true,
          created_by: 'admin-super-user',
          created_at: new Date('2026-06-01T10:00:00Z'),
          updated_at: new Date('2026-06-02T10:00:00Z'),
        },
        {
          id: 'b2222222-2222-4222-8222-222222222222',
          title: 'Weekend Bike Escape',
          subtitle: 'Cruise anywhere anytime',
          tag: 'TRENDING',
          asset_type: 'GIF',
          asset_url: 'https://cdn.example.com/banners/bike.gif',
          storage_path: 'banners/bike.gif',
          version: 1,
          content_hash: 'hash-def-456',
          display_order: 2,
          cta_label: 'Explore Bikes',
          cta_destination: 'Vehicles',
          metadata: {},
          is_active: true,
          created_by: 'admin-super-user',
          created_at: new Date('2026-06-01T11:00:00Z'),
          updated_at: new Date('2026-06-01T11:00:00Z'),
        },
      ];
      mockDbRows.push(...sampleBanners);

      const res = await request(app).get('/api/v1/customer/banners/active');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.revision).toBeDefined();

      const item1 = res.body.data.items[0];
      expect(item1.id).toBe(sampleBanners[0].id);
      expect(item1.title).toBe('GONGO Summer Ride');
      expect(item1.assetType).toBe('IMAGE');
      expect(item1.assetUrl).toBe('https://cdn.example.com/banners/summer.jpg');
      expect(item1.version).toBe(2);
      expect(item1.contentHash).toBe('hash-abc-123');
      expect(item1.ctaLabel).toBe('Book Now');
      // Verify admin private fields are stripped
      expect(item1.created_by).toBeUndefined();
      expect(item1.storage_path).toBeUndefined();

      // Check caching headers
      expect(res.headers.etag).toBeDefined();
      expect(res.headers.etag).toContain('W/"banner-rev-');
      expect(res.headers['cache-control']).toContain('public, max-age=300');
    });

    it('returns HTTP 304 Not Modified when client provides matching ETag', async () => {
      mockDbRows.push({
        id: 'b1111111-1111-4111-8111-111111111111',
        title: 'GONGO Summer Ride',
        subtitle: 'Up to 30% Off',
        tag: 'FEATURED',
        asset_type: 'IMAGE',
        asset_url: 'https://cdn.example.com/banners/summer.jpg',
        version: 1,
        content_hash: 'hash-123',
        display_order: 1,
        cta_label: 'Book Now',
        cta_destination: 'Vehicles',
        metadata: {},
        is_active: true,
        created_at: new Date('2026-06-01T10:00:00Z'),
        updated_at: new Date('2026-06-01T10:00:00Z'),
      });

      // 1. First fetch to obtain ETag
      const res1 = await request(app).get('/api/v1/customer/banners/active');
      expect(res1.status).toBe(200);
      const etag = res1.headers.etag;
      expect(etag).toBeDefined();

      // 2. Second fetch with If-None-Match header
      const res2 = await request(app)
        .get('/api/v1/customer/banners/active')
        .set('If-None-Match', etag);

      expect(res2.status).toBe(304);
      expect(res2.text).toBe('');
    });
  });
});
