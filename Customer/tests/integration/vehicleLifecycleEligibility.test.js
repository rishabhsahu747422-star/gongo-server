'use strict';

/**
 * Vehicle lifecycle exclusions for Customer discovery, availability and booking.
 *
 * Requirements covered:
 *   - archived (is_archived = true) and inactive (is_active = false, admin block/deactivate)
 *     vehicles are not listed (search / detail / nearby / cities) and not bookable;
 *   - admin-blocked vehicles (manual_status OFFLINE + is_active = false) accept no new bookings;
 *   - booking creation re-validates eligibility on the row locked inside the transaction;
 *   - historical bookings stay readable (booking history queries do not filter on lifecycle).
 *
 * Schema note: the Customer repo migrations model a legacy vehicles table (listing_status) with no
 * manual_status / is_archived / is_active columns, so the existing pg-mem suites only exercise the
 * legacy fallback queries. The live (Partner/Supabase) vehicles table has those columns;
 * `is_active` is guaranteed by Partner migration 049_add_vehicles_is_active. The pg-mem fixture
 * below models that live shape (including is_active) so the real primary SQL runs.
 *
 * pg-mem limitation: it cannot resolve outer-row references in correlated scalar subqueries
 * (e.g. the primary_image_url subquery in summarySelect / lockVehicleForBooking). Statements
 * containing them are covered by SQL-text assertions; statements without them (eligibility
 * lookup, discovery COUNT queries) are executed for real against pg-mem.
 */

const { newDb } = require('pg-mem');
const { pool } = require('../../src/config/database');
const BookingRepository = require('../../src/repositories/booking.repository');
const VehicleRepository = require('../../src/repositories/vehicle.repository');
const availabilityService = require('../../src/services/availability.service');
const { BookingService } = require('../../src/services/booking.service');

const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const SHOP_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

const V = {
  active: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  pendingOnline: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  legacyNullActive: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  archived: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  inactiveOnline: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  blocked: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
  offline: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
};
const EXCLUDED = [V.archived, V.inactiveOnline, V.blocked, V.offline];

function buildLiveLikeDb() {
  const db = newDb();
  db.public.none(`
    CREATE TABLE partners (
      id UUID PRIMARY KEY, verification_status TEXT, kyc_status TEXT, is_active BOOLEAN,
      status TEXT, partner_status TEXT, rating NUMERIC, review_count INT
    );
    CREATE TABLE cities (id UUID PRIMARY KEY, name TEXT);
    CREATE TABLE shops (
      id UUID PRIMARY KEY, partner_id UUID, is_active BOOLEAN, name TEXT, shop_name TEXT,
      city TEXT, city_id UUID, address_line1 TEXT, shop_address TEXT,
      latitude NUMERIC, longitude NUMERIC
    );
    CREATE TABLE vehicle_categories (id UUID PRIMARY KEY, code TEXT, name TEXT, is_active BOOLEAN);
    CREATE TABLE vehicle_brands (id UUID PRIMARY KEY, name TEXT);
    CREATE TABLE vehicle_models (id UUID PRIMARY KEY, brand_id UUID, category_id UUID, name TEXT);
    CREATE TABLE vehicles (
      id UUID PRIMARY KEY, partner_id UUID, shop_id UUID, model_id UUID, category TEXT,
      brand TEXT, model TEXT, fuel_type TEXT, transmission TEXT, status TEXT,
      verification_status TEXT, manual_status TEXT, is_archived BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true, is_available BOOLEAN, latitude NUMERIC, longitude NUMERIC,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE vehicle_pricing (
      vehicle_id UUID, is_active BOOLEAN, price NUMERIC, price_per_hour NUMERIC,
      price_per_day NUMERIC, security_deposit NUMERIC, extra_km_charge NUMERIC
    );
    CREATE TABLE bookings (
      id UUID PRIMARY KEY, vehicle_id UUID, customer_id UUID, status TEXT, booking_status TEXT,
      start_at TIMESTAMPTZ, end_at TIMESTAMPTZ
    );
  `);
  db.public.none(`
    INSERT INTO partners VALUES ('${PARTNER_ID}', 'approved', 'VERIFIED', true, 'active', 'ONLINE', 4.5, 3);
    INSERT INTO shops VALUES ('${SHOP_ID}', '${PARTNER_ID}', true, 'Hub', 'Hub', 'Bhopal', NULL, 'Addr', NULL, 23.2599, 77.4126);
  `);
  const rows = [
    // id, status, verification, manual_status, is_archived, is_active
    [V.active, 'active', 'VERIFIED', 'ONLINE', 'false', 'true'],
    [V.pendingOnline, 'pending', 'PENDING', 'ONLINE', 'false', 'true'],
    [V.legacyNullActive, 'active', 'VERIFIED', 'ONLINE', 'false', 'NULL'],
    [V.archived, 'active', 'VERIFIED', 'ONLINE', 'true', 'false'],
    [V.inactiveOnline, 'active', 'VERIFIED', 'ONLINE', 'false', 'false'],
    [V.blocked, 'active', 'VERIFIED', 'OFFLINE', 'false', 'false'],
    [V.offline, 'active', 'VERIFIED', 'OFFLINE', 'false', 'true'],
  ];
  rows.forEach(([id, status, verification, manual, archived, active]) => {
    db.public.none(`
      INSERT INTO vehicles (id, partner_id, shop_id, category, brand, model, fuel_type, transmission,
        status, verification_status, manual_status, is_archived, is_active, latitude, longitude)
      VALUES ('${id}', '${PARTNER_ID}', '${SHOP_ID}', 'bike', 'Honda', 'Activa', 'PETROL', 'MANUAL',
        '${status}', '${verification}', '${manual}', ${archived}, ${active}, 23.2599, 77.4126);
      INSERT INTO vehicle_pricing VALUES ('${id}', true, 500, 50, 500, 1000, 10);
    `);
  });
  return db;
}

