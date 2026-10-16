'use strict';

const vehicleRepository = require('../../src/repositories/vehicle.repository');

describe('Unit: VehicleRepository - getVehicleRentalHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null if vehicle not found for partner', async () => {
    jest.spyOn(vehicleRepository, 'query').mockResolvedValueOnce({ rows: [] });

    const res = await vehicleRepository.getVehicleRentalHistory('v-1', 'p-1');
    expect(res).toBeNull();
  });

  it('correctly executes historySql joining booking_pickup_verifications and returns history and bookings arrays', async () => {
    const mockVehicle = {
      id: 'v-1',
      brand: 'Royal Enfield',
      model: 'Classic 350',
      registration_number: 'KA01AB1234',
      manual_status: 'AVAILABLE',
      rental_status: 'IDLE',
    };

    const mockBookingRows = [
      {
        id: 'b-1',
        booking_number: 'BK-101',
        booking_status: 'COMPLETED',
        customer_name: 'Rohit Sharma',
        customer_phone: '+919999988888',
        start_at: '2026-09-20T10:00:00.000Z',
        expected_return_at: '2026-09-20T18:00:00.000Z',
        actual_pickup_at: '2026-09-20T10:05:00.000Z',
        actual_return_at: '2026-09-20T18:15:00.000Z',
        total_amount: '1200.00',
        created_at: '2026-09-19T10:00:00.000Z',
        odometer_end: 1250,
        late_minutes: 15,
        late_fee: '50.00',
        extra_km: 10,
        extra_km_fee: '100.00',
        return_status: 'LATE',
        total_distance: 75,
        earnings: '950.00',
      },
    ];

    const querySpy = jest.spyOn(vehicleRepository, 'query')
      .mockResolvedValueOnce({ rows: [mockVehicle] })
      .mockResolvedValueOnce({ rows: mockBookingRows });

    const res = await vehicleRepository.getVehicleRentalHistory('v-1', 'p-1');

    expect(querySpy).toHaveBeenCalledTimes(2);
    const historyQuery = querySpy.mock.calls[1][0];
    expect(historyQuery).toContain('booking_pickup_verifications bpv');
    expect(historyQuery).toContain('bpv.verified_at AS actual_pickup_at');
    expect(historyQuery).toContain('brv.returned_at AS actual_return_at');

    expect(res.vehicle.id).toBe('v-1');
    expect(res.vehicle.totalTrips).toBe(1);
    expect(res.vehicle.totalEarnings).toBe(950.00);

    // Verify history array
    expect(res.history).toHaveLength(1);
    expect(res.history[0].bookingNumber).toBe('BK-101');
    expect(res.history[0].handoverAt).toBe('2026-09-20T10:05:00.000Z');
    expect(res.history[0].returnedAt).toBe('2026-09-20T18:15:00.000Z');
    expect(res.history[0].durationMinutes).toBe(490);
    expect(res.history[0].earnings).toBe(950.00);

    // Verify bookings array compatibility for VehicleHistoryScreen
    expect(res.bookings).toBeDefined();
    expect(res.bookings).toHaveLength(1);
    expect(res.bookings[0].actualReturnAt).toBe('2026-09-20T18:15:00.000Z');
    expect(res.bookings[0].earningsAmount).toBe(950.00);
    expect(res.bookings[0].totalDistance).toBe(75);
    expect(res.bookings[0].rentalStatus).toBe('COMPLETED');
  });

  it('handles empty history gracefully', async () => {
    const mockVehicle = {
      id: 'v-2',
      brand: 'Honda',
      model: 'Activa 6G',
      registration_number: 'KA02CD5678',
      manual_status: 'AVAILABLE',
      rental_status: 'IDLE',
    };

    jest.spyOn(vehicleRepository, 'query')
      .mockResolvedValueOnce({ rows: [mockVehicle] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await vehicleRepository.getVehicleRentalHistory('v-2', 'p-1');
    expect(res.vehicle.id).toBe('v-2');
    expect(res.vehicle.totalTrips).toBe(0);
    expect(res.vehicle.totalEarnings).toBe(0);
    expect(res.history).toEqual([]);
    expect(res.bookings).toEqual([]);
  });
});

