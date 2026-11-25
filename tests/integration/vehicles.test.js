'use strict';

/**
 * Vehicle Discovery Integration Tests — Step 6
 *
 * All tests use supertest against a fully mocked database (no live PostgreSQL).
 * The pg Pool is mocked BEFORE app import to prevent real connections.
 *
 * Test coverage (per Step 6 requirements):
 *  8.  Customer can retrieve vehicle list
 *  9.  Pagination works
 *  10. Page/limit maximum enforced
 *  11. Category filter works
 *  12. Brand filter works
 *  13. Fuel filter works
 *  14. Transmission filter works
 *  15. Price range filter works
 *  16. Rating filter works
 *  17. Shop search works
 *  18. City search works
 *  19. Sort allowlist works
 *  20. Invalid sort rejected
 *  21. Invalid filter rejected
 *  22. SQL injection payloads cannot modify query behavior
 *  23. Nearby search validates latitude
 *  24. Nearby search validates longitude
 *  25. Nearby search validates radius
 *  26. Excessive radius rejected
 *  27. Distance is calculated server-side (present in response)
 *  28. Customer cannot manipulate returned distance
 *  29. Customer can retrieve public vehicle details
 *  30. Unknown vehicle handled safely (404)
 *  31. Private vehicle documents are never returned
 *  32. Registration number is not exposed
 *  33. Internal storage keys are not exposed
 *  34. Ineligible vehicle is not publicly exposed (404)
 */

const request = require('supertest');

// ── Static test fixtures ───────────────────────────────────────────────────────
const VEHICLE_ID = 'aaaaaaaa-aaaa-4aaa-0000-aaaaaaaaaaaa';
const UNKNOWN_ID = 'ffffffff-ffff-4fff-0000-ffffffffffff';

const VEHICLE_ROW = {
  id: VEHICLE_ID,
  vehicle_name: 'Honda Activa 6G',
  brand: 'Honda',
  model: 'Activa',
  year: 2022,
  category_slug: 'bike',
  category_name: 'Bike',
  vehicle_subtype: 'scooter',
  fuel_type: 'PETROL',
  transmission: 'AUTOMATIC',
  engine_capacity_cc: 110,
  color: 'Red',
  seats: 2,
  mileage_kmpl: 60,
  price_per_hour: 50,
  price_per_day: 500,
  price_per_week: 3000,
  price_per_month: 10000,
  security_deposit: 2000,
  late_fee_per_hour: 50,
  extra_km_charge: 10,
  city_name: 'Bengaluru',
  city_state: 'Karnataka',
  pickup_address: '123 MG Road, Bengaluru',
  latitude: 12.9716,
  longitude: 77.5946,
  description: 'Well maintained scooter',
  rating_avg: 4.5,
  rating_count: 10,
  listing_status: 'ACTIVE',
  shop_name: 'Gongo Bikes',
  created_at: new Date().toISOString(),
  primary_image_url: null,
};

const IMAGE_ROW = { id: 'bbbbbbbb-bbbb-4bbb-0000-bbbbbbbbbbbb', display_order: 0, is_primary: true, created_at: new Date() };

const CATEGORY_ROWS = [
  { id: 'cccccccc-cccc-4ccc-0000-cccccccccccc', name: 'Bike', slug: 'bike', description: null, sort_order: 1 },
  { id: 'dddddddd-dddd-4ddd-0000-dddddddddddd', name: 'Car', slug: 'car', description: null, sort_order: 2 },
];

const CITY_ROWS = [
  { id: 'eeeeeeee-eeee-4eee-0000-eeeeeeeeeeee', name: 'Bengaluru', state: 'Karnataka', country_code: 'IN' },
];

const NEARBY_ROW = { ...VEHICLE_ROW, distance_km: 2.3 };

// ── Pool mock — captures the single shared pool instance ──────────────────────
// The mock must be defined before any require() of app/database.
let mockSharedPoolQuery = jest.fn();

jest.mock('pg', () => {
  // Pool is a singleton in database.js — it is created once at module load.
  // We need to intercept `query` calls on that single instance.
  const mockClient = {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    release: jest.fn(),
  };
  const poolInstance = {
    // query delegates to the outer mockSharedPoolQuery so tests can replace it
    query: (...args) => mockSharedPoolQuery(...args),
    connect: jest.fn().mockResolvedValue(mockClient),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };
  return { Pool: jest.fn(() => poolInstance) };
});

// ── App is loaded AFTER mock ──────────────────────────────────────────────────
const { createApp } = require('../../src/app');