describe('Customer vehicle lifecycle exclusions (archived / inactive / blocked)', () => {
  let db;
  let mockPool;
  const originalQuery = pool.query;
  const originalConnect = pool.connect;

  beforeAll(() => {
    db = buildLiveLikeDb();
    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);
  });

  afterAll(async () => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    if (mockPool) await mockPool.end();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Availability: real findVehicleEligibility SQL on pg-mem ───────────────
  describe('availability (findVehicleEligibility + assertVehicleEligibility, real SQL)', () => {
    const startAt = '2026-11-20T10:00:00Z';
    const endAt = '2026-11-20T12:00:00Z';

    it('the primary eligibility query runs and returns is_active / is_archived / manual_status', async () => {
      const repo = new BookingRepository();
      const row = await repo.findVehicleEligibility(V.inactiveOnline);
      expect(row).toEqual(expect.objectContaining({
        id: V.inactiveOnline, is_active: false, is_archived: false, manual_status: 'ONLINE',
      }));
    });

    it.each([
      ['archived', V.archived],
      ['inactive (is_active=false) even though manual_status is ONLINE', V.inactiveOnline],
      ['admin-blocked (OFFLINE + is_active=false)', V.blocked],
      ['manually OFFLINE', V.offline],
    ])('reports a %s vehicle as unavailable', async (_label, id) => {
      const res = await availabilityService.checkAvailability(id, startAt, endAt);
      expect(res.isAvailable).toBe(false);
    });

    it.each([
      ['active VERIFIED', V.active],
      ['legacy row with is_active NULL (treated as active)', V.legacyNullActive],
      ['PENDING + ONLINE (existing PENDING policy unchanged)', V.pendingOnline],
    ])('reports a %s vehicle as available', async (_label, id) => {
      const res = await availabilityService.checkAvailability(id, startAt, endAt);
      expect(res).toEqual({ isAvailable: true });
    });
  });

  // ── Discovery: real COUNT SQL on pg-mem + SQL-text checks ─────────────────
  describe('discovery (search / detail / nearby / cities)', () => {
    it('search COUNT query (real SQL) excludes archived, inactive, blocked and OFFLINE vehicles', async () => {
      const repo = new VehicleRepository();
      const executed = [];
      const realQuery = repo.query.bind(repo);
      jest.spyOn(repo, 'query').mockImplementation(async (text, params) => {
        executed.push({ text, params });
        // The data query embeds a correlated subquery pg-mem cannot evaluate: short-circuit it.
        if (/vehicle_candidates/.test(text)) return { rows: [] };
        return realQuery(text, params);
      });

      const { total } = await repo.searchVehicles({ page: 1, limit: 20 });

      expect(total).toBe(3); // active, pendingOnline, legacyNullActive
      const countSql = executed.find((q) => /COUNT\(DISTINCT v\.id\)/.test(q.text)).text;
      expect(countSql).toContain('(v.is_active IS NOT FALSE)');
      expect(countSql).toContain('(v.is_archived IS NOT TRUE)');

      // Same WHERE clause, but list the ids so each exclusion is asserted individually.
      const where = countSql.slice(countSql.indexOf('WHERE'));
      const listSql = `SELECT DISTINCT v.id FROM vehicles v ${VehicleRepository.eligibilityJoins()} ${where}`;
      const { rows } = await pool.query(listSql, executed[0].params);
      const ids = rows.map((r) => r.id);
      expect(ids.sort()).toEqual([V.active, V.pendingOnline, V.legacyNullActive].sort());
      EXCLUDED.forEach((id) => expect(ids).not.toContain(id));
    });

    it('nearby, detail and cities SQL carry the same lifecycle filters', async () => {
      const repo = new VehicleRepository();
      const texts = [];
      jest.spyOn(repo, 'query').mockImplementation(async (text) => {
        texts.push(text);
        return { rows: [{ total: '0' }] };
      });

      await repo.findNearby({ latitude: 23.25, longitude: 77.41, radiusKm: 10, page: 1, limit: 10 });
      await repo.findByIdPublic(V.active);
      await repo.findCitiesWithVehicles();

      const nearby = texts.filter((t) => /BETWEEN \$4 AND \$5/.test(t));
      const detail = texts.find((t) => /WHERE v\.id = \$2/.test(t));
      const cities = texts.find((t) => /FROM shops sh\s+JOIN vehicles v/.test(t));
      expect(nearby).toHaveLength(2); // count + data
      [...nearby, detail, cities].forEach((sql) => {
        expect(sql).toContain('(v.is_active IS NOT FALSE)');
        expect(sql).toContain('(v.is_archived IS NOT TRUE)');
        expect(sql).toMatch(/UPPER\(v\.manual_status\) != 'OFFLINE'/);
      });
    });

    it('nearby COUNT predicate (real SQL WHERE, distance terms dropped) excludes the same vehicles', async () => {
      const repo = new VehicleRepository();
      let countSql = null;
      jest.spyOn(repo, 'query').mockImplementation(async (text) => {
        if (!countSql) countSql = text;
        return { rows: [{ total: '0' }] };
      });
      await repo.findNearby({ latitude: 23.25, longitude: 77.41, radiusKm: 10, page: 1, limit: 10 });

      // Keep only the lifecycle/eligibility predicates (pg-mem lacks ACOS/RADIANS).
      const lifecycle = countSql
        .slice(countSql.indexOf('WHERE') + 'WHERE'.length)
        .split(/\s+AND\s+(?=\(v\.|COALESCE)/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith('(v.'));
      expect(lifecycle).toEqual(expect.arrayContaining(['(v.is_active IS NOT FALSE)', '(v.is_archived IS NOT TRUE)']));
      const { rows } = await pool.query(
        `SELECT v.id FROM vehicles v ${VehicleRepository.eligibilityJoins()} WHERE ${lifecycle.join(' AND ')}`,
        [['approved', 'verified']],
      );
      const ids = rows.map((r) => r.id);
      EXCLUDED.forEach((id) => expect(ids).not.toContain(id));
      expect(ids).toContain(V.active);
    });
  });

  // ── Booking creation re-validates eligibility on the locked row ───────────
  describe('booking creation (eligibility re-checked inside the locking transaction)', () => {
    const lockedRowBase = {
      id: V.active,
      partner_id: PARTNER_ID,
      shop_id: SHOP_ID,
      listing_status: 'active',
      manual_status: 'ONLINE',
      is_archived: false,
      is_active: true,
      price_per_hour: 50,
      price_per_day: 500,
      security_deposit: 1000,
      shop_active: true,
      partner_lifecycle_status: 'active',
      partner_operational_status: 'ONLINE',
      partner_status: 'approved',
      partner_active: true,
    };

    function makeService(lockedRow, calls, overlapRow = null) {
      const client = {
        query: jest.fn(async (text) => {
          calls.push(/FROM bookings/.test(text) ? 'overlap-check' : 'query');
          return { rows: overlapRow ? [overlapRow] : [] };
        }),
      };
      const bookingRepository = {
        transaction: jest.fn(async (cb) => cb(client)),
        lockVehicleForBooking: jest.fn(async () => {
          calls.push('lock');
          return lockedRow;
        }),
        create: jest.fn(),
      };
      const idempotencyRepository = { findKey: jest.fn().mockResolvedValue(null) };
      return {
        service: new BookingService({ bookingRepository, idempotencyRepository, documentRepository: {} }),
        bookingRepository,
      };
    }

    const bookingData = {
      vehicleId: V.active,
      rentalType: 'HOURLY',
      startAt: '2026-11-20T10:00:00Z',
      endAt: '2026-11-20T12:00:00Z',
    };

    it.each([
      ['archived', { is_archived: true }],
      ['inactive (is_active=false)', { is_active: false }],
      ['admin-blocked (OFFLINE + is_active=false)', { manual_status: 'OFFLINE', is_active: false }],
      ['OFFLINE', { manual_status: 'OFFLINE' }],
    ])('refuses a new booking for a %s vehicle after locking it, without inserting', async (_label, overrides) => {
      const calls = [];
      const { service, bookingRepository } = makeService({ ...lockedRowBase, ...overrides }, calls);
      const assertSpy = jest.spyOn(availabilityService, 'assertVehicleEligibility');

      await expect(service.createBooking(CUSTOMER_ID, bookingData)).rejects.toMatchObject({
        code: 'VEHICLE_DEACTIVATED',
      });
      expect(bookingRepository.transaction).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(['lock']); // locked first; overlap check / insert never reached
      expect(assertSpy).toHaveBeenCalledWith(expect.objectContaining({ id: V.active }));
      expect(bookingRepository.create).not.toHaveBeenCalled();
    });

    it('an eligible locked vehicle passes the lifecycle check and proceeds to the overlap check', async () => {
      const calls = [];
      const { service, bookingRepository } = makeService(
        { ...lockedRowBase, is_active: null },
        calls,
        { id: 'existing', status: 'confirmed' },
      );

      await expect(service.createBooking(CUSTOMER_ID, bookingData)).rejects.toMatchObject({
        code: 'BOOKING_VEHICLE_UNAVAILABLE',
      });
      expect(calls).toEqual(['lock', 'overlap-check']);
      expect(bookingRepository.create).not.toHaveBeenCalled();
    });

    it('lockVehicleForBooking SQL locks the vehicle row and selects the lifecycle columns', async () => {
      const repo = new BookingRepository();
      const client = { query: jest.fn().mockResolvedValue({ rows: [lockedRowBase] }) };
      await repo.lockVehicleForBooking(V.active, client);
      const sql = client.query.mock.calls[0][0];
      expect(sql).toMatch(/FOR UPDATE OF v/);
      expect(sql).toMatch(/v\.manual_status,\s+v\.is_archived,\s+v\.is_active,/);
    });
  });

  // ── History stays accessible ───────────────────────────────────────────────
  describe('historical bookings', () => {
    it('booking history/detail queries do not filter on vehicle lifecycle state', async () => {
      const repo = new BookingRepository();
      const texts = [];
      jest.spyOn(repo, 'query').mockImplementation(async (text) => {
        texts.push(text);
        return { rows: [], rowCount: 0 };
      });

      await repo.findByIdAndCustomerId('cccccccc-cccc-4ccc-8ccc-cccccccccccc', CUSTOMER_ID).catch(() => null);
      await repo.findByCustomerId(CUSTOMER_ID, {}).catch(() => null);

      const historySql = texts.filter((t) => /FROM bookings b/.test(t));
      expect(historySql.length).toBeGreaterThan(0);
      historySql.forEach((sql) => {
        expect(sql).not.toMatch(/is_archived/);
        expect(sql).not.toMatch(/v\.is_active/);
        expect(sql).not.toMatch(/manual_status/);
      });
    });

    it('availability for an archived vehicle is refused while its row (and bookings) remain readable', async () => {
      const repo = new BookingRepository();
      const row = await repo.findVehicleEligibility(V.archived);
      expect(row).not.toBeNull();
      expect(row.is_archived).toBe(true);
      expect(() => availabilityService.assertVehicleEligibility(row)).toThrow(/deactivated/);
    });
  });
});