describe('Unit: VehicleRepository - admin block/deactivate guards (AD-2)', () => {
  beforeEach(() => {
    // Discard any queued mockResolvedValueOnce values left by the suite above.
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('updateStatus SQL atomically refuses ONLINE for archived or admin-blocked (is_active = false) vehicles', async () => {
    const querySpy = jest.spyOn(vehicleRepository, 'query').mockResolvedValue({ rows: [] });

    const res = await vehicleRepository.updateStatus('v-1', 'p-1', 'ONLINE', null);

    expect(res).toBeNull();
    const [sql, values] = querySpy.mock.calls[0];
    expect(sql).toMatch(/\(\$3 <> 'ONLINE' OR is_archived IS NOT TRUE\)/);
    expect(sql).toMatch(/\(\$3 <> 'ONLINE' OR COALESCE\(\(to_jsonb\(vehicles\) ->> 'is_active'\)::boolean, true\)\)/);
    expect(values).toEqual(['v-1', 'p-1', 'ONLINE', null]);
  });

  it('updateStatus uses the supplied transaction client when given', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'v-1' }] }) };
    const res = await vehicleRepository.updateStatus('v-1', 'p-1', 'OFFLINE', 'Service', client);
    expect(res).toEqual({ id: 'v-1' });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('findByIdAndPartnerId exposes is_active so the service-level AD-2 guard can see admin blocks', async () => {
    const querySpy = jest.spyOn(vehicleRepository, 'query').mockResolvedValue({ rows: [{ id: 'v-1', is_active: false }] });

    const row = await vehicleRepository.findByIdAndPartnerId('v-1', 'p-1');

    expect(querySpy.mock.calls[0][0]).toMatch(/\(to_jsonb\(v\) ->> 'is_active'\)::boolean AS is_active/);
    expect(row.is_active).toBe(false);
  });

  it('updateStatus SQL atomically requires eligible verification (VERIFIED/APPROVED/PENDING/UNDER_REVIEW) for ONLINE', async () => {
    const querySpy = jest.spyOn(vehicleRepository, 'query').mockResolvedValue({ rows: [] });

    await vehicleRepository.updateStatus('v-1', 'p-1', 'ONLINE', null);

    const [sql] = querySpy.mock.calls[0];
    expect(sql).toMatch(
      /\(\$3 <> 'ONLINE' OR UPPER\(COALESCE\(verification_status, ''\)\) IN \('VERIFIED', 'APPROVED', 'PENDING', 'UNDER_REVIEW'\)\)/,
    );
  });

  it('createVehicle defaults manual_status to ONLINE when no status is supplied', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'v-new' }] }) };
    await vehicleRepository.createVehicle({
      partnerId: 'p-1',
      category: 'Car',
      brand: 'Honda',
      model: 'City',
      registrationNumber: 'MP04AB1234',
      year: 2023,
      fuelType: 'Petrol',
      vehicleReference: 'VEH-TEST01',
    }, client);

    const values = client.query.mock.calls[0][1];
    expect(values[13]).toBe('ONLINE'); // manual_status
    expect(values[15]).toBe('PENDING'); // verification_status
  });
});

