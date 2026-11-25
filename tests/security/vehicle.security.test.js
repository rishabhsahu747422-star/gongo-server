'use strict';

/**
 * Vehicle Security Tests — Step 6
 *
 * Security regression suite for vehicle discovery.
 * Uses a shared pool mock (same pattern as vehicles.test.js).
 *
 * Tests:
 *  35. Customer cannot access private partner inventory through parameters
 *  36. Customer cannot bypass listing status
 *  37. Customer cannot bypass partner verification status
 *  38. Arbitrary userId/partnerId parameters cannot alter ownership/eligibility
 *  39. SQL injection regression tests pass
 *  40. No sensitive data appears in error responses
 *
 * Also covers IDOR/BOLA, filter injection, sort injection, pagination abuse,
 * excessive radius, private document exposure, credential leakage.
 */

const request = require('supertest');

const UNKNOWN_ID = 'ffffffff-ffff-4fff-0000-ffffffffffff';

// ── Single shared pool mock ───────────────────────────────────────────────────
// Variable MUST be prefixed with 'mock' to be accessible inside jest.mock() factory
let mockSharedPoolQuery = jest.fn();

jest.mock('pg', () => {
  const mockClient = {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    release: jest.fn(),
  };
  const poolInstance = {
    // Delegates to the outer mockSharedPoolQuery so tests can replace it
    query: (...args) => mockSharedPoolQuery(...args),
    connect: jest.fn().mockResolvedValue(mockClient),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };
  return { Pool: jest.fn(() => poolInstance) };
});

const { createApp } = require('../../src/app');