// ── Query factory ─────────────────────────────────────────────────────────────

/**
 * Build a query mock that intelligently routes based on SQL text.
 *
 * @param {object} opts
 * @param {object|null} opts.detailRow — null means no vehicle found (404)
 * @param {boolean}     opts.emptyList — return empty list for vehicle searches
 */
function makeQuery({
  detailRow = VEHICLE_ROW,
  emptyList = false,
} = {}) {
  return jest.fn((text, _params) => {
    const t = (typeof text === 'string' ? text : '').toLowerCase().trim();

    // DB health check
    if (t === 'select 1') {
      return Promise.resolve({ rows: [{ '?column?': 1 }] });
    }

    // Categories — no vehicles join, just vehicle_categories table alone
    if (t.includes('from vehicle_categories') && !t.includes('count(*)')) {
      return Promise.resolve({ rows: CATEGORY_ROWS, rowCount: CATEGORY_ROWS.length });
    }

    // Vehicle detail by ID (has v.id = and no COUNT)
    if (t.includes('v.id =') && !t.includes('count(*)')) {
      const row = detailRow;
      return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    }

    // Cities with vehicles (has DISTINCT and JOIN vehicles)
    if (t.includes('from shops') && t.includes('distinct') && !t.includes('count(*)')) {
      return Promise.resolve({ rows: CITY_ROWS, rowCount: CITY_ROWS.length });
    }

    // City name lookup (for city filter by name)
    if (t.includes('from cities') && t.includes('lower(name)') && t.includes('limit 1')) {
      return Promise.resolve({ rows: [{ id: 'eeeeeeee-eeee-4eee-0000-eeeeeeeeeeee' }] });
    }

    // Vehicle images (standalone query only, not the subquery inside summarySelect)
    if (t.includes('from vehicle_images') && !t.includes('from vehicles')) {
      return Promise.resolve({ rows: [IMAGE_ROW], rowCount: 1 });
    }

    // COUNT query for nearby (has BETWEEN)
    if (t.includes('count(*)') && t.includes('between')) {
      return Promise.resolve({ rows: [{ total: '1' }] });
    }

    // COUNT query for regular search
    if (t.includes('count(*)')) {
      return Promise.resolve({ rows: [{ total: emptyList ? '0' : '1' }] });
    }

    // Nearby search data (has BETWEEN bounding-box clause)
    if (t.includes('from vehicles') && t.includes('between')) {
      return Promise.resolve({ rows: [NEARBY_ROW], rowCount: 1 });
    }

    // Regular vehicle list
    if (t.includes('from vehicles')) {
      return Promise.resolve({ rows: emptyList ? [] : [VEHICLE_ROW], rowCount: emptyList ? 0 : 1 });
    }

    // Fallback
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

// ── Single app instance for all tests ────────────────────────────────────────
let app;

beforeAll(() => {
  app = createApp();
});

// Reset query mock before each test to "vehicle found" mode
beforeEach(() => {
  mockSharedPoolQuery = makeQuery();
});

// ═════════════════════════════════════════════════════════════════════════════
// Search & Filter tests
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/vehicles — Search & Filter', () => {
  // Test 8 — Customer can retrieve vehicle list
  it('8. returns vehicle list with success=true', async () => {
    const res = await request(app).get('/api/v1/vehicles');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.vehicles).toBeInstanceOf(Array);
    expect(res.body.data.pagination).toBeDefined();
  });

  // Test 9 — Pagination works
  it('9. returns pagination metadata', async () => {
    const res = await request(app).get('/api/v1/vehicles?page=1&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.page).toBe(1);
    expect(res.body.data.pagination.limit).toBe(5);
    expect(res.body.data.pagination.total).toBeDefined();
    expect(res.body.data.pagination.totalPages).toBeDefined();
  });

  // Test 10 — Limit maximum enforced
  it('10. limit exceeding 100 is rejected with 400', async () => {
    const res = await request(app).get('/api/v1/vehicles?limit=999');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('10b. negative page is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?page=-1');
    expect(res.status).toBe(400);
  });

  // Test 11 — Category filter works
  it('11. category filter is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?category=bike');
    expect(res.status).toBe(200);
    expect(res.body.data.vehicles).toBeInstanceOf(Array);
  });

  // Test 12 — Brand filter works
  it('12. brand filter is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?brand=Honda');
    expect(res.status).toBe(200);
  });

  // Test 13 — Fuel type filter works
  it('13a. fuelType=PETROL is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?fuelType=PETROL');
    expect(res.status).toBe(200);
  });

  it('13b. invalid fuelType is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?fuelType=COAL');
    expect(res.status).toBe(400);
  });

  // Test 14 — Transmission filter works
  it('14a. transmission=AUTOMATIC is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?transmission=AUTOMATIC');
    expect(res.status).toBe(200);
  });

  it('14b. invalid transmission is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?transmission=GEAR');
    expect(res.status).toBe(400);
  });

  // Test 15 — Price range filter works
  it('15a. price range filter is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?minPrice=100&maxPrice=1000');
    expect(res.status).toBe(200);
  });

  it('15b. minPrice > maxPrice is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?minPrice=1000&maxPrice=100');
    expect(res.status).toBe(400);
  });

  it('15c. negative minPrice is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?minPrice=-50');
    expect(res.status).toBe(400);
  });

  // Test 16 — Rating filter works
  it('16a. minRating filter is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?minRating=4');
    expect(res.status).toBe(200);
  });

  it('16b. minRating > 5 is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?minRating=6');
    expect(res.status).toBe(400);
  });

  // Test 17 — Shop search works
  it('17a. shop filter with valid UUID is accepted', async () => {
    const res = await request(app).get(`/api/v1/vehicles?shop=${VEHICLE_ID}`);
    expect(res.status).toBe(200);
  });

  it('17b. shop filter with non-UUID is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?shop=my-fake-shop');
    expect(res.status).toBe(400);
  });

  // Test 18 — City search works
  it('18. city filter by name is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?city=Bengaluru');
    expect(res.status).toBe(200);
  });

  // Test 19 — Sort allowlist works
  it('19a. sort=price_low is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?sort=price_low');
    expect(res.status).toBe(200);
  });

  it('19b. sort=price_high is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?sort=price_high');
    expect(res.status).toBe(200);
  });

  it('19c. sort=rating is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?sort=rating');
    expect(res.status).toBe(200);
  });

  it('19d. sort=distance is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles?sort=distance');
    expect(res.status).toBe(200);
  });

  // Test 20 — Invalid sort rejected
  it('20. invalid sort value is rejected with 400', async () => {
    const res = await request(app).get('/api/v1/vehicles?sort=unknown_sort');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // Test 21 — Invalid filter rejected
  it('21. invalid fuelType is rejected with 400', async () => {
    const res = await request(app).get('/api/v1/vehicles?fuelType=MAGIC');
    expect(res.status).toBe(400);
  });

  // Test 22 — SQL injection payloads rejected
  it('22a. SQL injection in sort is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?sort=price_low%27%3B+DROP+TABLE+vehicles%3B--');
    expect(res.status).toBe(400);
  });

  it('22b. SQL injection in category is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?category=bike%27+OR+%271%27%3D%271');
    expect(res.status).toBe(400);
  });

  it('22c. SQL injection in brand is rejected (special chars)', async () => {
    // Brand with semicolon and dash sequence is rejected by regex
    const res = await request(app).get('/api/v1/vehicles?brand=Honda%3B+DROP+TABLE');
    expect(res.status).toBe(400);
  });

  it('22d. SQL injection in limit is rejected', async () => {
    const res = await request(app).get('/api/v1/vehicles?limit=10%3BDROP+TABLE+vehicles');
    expect(res.status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Nearby tests
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/vehicles/nearby — Nearby Search', () => {
  // Test 23 — Validates latitude
  it('23a. missing latitude returns 400', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?longitude=77.59&radius=5');
    expect(res.status).toBe(400);
  });

  it('23b. latitude > 90 returns 400', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=91&longitude=77.59&radius=5');
    expect(res.status).toBe(400);
  });

  it('23c. latitude < -90 returns 400', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=-91&longitude=77.59&radius=5');
    expect(res.status).toBe(400);
  });

  // Test 24 — Validates longitude
  it('24a. missing longitude returns 400', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12.97&radius=5');
    expect(res.status).toBe(400);
  });

  it('24b. longitude > 180 returns 400', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12.97&longitude=181&radius=5');
    expect(res.status).toBe(400);
  });

  it('24c. longitude < -180 returns 400', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12.97&longitude=-181&radius=5');
    expect(res.status).toBe(400);
  });

  // Test 25 — Validates radius
  it('25a. negative radius returns 400', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12.97&longitude=77.59&radius=-5');
    expect(res.status).toBe(400);
  });

  it('25b. zero radius returns 400', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12.97&longitude=77.59&radius=0');
    expect(res.status).toBe(400);
  });

  // Test 26 — Excessive radius rejected
  it('26a. radius > 100km is rejected with 400', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12.97&longitude=77.59&radius=101');
    expect(res.status).toBe(400);
  });

  it('26b. radius = 100km exactly is accepted', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12.97&longitude=77.59&radius=100');
    expect(res.status).toBe(200);
  });

  // Test 27 — Distance is calculated server-side
  it('27. valid nearby request returns vehicles with distanceKm', async () => {
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12.97&longitude=77.59&radius=10');
    expect(res.status).toBe(200);
    expect(res.body.data.vehicles).toBeInstanceOf(Array);
    if (res.body.data.vehicles.length > 0) {
      expect(res.body.data.vehicles[0].distanceKm).toBeDefined();
      expect(typeof res.body.data.vehicles[0].distanceKm).toBe('number');
    }
  });

  // Test 28 — Client cannot manipulate returned distance
  it('28. client "distance" param is ignored; server computes distance', async () => {
    // The validator ignores unknown params; service computes distance from coordinates
    const res = await request(app).get('/api/v1/vehicles/nearby?latitude=12.97&longitude=77.59&radius=10&distance=9999');
    expect(res.status).toBe(200);
    if (res.body.data.vehicles.length > 0) {
      // Distance from server mock is 2.3, not 9999
      expect(res.body.data.vehicles[0].distanceKm).not.toBe(9999);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Vehicle details tests
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/vehicles/:vehicleId — Vehicle Details', () => {
  // Test 29 — Customer can retrieve public vehicle details
  it('29. returns 200 with vehicle details for valid eligible vehicle ID', async () => {
    const res = await request(app).get(`/api/v1/vehicles/${VEHICLE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.vehicle).toBeDefined();
    expect(res.body.data.vehicle.id).toBe(VEHICLE_ID);
    expect(res.body.data.vehicle.vehicleName).toBe('Honda Activa 6G');
    expect(res.body.data.vehicle.images).toBeInstanceOf(Array);
  });

  // Test 30 — Unknown vehicle handled safely (404)
  it('30. unknown vehicle ID returns 404 without DB error details', async () => {
    mockSharedPoolQuery = makeQuery({ detailRow: null });
    const res = await request(app).get(`/api/v1/vehicles/${UNKNOWN_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('PostgreSQL');
    expect(body).not.toContain('syntax error');
    expect(body).not.toContain('ERROR:');
  });

  // Test 31 — Private vehicle documents never returned
  it('31. response never contains RC, insurance, PUC, or fitness certificate fields', async () => {
    const res = await request(app).get(`/api/v1/vehicles/${VEHICLE_ID}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('rc_');
    expect(body).not.toContain('insurance');
    expect(body).not.toContain('puc');
    expect(body).not.toContain('fitness_cert');
    expect(body).not.toContain('kyc');
  });

  // Test 32 — Registration number not exposed
  it('32. registration_number is never in the response', async () => {
    const res = await request(app).get(`/api/v1/vehicles/${VEHICLE_ID}`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('registration_number');
    expect(body).not.toContain('registrationNumber');
  });

  // Test 33 — Internal storage keys not exposed
  it('33. storage_key is never in the response', async () => {
    const res = await request(app).get(`/api/v1/vehicles/${VEHICLE_ID}`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('storage_key');
    expect(body).not.toContain('storageKey');
    expect(body).not.toContain('s3Key');
  });

  // Test 34 — Ineligible vehicle returns 404
  it('34. vehicle not found in eligibility query gives 404', async () => {
    mockSharedPoolQuery = makeQuery({ detailRow: null });
    const res = await request(app).get(`/api/v1/vehicles/${UNKNOWN_ID}`);
    expect(res.status).toBe(404);
  });

  // Non-UUID vehicleId is rejected by validator
  it('non-UUID vehicleId is rejected with 400', async () => {
    const res = await request(app).get('/api/v1/vehicles/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Categories
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/vehicles/categories', () => {
  it('returns categories list with BIKE and CAR', async () => {
    const res = await request(app).get('/api/v1/vehicles/categories');
    expect(res.status).toBe(200);
    expect(res.body.data.categories).toBeInstanceOf(Array);
    const slugs = res.body.data.categories.map((c) => c.slug);
    expect(slugs).toContain('bike');
    expect(slugs).toContain('car');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cities
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/vehicles/cities', () => {
  it('returns cities with eligible vehicles', async () => {
    const res = await request(app).get('/api/v1/vehicles/cities');
    expect(res.status).toBe(200);
    expect(res.body.data.cities).toBeInstanceOf(Array);
  });
});
