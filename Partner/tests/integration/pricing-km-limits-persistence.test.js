/**
 * Integration Test: Vehicle Duration Pricing & KM Limits Persistence
 *
 * Verifies end-to-end data flow:
 * - 5 pricing durations (1h, 3h, 6h, 12h, 24h / 1 Day)
 * - 5 independent KM limits (1h, 3h, 6h, 12h, 24h / 1 Day)
 * - Security Deposit & Extra KM charge
 * - Persistence in vehicle_pricing & vehicle_pricing_history
 * - Vehicle details retrieval
 * - Editing vehicle without erasing KM limits
 */

const { newDb, DataType } = require('pg-mem');
const { v4: uuidv4 } = require('uuid');

const vehicleService = require('../../src/services/vehicle.service');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const pricingService = require('../../src/services/pricing.service');
const partnerPool = require('../../src/db/pool');

describe('Vehicle Duration Pricing & KM Limits Persistence Test Suite', () => {
  let db;
  let mockPool;

  const PARTNER_ID = '11111111-1111-4111-a111-111111111111';
  const USER_ID = '22222222-2222-4222-a222-222222222222';
  const SHOP_ID = '33333333-3333-4333-a333-333333333333';

  beforeAll(async () => {
    db = newDb();

    db.public.registerFunction({
      name: 'gen_random_uuid',
      implementation: () => uuidv4(),
      impure: true,
    });

    db.public.registerFunction({
      name: 'version',
      args: [],
      returns: db.public.getType('text'),
      implementation: () => 'PostgreSQL 15.0 (pg-mem)',
    });

    db.public.registerFunction({
      name: 'trim',
      args: [db.public.getType('text')],
      returns: db.public.getType('text'),
      implementation: (str) => (str == null ? null : String(str).trim()),
    });

    db.public.registerFunction({
      name: 'to_jsonb',
      args: [DataType.record],
      returns: DataType.jsonb,
      implementation: (row) => row,
    });

    db.public.registerFunction({
      name: 'random',
      implementation: () => Math.random(),
    });

    db.public.registerFunction({
      name: 'md5',
      args: [db.public.getType('text')],
      returns: db.public.getType('text'),
      implementation: (str) => require('crypto').createHash('md5').update(str).digest('hex'),
    });

    db.public.registerFunction({
      name: 'substr',
      args: [db.public.getType('text'), db.public.getType('integer'), db.public.getType('integer')],
      returns: db.public.getType('text'),
      implementation: (str, start, len) => str.substr(start - 1, len),
    });

    db.public.none(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        phone VARCHAR(20),
        role VARCHAR(20) DEFAULT 'PARTNER',
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE partners (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        shop_id UUID,
        partner_id_display VARCHAR(50),
        referral_code VARCHAR(50),
        business_name VARCHAR(150),
        business_address TEXT,
        city VARCHAR(100),
        status VARCHAR(30) DEFAULT 'VERIFIED',
        kyc_status VARCHAR(30) DEFAULT 'approved',
        account_status VARCHAR(30) DEFAULT 'active',
        manual_status VARCHAR(30) DEFAULT 'ONLINE',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE shops (
        id UUID PRIMARY KEY,
        partner_id UUID REFERENCES partners(id),
        name VARCHAR(150),
        shop_name VARCHAR(150),
        shop_address TEXT,
        address_line1 TEXT,
        city VARCHAR(100),
        is_active BOOLEAN DEFAULT true,
        latitude NUMERIC,
        longitude NUMERIC
      );

      CREATE TABLE vehicle_categories (
        id UUID PRIMARY KEY,
        code VARCHAR(50) UNIQUE,
        name VARCHAR(100),
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE vehicles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id UUID REFERENCES partners(id),
        shop_id UUID REFERENCES shops(id),
        category VARCHAR(50),
        brand VARCHAR(100),
        model VARCHAR(100),
        variant VARCHAR(100),
        registration_number VARCHAR(50) UNIQUE,
        year INT,
        fuel_type VARCHAR(50),
        transmission VARCHAR(50),
        seats INT,
        pickup_location TEXT,
        description TEXT,
        manual_status VARCHAR(30) DEFAULT 'ONLINE',
        rental_status VARCHAR(30) DEFAULT 'AVAILABLE',
        verification_status VARCHAR(30) DEFAULT 'PENDING',
        rejection_reason TEXT,
        offline_reason TEXT,
        is_archived BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        vehicle_reference TEXT,
        primary_image_url TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE vehicle_pricing (
        id UUID DEFAULT gen_random_uuid(),
        vehicle_id UUID PRIMARY KEY REFERENCES vehicles(id),
        pricing_type TEXT DEFAULT 'daily',
        price NUMERIC,
        price_per_hour NUMERIC,
        price_3_hours NUMERIC,
        price_6_hours NUMERIC,
        price_12_hours NUMERIC,
        price_per_4_hours NUMERIC,
        price_per_day NUMERIC,
        price_per_week NUMERIC,
        price_per_month NUMERIC,
        km_limit_per_day NUMERIC(10,2) DEFAULT NULL,
        km_limit_per_hour NUMERIC(10,2) DEFAULT NULL,
        km_limit_3_hours NUMERIC(10,2) DEFAULT NULL,
        km_limit_6_hours NUMERIC(10,2) DEFAULT NULL,
        km_limit_12_hours NUMERIC(10,2) DEFAULT NULL,
        security_deposit NUMERIC,
        extra_km_charge NUMERIC,
        free_km_per_hour INT DEFAULT 10,
        is_active BOOLEAN DEFAULT true,
        currency TEXT DEFAULT 'INR',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE vehicle_pricing_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID REFERENCES vehicles(id),
        price_per_hour NUMERIC,
        price_3_hours NUMERIC,
        price_6_hours NUMERIC,
        price_12_hours NUMERIC,
        price_per_4_hours NUMERIC,
        price_per_day NUMERIC,
        price_per_week NUMERIC,
        price_per_month NUMERIC,
        km_limit_per_day NUMERIC(10,2) DEFAULT NULL,
        km_limit_per_hour NUMERIC(10,2) DEFAULT NULL,
        km_limit_3_hours NUMERIC(10,2) DEFAULT NULL,
        km_limit_6_hours NUMERIC(10,2) DEFAULT NULL,
        km_limit_12_hours NUMERIC(10,2) DEFAULT NULL,
        security_deposit NUMERIC,
        extra_km_charge NUMERIC,
        valid_from TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        valid_to TIMESTAMPTZ,
        effective_from TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        effective_until TIMESTAMPTZ,
        effective_to TIMESTAMPTZ,
        changed_by UUID REFERENCES users(id),
        change_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE partner_consents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id UUID REFERENCES partners(id),
        user_id UUID,
        document_type TEXT,
        document_version TEXT,
        content_hash TEXT,
        ip_address TEXT,
        user_agent TEXT,
        vehicle_id UUID,
        metadata JSONB,
        accepted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID REFERENCES vehicles(id),
        customer_id UUID,
        status TEXT DEFAULT 'confirmed',
        booking_status TEXT DEFAULT 'CONFIRMED',
        start_at TIMESTAMPTZ,
        end_at TIMESTAMPTZ,
        total_amount NUMERIC DEFAULT 1500,
        subtotal NUMERIC DEFAULT 1500,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE earnings (
        booking_id UUID,
        partner_net_amount NUMERIC
      );

      CREATE TABLE booking_pricing_snapshots (
        booking_id UUID,
        total_customer_amount NUMERIC
      );

      CREATE TABLE ratings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id UUID,
        vehicle_id UUID,
        target_type TEXT,
        status TEXT,
        rating_score NUMERIC
      );

      CREATE TABLE vehicle_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID REFERENCES vehicles(id),
        document_type TEXT,
        document_name TEXT,
        document_number TEXT,
        valid_till TIMESTAMPTZ,
        storage_key TEXT,
        file_url TEXT,
        is_required BOOLEAN DEFAULT false,
        version INT DEFAULT 1,
        is_active BOOLEAN DEFAULT true,
        verification_status TEXT DEFAULT 'PENDING',
        rejection_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE vehicle_images (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID REFERENCES vehicles(id),
        storage_key TEXT,
        image_url TEXT,
        file_url TEXT,
        sort_order INT DEFAULT 0,
        is_cover BOOLEAN DEFAULT false,
        is_primary BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        verification_status TEXT DEFAULT 'PENDING',
        rejection_reason TEXT,
        version INT DEFAULT 1,
        parent_image_id UUID,
        verified_at TIMESTAMPTZ,
        rejected_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO users (id, phone, role) VALUES ('${USER_ID}', '+919999988888', 'PARTNER');
      INSERT INTO partners (id, user_id, shop_id, partner_id_display, referral_code, business_name, business_address, city)
      VALUES ('${PARTNER_ID}', '${USER_ID}', '${SHOP_ID}', 'PART-001', 'CODE-001', 'Test Fleet', 'Bhopal Central', 'Bhopal');
      INSERT INTO shops (id, partner_id, name, shop_name, shop_address, city)
      VALUES ('${SHOP_ID}', '${PARTNER_ID}', 'Hub Bhopal', 'Hub Bhopal', 'Shop Address', 'Bhopal');
      INSERT INTO vehicle_categories (id, code, name) VALUES ('44444444-4444-4444-a444-444444444444', 'CAR', 'Car');
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();

    partnerPool.pool.connect = mockPool.connect.bind(mockPool);
    partnerPool.pool.query = mockPool.query.bind(mockPool);
    partnerPool.query = mockPool.query.bind(mockPool);
    partnerPool.connect = mockPool.connect.bind(mockPool);
    partnerPool.transaction = async (cb) => {
      const txClient = await mockPool.connect();
      try {
        await txClient.query('BEGIN');
        const res = await cb(txClient);
        await txClient.query('COMMIT');
        return res;
      } catch (err) {
        await txClient.query('ROLLBACK');
        throw err;
      } finally {
        txClient.release();
      }
    };

    jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockImplementation(async (id, partnerId) => {
      const rows = db.public.many(`
        SELECT
          v.id, v.vehicle_reference, v.partner_id, v.shop_id, v.category, v.brand, v.model, v.variant,
          v.registration_number, v.year, v.fuel_type, v.transmission, v.seats,
          v.description, v.pickup_location, v.manual_status, v.rental_status,
          v.verification_status, v.rejection_reason, v.is_archived, v.offline_reason, v.primary_image_url,
          v.is_active, v.created_at, v.updated_at,
          vp.price_per_hour, vp.price_3_hours, vp.price_6_hours, vp.price_12_hours, vp.price_per_4_hours, vp.price_per_day,
          vp.km_limit_per_day, vp.km_limit_per_hour, vp.km_limit_3_hours, vp.km_limit_6_hours, vp.km_limit_12_hours,
          vp.security_deposit, vp.extra_km_charge, vp.currency, vp.is_active AS pricing_active,
          0 AS total_earnings, 0 AS total_bookings, 0 AS rating_avg, 0 AS rating_count
        FROM vehicles v
        LEFT JOIN vehicle_pricing vp ON vp.vehicle_id = v.id
        WHERE v.id = '${id}' AND v.partner_id = '${partnerId}'
      `);
      return rows[0] || null;
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (mockPool) await mockPool.end();
  });

  it('correctly persists all 5 duration prices and 5 KM limits, security deposit, and extra KM charge', async () => {
    // Specific test values requested by the prompt
    const vehicleInput = {
      category: 'Car',
      brand: 'Mahindra',
      model: 'Thar',
      registrationNumber: 'MP04ZA2026',
      year: 2024,
      fuelType: 'Diesel',
      transmission: 'Automatic',
      seats: 5,
      // 5 Prices
      pricePerDay: 2000,
      pricePerHour: 150,
      price3Hours: 400,
      price6Hours: 750,
      price12Hours: 1300,
      // 5 KM limits
      kmLimitPerDay: 200,
      kmLimitPerHour: 20,
      kmLimit3Hours: 50,
      kmLimit6Hours: 80,
      kmLimit12Hours: 120,
      // Deposit and Extra KM
      securityDeposit: 3000,
      extraKmCharge: 12,
      leaseAgreementAccepted: true,
    };

    // 1. Create Vehicle
    const created = await vehicleService.createVehicle({
      partnerId: PARTNER_ID,
      input: vehicleInput,
      ipAddress: '127.0.0.1',
      userAgent: 'JestTestRunner',
    });

    expect(created).toBeDefined();
    expect(created.id).toBeDefined();

    // Verify created return object includes all pricing and KM limit fields
    expect(created.pricing).toBeDefined();
    expect(Number(created.pricing.pricePerDay)).toBe(2000);
    expect(Number(created.pricing.kmLimitPerDay)).toBe(200);
    expect(Number(created.pricing.pricePerHour)).toBe(150);
    expect(Number(created.pricing.kmLimitPerHour)).toBe(20);
    expect(Number(created.pricing.price3Hours)).toBe(400);
    expect(Number(created.pricing.kmLimit3Hours)).toBe(50);
    expect(Number(created.pricing.price6Hours)).toBe(750);
    expect(Number(created.pricing.kmLimit6Hours)).toBe(80);
    expect(Number(created.pricing.price12Hours)).toBe(1300);
    expect(Number(created.pricing.kmLimit12Hours)).toBe(120);
    expect(Number(created.pricing.securityDeposit)).toBe(3000);
    expect(Number(created.pricing.extraKmCharge)).toBe(12);

    // 2. Direct Database Persistence Check in vehicle_pricing
    const pricingRow = db.public.one(`SELECT * FROM vehicle_pricing WHERE vehicle_id = '${created.id}'`);
    expect(pricingRow).toBeDefined();
    expect(Number(pricingRow.price_per_day)).toBe(2000);
    expect(Number(pricingRow.km_limit_per_day)).toBe(200);
    expect(Number(pricingRow.price_per_hour)).toBe(150);
    expect(Number(pricingRow.km_limit_per_hour)).toBe(20);
    expect(Number(pricingRow.price_3_hours)).toBe(400);
    expect(Number(pricingRow.km_limit_3_hours)).toBe(50);
    expect(Number(pricingRow.price_6_hours)).toBe(750);
    expect(Number(pricingRow.km_limit_6_hours)).toBe(80);
    expect(Number(pricingRow.price_12_hours)).toBe(1300);
    expect(Number(pricingRow.km_limit_12_hours)).toBe(120);
    expect(Number(pricingRow.security_deposit)).toBe(3000);
    expect(Number(pricingRow.extra_km_charge)).toBe(12);

    // 3. Direct Database Audit/History Check in vehicle_pricing_history
    const historyRows = db.public.many(`SELECT * FROM vehicle_pricing_history WHERE vehicle_id = '${created.id}'`);
    expect(historyRows.length).toBeGreaterThanOrEqual(1);
    const initialHistory = historyRows[0];
    expect(Number(initialHistory.price_per_day)).toBe(2000);
    expect(Number(initialHistory.km_limit_per_day)).toBe(200);
    expect(Number(initialHistory.price_per_hour)).toBe(150);
    expect(Number(initialHistory.km_limit_per_hour)).toBe(20);
    expect(Number(initialHistory.price_3_hours)).toBe(400);
    expect(Number(initialHistory.km_limit_3_hours)).toBe(50);
    expect(Number(initialHistory.price_6_hours)).toBe(750);
    expect(Number(initialHistory.km_limit_6_hours)).toBe(80);
    expect(Number(initialHistory.price_12_hours)).toBe(1300);
    expect(Number(initialHistory.km_limit_12_hours)).toBe(120);

    // 4. Vehicle Details API Service Check
    const fetched = await vehicleService.getVehicleById({
      partnerId: PARTNER_ID,
      vehicleId: created.id,
    });
    expect(fetched).toBeDefined();
    expect(Number(fetched.pricing.pricePerDay)).toBe(2000);
    expect(Number(fetched.pricing.kmLimitPerDay)).toBe(200);
    expect(Number(fetched.pricing.pricePerHour)).toBe(150);
    expect(Number(fetched.pricing.kmLimitPerHour)).toBe(20);
    expect(Number(fetched.pricing.price3Hours)).toBe(400);
    expect(Number(fetched.pricing.kmLimit3Hours)).toBe(50);
    expect(Number(fetched.pricing.price6Hours)).toBe(750);
    expect(Number(fetched.pricing.kmLimit6Hours)).toBe(80);
    expect(Number(fetched.pricing.price12Hours)).toBe(1300);
    expect(Number(fetched.pricing.kmLimit12Hours)).toBe(120);
    expect(Number(fetched.pricing.securityDeposit)).toBe(3000);
    expect(Number(fetched.pricing.extraKmCharge)).toBe(12);

    // 5. Edit vehicle non-pricing fields (e.g. description) does NOT erase KM limits
    const updatedVehicle = await vehicleService.updateVehicle({
      partnerId: PARTNER_ID,
      vehicleId: created.id,
      input: {
        description: 'Updated test vehicle description',
      },
    });
    expect(updatedVehicle).toBeDefined();

    // Re-verify pricing remains completely intact
    const pricingAfterDetailsEdit = db.public.one(`SELECT * FROM vehicle_pricing WHERE vehicle_id = '${created.id}'`);
    expect(Number(pricingAfterDetailsEdit.price_per_day)).toBe(2000);
    expect(Number(pricingAfterDetailsEdit.km_limit_per_day)).toBe(200);
    expect(Number(pricingAfterDetailsEdit.price_per_hour)).toBe(150);
    expect(Number(pricingAfterDetailsEdit.km_limit_per_hour)).toBe(20);
    expect(Number(pricingAfterDetailsEdit.km_limit_3_hours)).toBe(50);
    expect(Number(pricingAfterDetailsEdit.km_limit_6_hours)).toBe(80);
    expect(Number(pricingAfterDetailsEdit.km_limit_12_hours)).toBe(120);

    // 6. Update vehicle pricing with new values
    const updatedPricing = await pricingService.updateVehiclePricing({
      partnerId: PARTNER_ID,
      vehicleId: created.id,
      changedBy: USER_ID,
      pricingData: {
        pricePerDay: 2200,
        kmLimitPerDay: 250,
        pricePerHour: 180,
        kmLimitPerHour: 25,
        price3Hours: 450,
        kmLimit3Hours: 60,
        price6Hours: 850,
        kmLimit6Hours: 100,
        price12Hours: 1450,
        kmLimit12Hours: 150,
        securityDeposit: 3500,
        extraKmCharge: 15,
        changeReason: 'Seasonal rate update',
      },
    });

    expect(Number(updatedPricing.pricePerDay)).toBe(2200);
    expect(Number(updatedPricing.kmLimitPerDay)).toBe(250);
    expect(Number(updatedPricing.kmLimitPerHour)).toBe(25);
    expect(Number(updatedPricing.kmLimit3Hours)).toBe(60);
    expect(Number(updatedPricing.kmLimit6Hours)).toBe(100);
    expect(Number(updatedPricing.kmLimit12Hours)).toBe(150);

    // Re-verify pricing history recorded the update
    const historyAfterUpdate = db.public.many(
      `SELECT * FROM vehicle_pricing_history WHERE vehicle_id = '${created.id}' ORDER BY created_at DESC`,
    );
    expect(historyAfterUpdate.length).toBe(2);
    const activeHistory = historyAfterUpdate.find((h) => !h.valid_to);
    expect(activeHistory).toBeDefined();
    expect(Number(activeHistory.price_per_day)).toBe(2200);
    expect(Number(activeHistory.km_limit_per_day)).toBe(250);
  });
});