describe('Unit: VehicleRepository - status guards against pg-mem (real SQL)', () => {
  // pg-mem has no built-in to_jsonb(record). It is registered here with Postgres semantics
  // (row -> JSON object of its columns; a missing key yields NULL), so the production SQL text
  // runs unchanged. This is a harness shim: it proves the WHERE logic, not pg-mem parity.
  const { newDb, DataType } = require('pg-mem');

  async function setup({ withIsActive }) {
    const db = newDb();
    db.public.registerFunction({
      name: 'to_jsonb',
      args: [DataType.record],
      returns: DataType.jsonb,
      implementation: (row) => row,
    });
    db.public.none(`
      CREATE TABLE vehicles (
        id TEXT PRIMARY KEY, vehicle_reference TEXT, partner_id TEXT NOT NULL, shop_id TEXT,
        category TEXT, brand TEXT, model TEXT, variant TEXT, registration_number TEXT,
        year INT, fuel_type TEXT, transmission TEXT, seats INT, description TEXT,
        pickup_location TEXT, manual_status VARCHAR(20) DEFAULT 'OFFLINE', rental_status VARCHAR(20) DEFAULT 'IDLE',
        verification_status VARCHAR(30) DEFAULT 'PENDING', rejection_reason TEXT,
        is_archived BOOLEAN DEFAULT false, offline_reason TEXT, primary_image_url TEXT,
        ${withIsActive ? 'is_active BOOLEAN DEFAULT true,' : ''}
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE vehicle_pricing (
        vehicle_id TEXT, price_per_hour NUMERIC, price_3_hours NUMERIC, price_6_hours NUMERIC,
        price_12_hours NUMERIC, price_per_4_hours NUMERIC, price_per_day NUMERIC,
        security_deposit NUMERIC, extra_km_charge NUMERIC, currency TEXT, is_active BOOLEAN
      );
      CREATE TABLE bookings (
        id TEXT PRIMARY KEY, vehicle_id TEXT, booking_status TEXT, status TEXT,
        total_amount NUMERIC, subtotal NUMERIC
      );
      CREATE TABLE earnings (booking_id TEXT, partner_net_amount NUMERIC);
      CREATE TABLE booking_pricing_snapshots (booking_id TEXT, total_customer_amount NUMERIC);
      CREATE TABLE ratings (
        id TEXT, booking_id TEXT, vehicle_id TEXT, target_type TEXT, status TEXT, rating_score NUMERIC
      );
    `);
    const { Client } = db.adapters.createPg();
    const client = new Client();
    await client.connect();
    const insert = (id, cols) => {
      const row = {
        id, partner_id: 'p-1', manual_status: 'OFFLINE', rental_status: 'IDLE', is_archived: false, ...cols,
      };
      const keys = Object.keys(row);
      db.public.none(
        `INSERT INTO vehicles (${keys.join(', ')}) VALUES (${keys.map((k) => {
          const v = row[k];
          if (v === null) return 'NULL';
          if (typeof v === 'boolean') return v ? 'true' : 'false';
          return `'${v}'`;
        }).join(', ')})`,
      );
    };
    return { db, client, insert };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // HARNESS LIMITATION: the full findByIdAndPartnerId statement cannot run on pg-mem because pg-mem
  // does not resolve outer-row references inside correlated scalar subqueries (it fails with
  // `column "v.id" does not exist` on the earnings/bookings/ratings subqueries). Its is_active
  // projection is covered by the SQL-text test above; the identical schema-tolerant expression is
  // executed here as a projection so its NULL-when-absent semantics are still exercised.
  it('the findByIdAndPartnerId is_active projection maps false / NULL-when-column-absent', async () => {
    const withCol = await setup({ withIsActive: true });
    withCol.insert('v-blocked', { verification_status: 'VERIFIED', is_active: false });
    const projection = "SELECT (to_jsonb(v) ->> 'is_active')::boolean AS is_active FROM vehicles v WHERE v.id = $1";
    expect((await withCol.client.query(projection, ['v-blocked'])).rows[0].is_active).toBe(false);

    const noCol = await setup({ withIsActive: false });
    noCol.insert('v-legacy', { verification_status: 'VERIFIED' });
    expect((await noCol.client.query(projection, ['v-legacy'])).rows[0].is_active).toBeNull();
  });

  it.each([
    ['REJECTED', { verification_status: 'REJECTED' }],
    ['NULL verification', { verification_status: null }],
    ['archived', { verification_status: 'VERIFIED', is_archived: true }],
    ['admin-blocked (is_active=false)', { verification_status: 'VERIFIED', is_active: false }],
  ])('updateStatus refuses ONLINE for a %s vehicle (no row updated, state unchanged)', async (_label, cols) => {
    const { client, insert, db } = await setup({ withIsActive: true });
    insert('v-1', cols);

    const res = await vehicleRepository.updateStatus('v-1', 'p-1', 'ONLINE', null, client);

    expect(res).toBeNull();
    expect(db.public.one("SELECT manual_status FROM vehicles WHERE id = 'v-1'").manual_status).toBe('OFFLINE');
  });

  it.each(['VERIFIED', 'approved', 'Verified', 'PENDING', 'pending', 'UNDER_REVIEW'])(
    'updateStatus sets ONLINE for an active, non-archived %p vehicle',
    async (verificationStatus) => {
      const { client, insert } = await setup({ withIsActive: true });
      insert('v-1', { verification_status: verificationStatus, is_active: true });

      const res = await vehicleRepository.updateStatus('v-1', 'p-1', 'ONLINE', null, client);

      expect(res).not.toBeNull();
      expect(res.manual_status).toBe('ONLINE');
    },
  );

  it('updateStatus treats a missing is_active column as active (schema-tolerant) but still respects verification', async () => {
    const { client, insert } = await setup({ withIsActive: false });
    insert('v-ok', { verification_status: 'VERIFIED' });
    insert('v-rejected', { verification_status: 'REJECTED' });

    expect((await vehicleRepository.updateStatus('v-ok', 'p-1', 'ONLINE', null, client)).manual_status).toBe('ONLINE');
    expect(await vehicleRepository.updateStatus('v-rejected', 'p-1', 'ONLINE', null, client)).toBeNull();
  });

  it('updateStatus always allows OFFLINE (even for blocked/rejected) and never touches another partner\'s row', async () => {
    const { client, insert } = await setup({ withIsActive: true });
    insert('v-1', { verification_status: 'REJECTED', is_active: false, manual_status: 'ONLINE' });

    const res = await vehicleRepository.updateStatus('v-1', 'p-1', 'OFFLINE', 'Service', client);
    expect(res.manual_status).toBe('OFFLINE');
    expect(res.offline_reason).toBe('Service');
    expect(res.rejection_reason).toBeNull();

    expect(await vehicleRepository.updateStatus('v-1', 'p-other', 'OFFLINE', null, client)).toBeNull();
  });

  it('concurrent admin block/reject between the service read and the write: the guarded UPDATE matches no row', async () => {
    const { client, insert, db } = await setup({ withIsActive: true });
    insert('v-1', { verification_status: 'VERIFIED', is_active: true });

    // Service-level read sees an eligible vehicle...
    const read = db.public.one("SELECT verification_status, is_active FROM vehicles WHERE id = 'v-1'");
    expect(read).toEqual({ verification_status: 'VERIFIED', is_active: true });
    // ...then an admin rejects it before the partner's write lands.
    db.public.none("UPDATE vehicles SET verification_status = 'REJECTED' WHERE id = 'v-1'");
    expect(await vehicleRepository.updateStatus('v-1', 'p-1', 'ONLINE', null, client)).toBeNull();

    db.public.none("UPDATE vehicles SET verification_status = 'VERIFIED', is_active = false WHERE id = 'v-1'");
    expect(await vehicleRepository.updateStatus('v-1', 'p-1', 'ONLINE', null, client)).toBeNull();
  });
});