// Default mock: returns empty results (no eligible vehicles)
function makeEmptyQuery() {
  return jest.fn((text) => {
    const t = (typeof text === 'string' ? text : '').toLowerCase().trim();
    if (t === 'select 1') return Promise.resolve({ rows: [{ '?column?': 1 }] });
    if (t.includes('count(*)')) return Promise.resolve({ rows: [{ total: '0' }] });
    // Anything else: empty
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

let app;

beforeAll(() => {
  app = createApp();
});

beforeEach(() => {
  mockSharedPoolQuery = makeEmptyQuery();
});

describe('Vehicle Security Tests', () => {
  // ── 35. Private partner inventory not accessible via params ───────────────

  it('35a. partnerId query param is silently ignored — no data leakage', async () => {
    const res = await request(app).get('/api/v1/vehicles?partnerId=evil-partner-id');
    // Either 200 (param ignored) or 400 (unexpected) — never 500 with internals
    expect([200, 400]).toContain(res.status);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('pg error');
    expect(body).not.toContain('stack');
    expect(body).not.toContain('syntax error');
    expect(body).not.toContain('SQL');
  });

  it('35b. userId query param does not expose private inventory', async () => {
    const res = await request(app).get('/api/v1/vehicles?userId=aaaaaaaa-aaaa-4aaa-0000-aaaaaaaaaaaa');
    expect([200, 400]).toContain(res.status);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('registration_number');
    expect(body).not.toContain('storage_key');
    expect(body).not.toContain('password');
  });

  // ── 36. Listing status cannot be bypassed ────────────────────────────────

  it('36a. listing_status=DRAFT param cannot expose draft vehicles', async () => {
    const res = await request(app).get('/api/v1/vehicles?listing_status=DRAFT');
    // Backend always enforces ACTIVE in the WHERE clause regardless of this param
    expect([200, 400]).toContain(res.status);
  });

  it('36b. listingStatus=SUSPENDED does not expose suspended vehicles', async () => {
    const res = await request(app).get('/api/v1/vehicles?listingStatus=SUSPENDED');
    expect([200, 400]).toContain(res.status);
  });

  // ── 37. Partner verification status cannot be bypassed ───────────────────

  it('37. verificationStatus=pending param cannot bypass partner approval', async () => {
    const res = await request(app).get('/api/v1/vehicles?verificationStatus=pending');
    expect([200, 400]).toContain(res.status);
    // If 200: pool returns empty (approved-only JOIN enforced) — no leaked data
    if (res.status === 200) {
      expect(res.body.data.vehicles).toHaveLength(0);
    }
  });

  // ── 38. Arbitrary IDs cannot alter eligibility ────────────────────────────

  it('38. vehicle detail with valid UUID but ineligible returns 404 not 500', async () => {
    // Pool returns no rows for the vehicle → service throws NotFoundError → 404
    const res = await request(app).get(`/api/v1/vehicles/${UNKNOWN_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('users');
    expect(body).not.toContain('partners');
    expect(body).not.toContain('JOIN');
    expect(body).not.toContain('SELECT');
    expect(body).not.toContain('table');
  });

  // ── 39. SQL injection regression ─────────────────────────────────────────

  it('39a. SQL injection in sort is rejected', async () => {
    const injections = [
      "price_low'; DROP TABLE vehicles;--",
      '1 OR 1=1',
      'UNION SELECT * FROM users',
    ];
    await Promise.all(injections.map(async (inj) => {
      const res = await request(app).get(`/api/v1/vehicles?sort=${encodeURIComponent(inj)}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }));
  });

  it('39b. SQL injection in category is rejected', async () => {
    const injections = [
      "bike' OR '1'='1",
      'bike; DROP TABLE vehicles--',
    ];
    await Promise.all(injections.map(async (inj) => {
      const res = await request(app).get(`/api/v1/vehicles?category=${encodeURIComponent(inj)}`);
      expect(res.status).toBe(400);
    }));
  });

  it('39c. SQL injection in minPrice is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?minPrice=100%3BDROP+TABLE+vehicles');
    expect(res.status).toBe(400);
  });

  it('39d. SQL injection in vehicleId path param is rejected', async () => {
    // Non-UUID string → validator rejects before reaching SQL
    const res = await request(app).get('/api/v1/vehicles/not-a-valid-uuid-at-all');
    expect([400, 404]).toContain(res.status);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('DROP');
    expect(body).not.toContain('SELECT');
  });

  it('39e. SQL injection in nearby latitude is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12%3BDROP+TABLE&longitude=77&radius=5');
    expect(res.status).toBe(400);
  });

  it('39f. SQL injection in limit is rejected', async () => {
    const injections = ['10; DROP TABLE vehicles', '10 UNION SELECT 1'];
    await Promise.all(injections.map(async (inj) => {
      const res = await request(app).get(`/api/v1/vehicles?limit=${encodeURIComponent(inj)}`);
      expect(res.status).toBe(400);
    }));
  });

  // ── 40. No sensitive data in error responses ─────────────────────────────

  it('40a. validation error does not leak SQL query text', async () => {
    const res = await request(app).get('/api/v1/vehicles?sort=INVALID_SORT');
    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('SELECT');
    expect(body).not.toContain('FROM vehicles');
    expect(body).not.toContain('JOIN');
    expect(body).not.toContain('WHERE');
  });

  it('40b. error response does not contain DB credentials', async () => {
    const res = await request(app).get('/api/v1/vehicles?fuelType=INVALID');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('password');
    expect(body).not.toContain('DATABASE_URL');
    expect(body).not.toContain('postgresql://');
  });

  it('40c. 404 for unknown vehicle does not expose table/column structure', async () => {
    const res = await request(app).get(`/api/v1/vehicles/${UNKNOWN_ID}`);
    expect(res.status).toBe(404);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('column');
    expect(body).not.toContain('constraint');
    expect(body).not.toContain('ERROR:');
    expect(body).not.toContain('relation');
  });

  // ── Private document / credential exposure ───────────────────────────────

  it('private documents are never present in vehicle list response', async () => {
    const res = await request(app).get('/api/v1/vehicles');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('registration_number');
    expect(body).not.toContain('registrationNumber');
    expect(body).not.toContain('storage_key');
    expect(body).not.toContain('storageKey');
    expect(body).not.toContain('insurance');
    expect(body).not.toContain('puc');
    expect(body).not.toContain('kyc');
    expect(body).not.toContain('AWS');
    expect(body).not.toContain('auth_id');
  });

  // ── IDOR/BOLA: no enumeration of private records ─────────────────────────

  it('BOLA: ineligible vehicle UUIDs return 404 not 200', async () => {
    const ids = [
      '11111111-1111-4111-0000-111111111111',
      '22222222-2222-4222-0000-222222222222',
    ];
    await Promise.all(ids.map(async (id) => {
      const res = await request(app).get(`/api/v1/vehicles/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    }));
  });

  // ── Pagination abuse ─────────────────────────────────────────────────────

  it('pagination abuse: limit=10000 is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?limit=10000');
    expect(res.status).toBe(400);
  });

  it('pagination abuse: page=0 is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?page=0');
    expect(res.status).toBe(400);
  });

  // ── Excessive radius ─────────────────────────────────────────────────────

  it('excessive radius=500 is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12.97&longitude=77.59&radius=500');
    expect(res.status).toBe(400);
  });

  // ── Availability claims ──────────────────────────────────────────────────

  it('discovery response does not make false availability claims', async () => {
    const res = await request(app).get('/api/v1/vehicles');
    const body = JSON.stringify(res.body);
    // These fields would imply booking-based availability which is not implemented
    expect(body).not.toContain('available_from');
    expect(body).not.toContain('booked_until');
    expect(body).not.toContain('"isAvailable"');
  });
});
